#!/usr/bin/env bash
set -euo pipefail

echo "=================================================================="
echo "⚡ Vigil — Switch Console & Local Docker / Colima Readiness Helper"
echo "=================================================================="

ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  DMG_NAME="switch-console-arm64.dmg"
else
  DMG_NAME="switch-console-x64.dmg"
fi

if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "→ Docker daemon is stopped. Starting Colima container runtime..."
    colima start --cpu 4 --memory 6
  else
    echo "⚠ Docker daemon is not running. Please open Docker Desktop or run 'colima start' before starting Switch Console's local server."
  fi
else
  echo "✓ Docker daemon is running."
fi

if [[ -d "/Applications/Switch Console.app" ]]; then
  echo "✓ Switch Console.app is already installed in /Applications!"
else
  DEST="$HOME/Downloads/$DMG_NAME"
  URL="https://github.com/sandbox-quantum/switch/releases/latest/download/$DMG_NAME"
  echo "→ Downloading official Switch Console ($DMG_NAME) to $DEST ..."
  curl -fL "$URL" -o "$DEST"
  echo "✓ Downloaded $DEST — opening installer..."
  open "$DEST"
fi
