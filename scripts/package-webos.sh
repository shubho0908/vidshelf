#!/usr/bin/env bash
# Assemble webOS app dir (built web app + appinfo + icons) and package .ipk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/webos"
rm -rf "$OUT" "$ROOT/build/"*.ipk 2>/dev/null || true
mkdir -p "$OUT"
cp -r "$ROOT/app/dist/." "$OUT/"
cp "$ROOT/webos/appinfo.json" "$ROOT/webos/icon.png" "$ROOT/webos/largeIcon.png" "$OUT/"
ares-package -o "$ROOT/build" "$OUT"
ls -la "$ROOT/build/"*.ipk
