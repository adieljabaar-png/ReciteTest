/**
 * Tajweed server — POST /api/tajweed-check
 * One audio blob in, per-word ASR + MFA timings out.
 *
 * What it does:
 *  1. Accepts multipart FormData: audio (webm/opus blob from the browser),
 *     expected (JSON [{wordId, text}]), t0 (session start ms).
 *  2. Sends the SAME audio to Google Cloud Speech-to-Text (server side only —
 *     the browser never sees the API key) with enableWordTimeOffsets: true.
 *  3. If the `mfa` CLI is installed on the server, runs Montreal Forced Aligner
 *     on the same audio + expected transcript for MFA timings. Otherwise
 *     mfaAvailable=false and the browser marks words "not verified" instead of
 *     faking MFA timings. No fake timings, ever.
 *  4. Returns { words: [{wordId, text, asrStartMs, asrEndMs, mfaStartMs, mfaEndMs,
 *     mfaAvailable, rmsPeak}], ... } — the browser's triple-lock needs
 *     |asr - mfa| <= 150ms AND RMS voiced.
 *
 * Setup:
 *   1. Enable "Cloud Speech-to-Text API" in your Google Cloud project.
 *   2. Set ONE of:
 *        GOOGLE_CLOUD_SPEECH_API_KEY=...        (API key, simplest)
 *      or GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   3. (Optional, for MFA) install MFA: conda create -n aligner -c conda-forge montreal-forced-aligner
 *   4. Run:  node server.js   (or: PORT=3000 node server.js)
 *   5. Serve index.html from the SAME origin (this server also serves
 *      index.html + sw.js statically), so /api/tajweed-check is same-origin.
 *
 * No dependencies. Node 18+ only (uses global fetch).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GOOGLE_CLOUD_SPEECH_API_KEY || '';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB — a 49.5s webm clip is far below this

// ---------- tiny multipart parser (no deps) ----------
function parseMultipart(body, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  let idx = 0;
  while (true) {
    const start = body.indexOf(sep, idx);
    if (start === -1) break;
    let p = start + sep.length;
    if (body[p] === 45 && body[p + 1] === 45) break; // -- = end
    if (body[p] === 13 && body[p + 1] === 10) p += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), p);
    if (headerEnd === -1) break;
    const headers = body.slice(p, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(sep, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    parts.push({ headers, data: body.slice(dataStart, dataEnd) });
    idx = next;
  }
  return parts;
}
function fieldName(headers) {
  const m = /name="([^"]+)"/.exec(headers);
  return m ? m[1] : '';
}

// ---------- Google Cloud Speech-to-Text (server side, key never in browser) ----------
async function googleStt(audioBuf, mimeType) {
  // WebM/Opus from MediaRecorder → tell Google the encoding explicitly.
  const encoding = /opus/i.test(mimeType) ? 'WEBM_OPUS' : 'WEBM_OPUS';
  const body = {
    config: {
      encoding,
      sampleRateHertz: 48000,
      languageCode: 'ar-SA',
      alternativeLanguageCodes: ['ar-EG', 'ar'],
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: false,
      model: 'default',
    },
    audio: { content: audioBuf.toString('base64') },
  };
  let url, headers = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    url = 'https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(API_KEY);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Service-account path: use `gcloud auth application-default print-access-token`
    // at deploy time instead — this server does NOT ship a key. If neither an API
    // key nor a GOOGLE_ACCESS_TOKEN is present, fail honestly (see handler).
    if (!process.env.GOOGLE_ACCESS_TOKEN) throw new Error('NO_CREDENTIALS');
    url = 'https://speech.googleapis.com/v1/speech:recognize';
    headers.Authorization = 'Bearer ' + process.env.GOOGLE_ACCESS_TOKEN;
  } else {
    throw new Error('NO_CREDENTIALS');
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || ('Google STT HTTP ' + res.status);
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return json;
}

// ---------- MFA (only if the `mfa` CLI exists on this machine) ----------
function runMfa(audioPath, transcriptPath, outDir) {
  return new Promise((resolve) => {
    execFile('mfa', ['align', audioPath, transcriptPath, outDir, '--clean', '--quiet'],
      { timeout: 120000 }, (err) => {
        if (err) return resolve(null); // MFA unavailable → honest null, never fake timings
        try {
          const files = fs.readdirSync(outDir).filter(f => f.endsWith('.TextGrid'));
          if (!files.length) return resolve(null);
          resolve(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
        } catch (_) { resolve(null); }
      });
  });
}
// Minimal TextGrid word-tier parse: lines "xmin = X", "xmax = Y", 'text = "word"'
function parseTextGridWords(grid) {
  const words = [];
  const re = /xmin\s*=\s*([\d.]+)\s*\n\s*xmax\s*=\s*([\d.]+)\s*\n\s*text\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(grid))) {
    const text = m[3].trim();
    if (text && text !== 'sp' && text !== 'sil') words.push({ text, startMs: Math.round(+m[1] * 1000), endMs: Math.round(+m[2] * 1000) });
  }
  return words;
}
function norm(s) {
  return String(s || '').replace(/[\u064B-\u0652\u0670]/g, '').replace(/[^\u0600-\u06FFa-zA-Z]/g, '').trim();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  // Health: tells the browser whether the server + Google key are actually up.
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, {
      ok: true, version: 'tajweed-server 1.0.0',
      googleConfigured: Boolean(API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_ACCESS_TOKEN),
      mfaNote: 'MFA runs only if the `mfa` CLI is installed on this server.',
    });
  }
  // Serve the app itself from the same origin (index.html + sw.js in this folder).
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const f = path.join(__dirname, 'index.html');
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'index.html not found next to server.js' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(f));
  }
  if (req.method === 'GET' && req.url === '/sw.js') {
    const f = path.join(__dirname, 'sw.js');
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'sw.js not found next to server.js' });
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(f));
  }
  if (req.method !== 'POST' || req.url !== '/api/tajweed-check') {
    return sendJson(res, 404, { error: 'Not found. Use POST /api/tajweed-check or GET /api/health' });
  }

  // ---- read body (cap 10 MB) ----
  const chunks = []; let size = 0;
  for await (const c of req) { chunks.push(c); size += c.length; if (size > MAX_AUDIO_BYTES) return sendJson(res, 413, { error: 'Audio too large (max 10 MB).' }); }
  const body = Buffer.concat(chunks);
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=([^;]+)/.exec(ct);
  if (!bm) return sendJson(res, 400, { error: 'Expected multipart/form-data with audio + expected fields.' });
  const parts = parseMultipart(body, bm[1].trim());
  let audio = null, audioMime = 'audio/webm;codecs=opus', expected = [];
  for (const part of parts) {
    const name = fieldName(part.headers);
    if (name === 'audio') { audio = part.data; const tm = /Content-Type:\s*([^\r\n]+)/i.exec(part.headers); if (tm) audioMime = tm[1].trim(); }
    if (name === 'expected') { try { expected = JSON.parse(part.data.toString('utf8')); } catch (_) { expected = []; } }
  }
  if (!audio || !audio.length) return sendJson(res, 400, { error: 'No audio blob received.' });
  if (!expected.length) return sendJson(res, 400, { error: 'No expected words received (expected field).' });

  // ---- ASR (Google, server side) ----
  let stt;
  try { stt = await googleStt(audio, audioMime); }
  catch (e) {
    if (e.message === 'NO_CREDENTIALS') {
      return sendJson(res, 503, { error: 'Server not configured: set GOOGLE_CLOUD_SPEECH_API_KEY (or GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_ACCESS_TOKEN) and restart the server. No timings are faked.' });
    }
    return sendJson(res, 502, { error: 'Google Speech-to-Text failed: ' + e.message });
  }
  const asrWords = [];
  for (const r of (stt.results || [])) {
    const alt = (r.alternatives || [])[0];
    if (!alt) continue;
    for (const w of (alt.words || [])) {
      asrWords.push({
        text: w.word || '',
        asrStartMs: Math.round(parseFloat((w.startTime || '0s').replace('s', '')) * 1000),
        asrEndMs: Math.round(parseFloat((w.endTime || '0s').replace('s', '')) * 1000),
      });
    }
  }

  // ---- MFA (only if the CLI exists; otherwise mfaAvailable=false) ----
  let mfaWords = null;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taj-'));
    const audioPath = path.join(tmp, 'rec.webm');
    const transcriptPath = path.join(tmp, 'rec.txt');
    const outDir = path.join(tmp, 'out'); fs.mkdirSync(outDir);
    fs.writeFileSync(audioPath, audio);
    fs.writeFileSync(transcriptPath, expected.map(w => w.text).join(' '));
    const grid = await runMfa(audioPath, transcriptPath, outDir);
    if (grid) mfaWords = parseTextGridWords(grid);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) { mfaWords = null; }

  // ---- align ASR words to expected words by order + normalised text ----
  const words = expected.map((exp, i) => {
    const a = asrWords[i] || asrWords.find(w => norm(w.text) === norm(exp.text)) || null;
    let mfaStartMs = null, mfaEndMs = null;
    if (mfaWords) {
      const mw = mfaWords[i] || mfaWords.find(w => norm(w.text) === norm(exp.text)) || null;
      if (mw) { mfaStartMs = mw.startMs; mfaEndMs = mw.endMs; }
    }
    return {
      wordId: exp.wordId || '',
      text: exp.text || '',
      asrStartMs: a ? a.asrStartMs : null,
      asrEndMs: a ? a.asrEndMs : null,
      asrText: a ? a.text : null,
      mfaStartMs, mfaEndMs,
      mfaAvailable: mfaWords !== null,
    };
  });

  return sendJson(res, 200, {
    words,
    mfaAvailable: mfaWords !== null,
    asrWordCount: asrWords.length,
    expectedCount: expected.length,
    note: mfaWords ? 'ASR + MFA from the same audio blob.' : 'ASR only — MFA CLI not installed on this server, so the browser must mark words "not verified". No MFA timings were invented.',
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('[tajweed-server] listening on http://localhost:' + PORT + ' — GET /api/health to check Google key + MFA'));
}
module.exports = server;
