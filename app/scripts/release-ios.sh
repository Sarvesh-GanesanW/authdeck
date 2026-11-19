#!/usr/bin/env bash
# Archives the iOS app and exports an .ipa into ../../dist.
#   APPLE_TEAM_ID=ABCDE12345 npm run release:ios   -> App Store Connect .ipa, signed automatically
#   npm run release:ios                            -> unsigned .ipa (cannot be uploaded to the App Store)
set -euo pipefail

# xcode-select may point at the Command Line Tools, which have no xcodebuild or iOS SDK.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$(cd "$APP_DIR/.." && pwd)/dist"
SCHEME="AuthDeck"

cd "$APP_DIR"
VERSION="$(node -p "require('./app.json').expo.version")"
ARCHIVE="$DIST_DIR/AuthDeck-$VERSION-ios.xcarchive"
IPA_OUT="$DIST_DIR/AuthDeck-$VERSION-ios.ipa"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

npx expo prebuild --clean --platform ios --no-install
(cd ios && pod install)

mkdir -p "$DIST_DIR"
rm -rf "$ARCHIVE"

archive() {
  xcodebuild archive \
    -workspace "ios/$SCHEME.xcworkspace" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    "$@"
}

if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  archive -allowProvisioningUpdates DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic

  cat > "$WORK_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$APPLE_TEAM_ID</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST

  xcodebuild -exportArchive \
    -allowProvisioningUpdates \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$WORK_DIR/ExportOptions.plist" \
    -exportPath "$WORK_DIR/export"
  cp "$WORK_DIR/export/$SCHEME.ipa" "$IPA_OUT"
  echo
  echo "Wrote $IPA_OUT (signed for App Store Connect, team $APPLE_TEAM_ID)."
  echo "Upload it with Transporter, or open $ARCHIVE in Xcode's Organizer and choose Distribute App."
  exit 0
fi

archive CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
# Name unsigned builds so they are never mistaken for an App Store upload.
IPA_OUT="$DIST_DIR/AuthDeck-$VERSION-ios-unsigned.ipa"

# An .ipa is a zip with the app bundle under Payload/.
mkdir -p "$WORK_DIR/Payload"
cp -R "$ARCHIVE/Products/Applications/$SCHEME.app" "$WORK_DIR/Payload/"
rm -f "$IPA_OUT"
(cd "$WORK_DIR" && zip -qry "$IPA_OUT" Payload)

echo
echo "Wrote $IPA_OUT (UNSIGNED)."
echo "The App Store needs a signed build: set APPLE_TEAM_ID to your Apple Developer Team ID"
echo "(developer.apple.com > Account > Membership details) and run this again."
