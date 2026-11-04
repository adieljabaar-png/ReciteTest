// whisper-worker.js
// ─────────────────────────────────────────────────────────────
// Model loader + transcriber for the Quran Recitation Coach.
// ─────────────────────────────────────────────────────────────

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm';

env.allowLocalModels  = false;
env.allowRemoteModels = true;
// MUST be true to save the model permanently
env.useBrowserCache   = true; 

// WASM tuning — Force single-thread on mobile for maximum stability
const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
env.backends.onnx.wasm.numThreads = 1; 
env.backends.onnx.wasm.simd       = true;

// ── Known models ───────────────────────────────────────────────
// Switched to the official Xenova models for guaranteed complete file downloads
const MODEL_REPOS = {
  whisper: 'Xenova/whisper-tiny',
  'whisper-base': 'Xenova/whisper-base'
};

// Approximate download totals (bytes)
const MODEL_SIZE_HINTS = {
  whisper: 150 * 1024 * 1024, 
  'whisper-base': 200 * 1024 * 1024 
};

let transcriber = null;
let loadingPromise = null;
let activeModelKey = null;
let activeModelRepo = null;

// ── Helpers ────────────────────────────────────────────────────

function resolveModelName(name) {
  if (!name) return { key: 'whisper', repo: MODEL_REPOS.whisper };
  const n = String(name).toLowerCase().trim();
  if (MODEL_REPOS[n]) return { key: n, repo: MODEL_REPOS[n] };
  if (n.includes('whisper')) {
    if (n.includes('base')) return { key: 'whisper-base', repo: MODEL_REPOS['whisper-base'] };
    return { key: 'whisper', repo: MODEL_REPOS.whisper };
  }
  return { key: 'whisper', repo: MODEL_REPOS.whisper };
}

async function pickDevice() {
  return 'wasm';
}

function buildPipeline(repo, device) {
  return pipeline('automatic-speech-recognition', repo, {
    dtype: 'q8', 
    device,
    progress_callback: (p) => {
      try { self.postMessage({ type: 'progress', data: p }); } catch (_) {}
    }
  });
}

// ── Model loading (idempotent with retry logic) ────────────────

async function loadModel(prefer) {
  if (transcriber) {
    self.postMessage({ type: 'ready', model: activeModelKey, repo: activeModelRepo });
    return transcriber;
  }
  if (loadingPromise) {
    await loadingPromise;
    return transcriber;
  }

  const { key, repo } = resolveModelName(prefer);
  activeModelKey  = key;
  activeModelRepo = repo;

  self.postMessage({
    type: 'model-info',
    model: key,
    repo,
    sizeBytes: MODEL_SIZE_HINTS[key] || 0
  });

  loadingPromise = (async () => {
    const MAX_ATTEMPTS = 3;
    let attempt = 0;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      try {
        const device = await pickDevice();
        return await buildPipeline(repo, device);
      } catch (err) {
        console.warn(`[Worker] Attempt ${attempt} failed:`, err.message);
        if (attempt >= MAX_ATTEMPTS) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  })();

  try {
    transcriber = await loadingPromise;
    self.postMessage({ type: 'ready', model: activeModelKey, repo: activeModelRepo });
  } catch (err) {
    transcriber = null;
    throw err;
  } finally {
    loadingPromise = null;
  }

  return transcriber;
}

// ── Message handler ────────────────────────────────────────────

self.addEventListener('message', async (e) => {
  const data = e.data || {};
  const { action, audioData, id, prefer } = data;

  if (action === 'load') {
    try {
      await loadModel(prefer);
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err && err.message ? err.message : String(err)
      });
    }
    return;
  }

  if (action === 'transcribe') {
    try {
      if (!transcriber) await loadModel(prefer || activeModelKey);
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message, id });
      return;
    }

    if (!audioData || audioData.length < 4000) {
      console.log('[Whisper Worker] Audio too short, skipping. Length:', audioData ? audioData.length : 0);
      self.postMessage({ type: 'result', text: '', id, ms: 0, model: activeModelKey });
      return;
    }

    try {
      const t0 = performance.now();
      
      // DEBUG LOG: Are we receiving audio samples?
      console.log(`[Whisper Worker] Sending ${audioData.length} samples to AI...`);
      
      const result = await transcriber(audioData, { language: 'ar', task: 'transcribe' });
      
      // DEBUG LOG: What did the AI hear?
      console.log('[Whisper Worker] AI Output:', result);

      self.postMessage({
        type: 'result',
        text: (result && result.text) || '',
        id,
        ms: Math.round(performance.now() - t0),
        model: activeModelKey
      });
    } catch (err) {
      console.error('[Whisper Worker] Transcription error:', err);
      self.postMessage({ type: 'error', error: err.message, id });
    }
  }
});