#!/usr/bin/env bash
# Build the menu-bar executable and assemble shipkit.app around it.
#
# The bundle is derived, like design/icon/generated — one command rebuilds it,
# so it is git-ignored rather than committed. SwiftPM produces an executable and
# not a bundle, and a menu-bar application needs an Info.plist saying it has no
# Dock icon, so the wrapping happens here.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/apps/menubar/build/shipkit.app"

# Read rather than written, for the reason src/cli.ts records: a literal version stayed at
# 0.1.0 through three releases and reported 0.1.0 from a 0.1.3 install.
VERSION="$(node -p "require('./package.json').version")"

echo "app: building $VERSION"
( cd apps/menubar && swift build -c release )

BIN="$ROOT/apps/menubar/.build/release/ShipkitMenuBar"
[ -x "$BIN" ] || { echo "app: no executable at $BIN" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ShipkitMenuBar"

if [ -f "$ROOT/design/icon/generated/shipkit.icns" ]; then
  cp "$ROOT/design/icon/generated/shipkit.icns" "$APP/Contents/Resources/shipkit.icns"
else
  echo "app: no icon yet — run scripts/icons.sh first if you want one" >&2
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>shipkit</string>
  <key>CFBundleIdentifier</key><string>com.shipkit.menubar</string>
  <key>CFBundleExecutable</key><string>ShipkitMenuBar</string>
  <key>CFBundleIconFile</key><string>shipkit</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- No Dock icon and no menu bar of its own: this application is the status item. -->
  <key>LSUIElement</key><true/>
</dict>
PLIST
echo "</plist>" >> "$APP/Contents/Info.plist"

# Ad-hoc signature. Without one, Gatekeeper refuses the bundle outright rather
# than offering the right-click-open path. Real signing is a separate decision;
# see packaging/README.md.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "app: ad-hoc signing failed, bundle is unsigned" >&2

echo "app: $APP"
