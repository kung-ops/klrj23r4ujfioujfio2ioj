#!/bin/bash
# Checks that an IPA can run on iOS 12 (iPhone 6): arm64, minimum iOS 12.0, no newer dyld format,
# and only frameworks that exist on iOS 12.
set -euo pipefail

IPA=${1:?usage: check-ipa.sh path/to/Sandroid.ipa}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"
APP=$(ls -d "$TMP"/Payload/*.app | head -1)
BIN="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
PROBLEMS=0
fail() { echo "FAIL: $*" >&2; PROBLEMS=$((PROBLEMS + 1)); }

MIN=$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$APP/Info.plist")
[ "$MIN" = "12.0" ] || fail "Info.plist MinimumOSVersion is $MIN"

ARCHS=$(lipo -archs "$BIN")
[ "$ARCHS" = "arm64" ] || fail "architectures are '$ARCHS', expected arm64"

LOADS=$(otool -l "$BIN")
if echo "$LOADS" | grep -q LC_DYLD_CHAINED_FIXUPS; then fail "binary uses chained fixups (iOS 13.4+ only)"; fi
MINOS=$(echo "$LOADS" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')
[ -z "$MINOS" ] && MINOS=$(echo "$LOADS" | awk '/LC_VERSION_MIN_IPHONEOS/{f=1} f&&/version/{print $2; exit}')
[ "$MINOS" = "12.0" ] || fail "binary minimum iOS is '$MINOS'"

# Frameworks that exist on iOS 12 (CoreServices is new in iOS 12, so it is fine too).
ALLOWED='/(UIKit|Foundation|AVFoundation|CoreMedia|CoreVideo|AudioToolbox|CoreImage|ImageIO|QuartzCore|MobileCoreServices|CoreServices|CoreGraphics|CoreFoundation)\.framework/|/usr/lib/(libobjc|libSystem)'
while read -r lib; do
  [ -z "$lib" ] && continue
  echo "$lib" | grep -Eq "$ALLOWED" || fail "links $lib, which may not exist on iOS 12"
done < <(otool -L "$BIN" | tail -n +2 | awk '{print $1}')

[ -d "$APP/LaunchScreen.storyboardc" ] || fail "launch screen missing"
[ -f "$APP/AppIcon60x60@2x.png" ] || fail "app icon missing"

echo "Linked libraries:"
otool -L "$BIN" | tail -n +2
if [ "$PROBLEMS" -gt 0 ]; then
  echo "$PROBLEMS problem(s): this IPA would not run on iOS 12." >&2
  exit 1
fi
echo "OK: $(basename "$IPA") runs on iOS 12+ (arm64, minos $MINOS, classic dyld info)"
