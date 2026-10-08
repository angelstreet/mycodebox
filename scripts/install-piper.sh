#!/usr/bin/env bash
# Install piper TTS + en_US-amy-low voice for ghosty-sessions (TASK-70 Part 1).
#
# NOT auto-run by any deploy. The owner runs this once on the codebox after merging
# Part 1 to main. No system-package change: everything lives under ~/.local/share/piper/.
#
# Voice choice: en_US-amy-low (Q93=2 — the piper default; smaller/faster, lower naturalness
# for short briefs).

set -euo pipefail

DEST="${HOME}/.local/share/piper"
VOICE_DIR="${DEST}/voices"
VOICE_ONNX="${VOICE_DIR}/en_US-amy-low.onnx"
VOICE_JSON="${VOICE_DIR}/en_US-amy-low.onnx.json"

# piper-tts release: 2023.11.14-onnx is the last onnxruntime build. Pin exactly so the install
# is reproducible. Override with PIPER_RELEASE=<tag> if you need to move forward.
PIPER_RELEASE="${PIPER_RELEASE:-2023.11.14-onnx}"
PIPER_TARBALL="piper_${PIPER_RELEASE}.tar.gz"

mkdir -p "${VOICE_DIR}"

# 1. piper binary
if [[ ! -x "${DEST}/piper" ]]; then
  echo ">>> downloading piper ${PIPER_RELEASE}"
  TMP="$(mktemp -d)"
  cd "${TMP}"
  # GitHub release URL: https://github.com/rhasspy/piper/releases
  URL="https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${PIPER_TARBALL}"
  if command -v curl >/dev/null 2>&1; then
    curl -fL "${URL}" -o "${PIPER_TARBALL}"
  else
    wget -q "${URL}" -O "${PIPER_TARBALL}"
  fi
  tar -xzf "${PIPER_TARBALL}"
  # The tarball layout varies by platform; pick the piper executable we find.
  P="$(find . -type f -name piper -executable | head -n1)"
  if [[ -z "${P}" ]]; then
    echo "could not locate piper executable in tarball" >&2
    exit 1
  fi
  install -m 0755 "${P}" "${DEST}/piper"
  cd /
  rm -rf "${TMP}"
else
  echo ">>> piper already installed at ${DEST}/piper"
fi

# 2. en_US-amy-low voice
if [[ ! -f "${VOICE_ONNX}" ]]; then
  echo ">>> downloading en_US-amy-low voice"
  TMP="$(mktemp -d)"
  cd "${TMP}"
  # Hugging Face: rhasspy/piper-voices — repo structure is locale/quality/voice.onnx + .json
  VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low"
  if command -v curl >/dev/null 2>&1; then
    curl -fL "${VOICE_BASE}/en_US-amy-low.onnx" -o "${VOICE_ONNX}.tmp"
    curl -fL "${VOICE_BASE}/en_US-amy-low.onnx.json" -o "${VOICE_JSON}.tmp"
  else
    wget -q "${VOICE_BASE}/en_US-amy-low.onnx" -O "${VOICE_ONNX}.tmp"
    wget -q "${VOICE_BASE}/en_US-amy-low.onnx.json" -O "${VOICE_JSON}.tmp"
  fi
  mv "${VOICE_ONNX}.tmp" "${VOICE_ONNX}"
  mv "${VOICE_JSON}.tmp" "${VOICE_JSON}"
  cd /
  rm -rf "${TMP}"
else
  echo ">>> voice already installed at ${VOICE_ONNX}"
fi

# 3. smoke
"${DEST}/piper" --model "${VOICE_ONNX}" --output_file /tmp/_piper_smoke.wav <<<'piper is ready.'
rm -f /tmp/_piper_smoke.wav

echo ">>> done. PATH: ${DEST}/piper   VOICE: ${VOICE_ONNX}"
echo "    ghosty-sessions reads PIPER_BIN / PIPER_VOICE env vars, or defaults to those paths."