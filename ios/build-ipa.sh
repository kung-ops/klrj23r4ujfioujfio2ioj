#!/bin/bash
# Builds ios/build/Sandroid.ipa for iOS 12+ (iPhone 6 and newer). Needs a Mac with Xcode 16.x.
# Xcode 26 and newer produce apps that crash on iOS 12 devices, so this refuses to use them
# unless SANDROID_ALLOW_NEW_XCODE=1.
set -euo pipefail

cd "$(dirname "$0")"
APP=Sandroid
OUT=build
APPDIR="$OUT/Payload/$APP.app"
MIN_IOS=12.0

XCODE_VERSION=$(xcodebuild -version | awk 'NR==1 {print $2}')
XCODE_MAJOR=${XCODE_VERSION%%.*}
echo "Xcode $XCODE_VERSION"
if [ "$XCODE_MAJOR" -ge 26 ] && [ "${SANDROID_ALLOW_NEW_XCODE:-0}" != "1" ]; then
  echo "error: Xcode $XCODE_VERSION builds crash on iOS 12. Use Xcode 16.4 (codemagic.yaml: xcode: 16.4)." >&2
  exit 1
fi

SDK=$(xcrun --sdk iphoneos --show-sdk-path)
echo "SDK $SDK"

rm -rf "$OUT"
mkdir -p "$APPDIR"

# 1. Compile. Any API newer than iOS 12 without an @available check is a build error.
xcrun --sdk iphoneos clang \
  -arch arm64 \
  -isysroot "$SDK" \
  -miphoneos-version-min=$MIN_IOS \
  -fobjc-arc -O2 \
  -Wall -Wno-deprecated-declarations -Wno-unused-parameter \
  -Werror=unguarded-availability -Werror=unguarded-availability-new \
  -Werror=objc-method-access -Werror=implicit-function-declaration -Werror=incompatible-pointer-types \
  -framework UIKit -framework Foundation -framework AVFoundation -framework CoreMedia -framework CoreVideo \
  -framework AudioToolbox -framework CoreImage -framework ImageIO -framework QuartzCore \
  -framework MobileCoreServices -framework CoreGraphics \
  -Wl,-dead_strip -Wl,-no_fixup_chains \
  Sources/*.m \
  -o "$APPDIR/$APP"

# 2. Launch screen
xcrun ibtool --errors --warnings --output-format human-readable-text \
  --minimum-deployment-target $MIN_IOS --target-device iphone --target-device ipad \
  --compile "$APPDIR/LaunchScreen.storyboardc" Resources/LaunchScreen.storyboard

# 3. Info.plist, icons
cp Resources/Info.plist "$APPDIR/Info.plist"
if [ -n "${BUILD_NUMBER:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APPDIR/Info.plist"
fi
SDK_VERSION=$(xcrun --sdk iphoneos --show-sdk-version)
/usr/libexec/PlistBuddy -c "Add :DTSDKName string iphoneos$SDK_VERSION" "$APPDIR/Info.plist"
/usr/libexec/PlistBuddy -c "Add :DTPlatformVersion string $SDK_VERSION" "$APPDIR/Info.plist"
/usr/libexec/PlistBuddy -c "Add :DTXcode string ${XCODE_VERSION//./}" "$APPDIR/Info.plist"
plutil -convert binary1 "$APPDIR/Info.plist"
cp Resources/Icons/*.png "$APPDIR/"
printf 'APPL????' > "$APPDIR/PkgInfo"

# 4. Ad-hoc signature. Sideloadly / AltStore / Codemagic signing replace it with a real one.
xcrun strip -x "$APPDIR/$APP"
codesign --force --sign - --timestamp=none "$APPDIR"

# 5. Package
(cd "$OUT" && rm -f "$APP.ipa" && zip -qry -X "$APP.ipa" Payload)
echo "Built $(pwd)/$OUT/$APP.ipa ($(du -h "$OUT/$APP.ipa" | cut -f1))"
