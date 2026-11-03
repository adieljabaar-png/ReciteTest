// whisper-worker.js
// ─────────────────────────────────────────────────────────────
// Model loader + transcriber for the Quran Recitation Coach.
//
// Protocol (all messages via self.postMessage):
//   IN  { action: 'load',      prefer?: string, fallback?: string }
//   IN  { action: 'transcribe', audioData: Float32Array@16kHz, id: number, prefer?: string }
//
//   OUT { type: 'model-info', model: 'whisper'|'whisper-tiny', repo: string, sizeBytes: number }
//   OUT { type: 'progress',   data: <transformers.js per-file progress> }
//   OUT { type: 'ready',      model, repo }
//   OUT { type: 'error',      error: string, id?: number }
//   OUT { type: 'result',     text, id, ms, model }
// ─────────────────────────────────────────────────────────────

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm';

env.allowLocalModels  = false;
env.allowRemoteModels = true;

// WASM tuning — Force single-thread on mobile for maximum stability
const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
env.backends.onnx.wasm.numThreads = 1; 
env.backends.onnx.wasm.simd       = true;

// ── Known models ───────────────────────────────────────────────
const MODEL_REPOS = {
  // The new, more accurate Quran-tuned base model
  whisper: 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran',
  // Kept as fallback if needed, though we recommend the base model
  'whisper-tiny': 'onnx-community/tarteel-ai-whisper-tiny-ar-quran-ONNX'
};

// Approximate download totals (bytes)
const MODEL_SIZE_HINTS = {
  whisper: 150 * 1024 * 1024, // ~150 MB for the base model
  'whisper-tiny': 50 * 1024 * 1024 
};

let transcriber      = null;
let loadingPromise   = null;
let activeModelKey   = null;
let activeModelRepo  = null;

// ── Helpers ────────────────────────────────────────────────────

function resolveModelName(name) {
  if (!name) return { key: 'whisper', repo: MODEL_REPOS.whisper };
  const n = String(name).toLowerCase().trim();
  if (MODEL_REPOS[n]) return { key: n, repo: MODEL_REPOS[n] };
  if (n.includes('whisper')) {
    // Default to the base model unless 'tiny' is explicitly requested
    if (n.includes('tiny')) return { key: 'whisper-tiny', repo: MODEL_REPOS['whisper-tiny'] };
    return { key: 'whisper', repo: MODEL_REPOS.whisper };
  }
  return { key: 'whisper', repo: MODEL_REPOS.whisper };
}

async function pickDevice() {
  // Forced to WASM for mobile compatibility. WebGPU often fails silently on mobile.
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
      self.postMessage({ type: 'result', text: '', id, ms: 0, model: activeModelKey });
      return;
    }

    try {
      const t0 = performance.now();
      // Using 'ar' language and 'transcribe' task
      const result = await transcriber(audioData, { language: 'ar', task: 'transcribe' });
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