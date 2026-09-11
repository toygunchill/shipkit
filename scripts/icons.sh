#!/usr/bin/env bash
# Render the app icon from design/icon/app-icon.svg into an .iconset and .icns.
#
# The output is git-ignored: it is derived, and regenerating it takes one
# command. When the menu-bar app exists its asset catalog will carry committed
# PNGs, and that is the point to decide whether these belong in the repository.
#
# The menu-bar mark is deliberately not rendered here. It is drawn in SwiftUI —
# see apps/menubar/Sources/ShipkitMenuBar/ShipkitMark.swift — so it stays sharp
# at any bar height and takes the system tint without an asset.

set -euo pipefail

cd "$(dirname "$0")/.."
SRC="design/icon/app-icon.svg"
OUT="design/icon/generated"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SRC" ] || { echo "icons: $SRC is missing" >&2; exit 1; }

# One high-resolution render, then resample down. Rendering each size directly
# from the SVG produced a nearly empty canvas at small sizes; resampling from
# 1024 is both correct and sharper.
cp "$SRC" "$WORK/base.svg"
( cd "$WORK" && qlmanage -t -s 1024 -o . base.svg >/dev/null 2>&1 )
[ -f "$WORK/base.svg.png" ] || { echo "icons: qlmanage produced no render" >&2; exit 1; }

ICONSET="$WORK/shipkit.iconset"
mkdir -p "$ICONSET"
while read -r size name; do
  sips -z "$size" "$size" "$WORK/base.svg.png" --out "$ICONSET/$name.png" >/dev/null 2>&1
done <<'SIZES'
16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256
512 icon_256x256@2x
512 icon_512x512
1024 icon_512x512@2x
SIZES

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ICONSET" "$OUT/shipkit.iconset"
iconutil -c icns "$ICONSET" -o "$OUT/shipkit.icns"

echo "icons: $OUT/shipkit.icns"
echo "icons: $OUT/shipkit.iconset ($(ls "$OUT/shipkit.iconset" | wc -l | tr -d ' ') sizes)"
