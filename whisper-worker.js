// whisper-worker.js
// ─────────────────────────────────────────────────────────────
// Model loader + transcriber for the Quran Recitation Coach.
//
// Protocol (all messages via self.postMessage):
//   IN  { action: 'load',      prefer?: string, fallback?: string }
//   IN  { action: 'transcribe', audioData: Float32Array@16kHz, id: number, prefer?: string }
//
//   OUT { type: 'model-info', model: 'moonshine'|'whisper', repo: string, sizeBytes: number }
//   OUT { type: 'progress',   data: <transformers.js per-file progress> }
//   OUT { type: 'ready',      model, repo }
//   OUT { type: 'error',      error: string, id?: number }
//   OUT { type: 'result',     text, id, ms, model }
//
// Moonshine is tried first by default. The *caller* (index.html) is
// responsible for the Whisper fallback: it terminates this worker and
// recreates it with `prefer: 'whisper'` when an error is received
// without an `id`.
// ─────────────────────────────────────────────────────────────

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm';

env.allowLocalModels  = false;
env.allowRemoteModels = true;

// WASM tuning — 1 thread on 2-core phones, 2 threads on 4+ cores.
const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
env.backends.onnx.wasm.numThreads = cores >= 4 ? 2 : 1;
env.backends.onnx.wasm.simd       = true;

// ── Known models ───────────────────────────────────────────────
const MODEL_REPOS = {
  moonshine: 'onnx-community/moonshine-tiny-ar-ONNX',
  whisper:   'onnx-community/tarteel-ai-whisper-tiny-ar-quran-ONNX'
};

// Approximate download totals (bytes) — used only to give the UI a
// stable denominator from the first progress event. The real total is
// computed by index.html from per-file `total` fields, so an
// over-estimate here just means the last visible % is below 100 before
// the banner hides on `ready`.
const MODEL_SIZE_HINTS = {
  moonshine: 40 * 1024 * 1024,   // ~40 MB q8
  whisper:   50 * 1024 * 1024    // ~50 MB q8
};

let transcriber      = null;
let loadingPromise   = null;
let activeModelKey   = null;
let activeModelRepo  = null;

// ── Helpers ────────────────────────────────────────────────────

function resolveModelName(name) {
  if (!name) return { key: 'moonshine', repo: MODEL_REPOS.moonshine };
  const n = String(name).toLowerCase().trim();
  if (MODEL_REPOS[n]) return { key: n, repo: MODEL_REPOS[n] };
  if (n.includes('moonshine'))                     return { key: 'moonshine', repo: name };
  if (n.includes('whisper') || n.includes('tarteel')) return { key: 'whisper',   repo: name };
  return { key: 'moonshine', repo: MODEL_REPOS.moonshine };
}

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (_) {}
  return 'wasm';
}

function buildPipeline(repo, device) {
  return pipeline('automatic-speech-recognition', repo, {
    dtype: device === 'webgpu' ? 'q4' : 'q8',
    device,
    progress_callback: (p) => {
      try { self.postMessage({ type: 'progress', data: p }); } catch (_) {}
    }
  });
}

// ── Model loading (idempotent) ─────────────────────────────────

async function loadModel(prefer) {
  if (transcriber) {
    self.postMessage({ type: 'ready', model: activeModelKey, repo: activeModelRepo });
    return transcriber;
  }
  if (loadingPromise) {
    // Another caller is already loading — wait for it.
    await loadingPromise;
    return transcriber;
  }

  const { key, repo } = resolveModelName(prefer);
  activeModelKey  = key;
  activeModelRepo = repo;

  // Announce the model + size hint so the UI can render the banner
  // immediately, before the first per-file progress event arrives.
  self.postMessage({
    type: 'model-info',
    model: key,
    repo,
    sizeBytes: MODEL_SIZE_HINTS[key] || 0
  });

  loadingPromise = (async () => {
    const device = await pickDevice();
    transcriber = await buildPipeline(repo, device);
  })();

  try {
    await loadingPromise;
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
      // Post an error WITHOUT an id so index.html's load-failure
      // path kicks in and retries with `prefer: 'whisper'`.
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

    // Ignore trivially short clips (< 250 ms @ 16 kHz). The main
    // thread already filters, but a second guard costs nothing.
    if (!audioData || audioData.length < 4000) {
      self.postMessage({
        type: 'result',
        text: '',
        id,
        ms: 0,
        model: activeModelKey
      });
      return;
    }

    try {
      const t0 = performance.now();
      const result = await transcriber(audioData, { language: 'arabic' });
      self.postMessage({
        type: 'result',
        text: (result && result.text) || '',
        id,
        ms: Math.round(performance.now() - t0),
        model: activeModelKey
      });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message, id });
    }
  }
});