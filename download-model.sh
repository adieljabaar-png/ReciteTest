#!/usr/bin/env bash
set -euo pipefail

REPO_ID="onnx-community/tarteel-ai-whisper-tiny-ar-quran-ONNX"
DEST_DIR="./models/${REPO_ID}"

echo "▸ Installing huggingface_hub…"
python3 -m pip install --quiet --upgrade "huggingface_hub>=0.23"

echo "▸ Downloading ${REPO_ID}"
echo "  → ${DEST_DIR}"

python3 - "$REPO_ID" "$DEST_DIR" <<'PY'
import os, sys
from huggingface_hub import snapshot_download

repo_id  = sys.argv[1]
dest_dir = sys.argv[2]
os.makedirs(dest_dir, exist_ok=True)

snapshot_download(
    repo_id=repo_id,
    local_dir=dest_dir,
    allow_patterns=[
        "onnx/*",          # all ONNX model variants (q4, q8, fp16, fp32)
        "config.json",     # model config
        "generation_config.json",
        "preprocessor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "vocab.json",
        "merges.txt",
        "special_tokens_map.json",
    ],
)
print("✓ Download complete.")
PY

echo
echo "▸ Files written:"
ls -lh "${DEST_DIR}"
echo
echo "▸ Next step (required for the app to actually use these files):"
echo "   In index.html, change:"
echo "     env.allowLocalModels = false;   →   env.allowLocalModels = true;"
echo "     env.allowRemoteModels = true;   →   env.allowRemoteModels = true;  (keep as fallback)"
echo "   And optionally add:"
echo "     env.localModelPath = '/models/';"