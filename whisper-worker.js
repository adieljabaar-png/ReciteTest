// whisper-worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm';

env.allowLocalModels = false;
env.allowRemoteModels = true;

let transcriber = null;

async function loadModel() {
    if (transcriber) return;
    try {
        transcriber = await pipeline(
            'automatic-speech-recognition',
            'onnx-community/moonshine-tiny-ar-ONNX', // Swapped to Moonshine Arabic
            {
                dtype: 'q4',
                device: 'webgpu',
                progress_callback: (p) => {
                    self.postMessage({ type: 'progress', data: p });
                }
            }
        );
        self.postMessage({ type: 'ready' });
    } catch (e) {
        console.warn('[Worker] WebGPU failed, falling back to WASM', e);
        transcriber = await pipeline(
            'automatic-speech-recognition',
            'onnx-community/moonshine-tiny-ar-ONNX',
            {
                dtype: 'q4',
                progress_callback: (p) => {
                    self.postMessage({ type: 'progress', data: p });
                }
            }
        );
        self.postMessage({ type: 'ready' });
    }
}

self.addEventListener('message', async (e) => {
    const { action, audioData } = e.data;
    
    if (action === 'load') {
        await loadModel();
    } 
    else if (action === 'transcribe') {
        if (!transcriber) await loadModel();
        try {
            const result = await transcriber(audioData, {
                language: 'arabic'
                // Removed Whisper-specific task and chunk_length_s
            });
            self.postMessage({ type: 'result', text: result.text });
        } catch (err) {
            console.error('[Worker] Transcribe error:', err);
            self.postMessage({ type: 'error', error: err.message });
        }
    }
});