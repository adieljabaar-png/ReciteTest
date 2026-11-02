#!/bin/bash
pip install huggingface_hub

# This is the Vercel-safe 8.57MB version
huggingface_hub download omartariq612/tarteel-ai-whisper-tiny-ar-quran-onnx \
  --local-dir ./public/models/quran-tiny-onnx \
  --include "onnx/*" "*.json"
  
echo "Model downloaded to public/models/quran-tiny-onnx"