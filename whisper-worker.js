// whisper-worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm';

env.allowLocalModels = false;
env.allowRemoteModels = true;

// WASM tuning: prevents multi-thread wasm from saturating slow CPUs
const cores = (self.navigator && navigator.hardwareConcurrency) || 2;
env.backends.onnx.wasm.numThreads = cores >= 4 ? 2 : 1;
env.backends.onnx.wasm.simd = true;  // supported on almost all modern mobile browsers

let transcriber = null;
let activeModelName = null;

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (_) {}
  return 'wasm';
}

async function loadModel() {
  if (transcriber) return;

  const device = await pickDevice();
  const primary = 'onnx-community/moonshine-tiny-ar-ONNX';
  const fallback = 'onnx-community/tarteel-ai-whisper-tiny-ar-quran-ONNX';

  const build = async (name) => {
    // Send a status message so the UI knows we are compiling the model
    self.postMessage({ type: 'status', status: 'initializing', model: name });
    
    return pipeline(
      'automatic-speech-recognition',
      name,
      {
        dtype: device === 'webgpu' ? 'q4' : 'q8',  // q8 is smaller & fine on WASM
        device,
        progress_callback: (p) => {
          try {
            self.postMessage({ type: 'progress', data: p });
          } catch (e) {
            // Ignore callback errors
          }
        }
      }
    );
  };

  try {
    transcriber = await build(primary);
    activeModelName = primary;
  } catch (e) {
    console.warn('[Worker] Moonshine failed, falling back to Tarteel Whisper:', e);
    // If primary fails, try the fallback
    transcriber = await build(fallback);
    activeModelName = fallback;
  }

  self.postMessage({ type: 'ready', model: activeModelName });
}

self.addEventListener('message', async (e) => {
  const { action, audioData, id } = e.data;

  if (action === 'load') {
    try { 
      await loadModel(); 
    }
    catch (err) { 
      self.postMessage({ type: 'error', error: err.message, id }); 
    }
    return;
  }

  if (action === 'transcribe') {
    if (!transcriber) {
      try { 
        await loadModel(); 
      }
      catch (err) { 
        self.postMessage({ type: 'error', error: err.message, id }); 
        return; 
      }
    }
    try {
      const t0 = performance.now();
      const result = await transcriber(audioData, { language: 'arabic' });
      self.postMessage({
        type: 'result',
        text: result.text || '',
        id,
        ms: Math.round(performance.now() - t0),
        model: activeModelName
      });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message, id });
    }
  }
});