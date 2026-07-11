#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT=$("$SCRIPT_DIR/create-approval-home.sh")
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT HUP INT TERM
export CODEX_HOME="$ROOT"
cd "$ROOT/work"
"/Applications/ChatGPT.app/Contents/Resources/codex"
