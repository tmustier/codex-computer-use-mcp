#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$ROOT/build}"
rm -rf "$OUT"
mkdir -p "$OUT"
BIN="$OUT/CUAHarnessBinary"
/usr/bin/xcrun swiftc "$ROOT/main.swift" -o "$BIN" -framework Cocoa
for suffix in A B; do
  name="CUA Harness $suffix"
  bundle_id="dev.codexcomputeruse.cua-harness-$(printf '%s' "$suffix" | tr '[:upper:]' '[:lower:]')"
  app="$OUT/$name.app"
  mkdir -p "$app/Contents/MacOS"
  cp "$BIN" "$app/Contents/MacOS/CUAHarness"
  chmod 755 "$app/Contents/MacOS/CUAHarness"
  cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CUAHarness</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
  /usr/bin/codesign --force --sign - "$app" >/dev/null
  printf 'built=%s bundle=%s\n' "$app" "$bundle_id"
done
rm -f "$BIN"
