#!/usr/bin/env bash
# Builds a signed Play Store bundle (.aab) and a sideloadable .apk into ../../dist.
# Signing comes from AUTHDECK_UPLOAD_* in ~/.gradle/gradle.properties (see plugins/withReleaseSigning.js);
# without them Gradle signs with the debug key, which Google Play rejects.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$(cd "$APP_DIR/.." && pwd)/dist"
GRADLE_PROPS="$HOME/.gradle/gradle.properties"
# Prebuild --clean drops android/local.properties, so Gradle finds the SDK through ANDROID_HOME.
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_HOME="$SDK_DIR"

cd "$APP_DIR"
VERSION="$(node -p "require('./app.json').expo.version")"
AAB_OUT="$DIST_DIR/AuthDeck-$VERSION-android.aab"
APK_OUT="$DIST_DIR/AuthDeck-$VERSION-android.apk"

if ! grep -q '^AUTHDECK_UPLOAD_STORE_FILE=' "$GRADLE_PROPS" 2>/dev/null; then
  echo "warning: AUTHDECK_UPLOAD_STORE_FILE is not set in $GRADLE_PROPS; this build will be signed with the debug key and Google Play will reject it." >&2
fi

npx expo prebuild --clean --platform android --no-install
(cd android && ./gradlew bundleRelease assembleRelease)

mkdir -p "$DIST_DIR"
cp android/app/build/outputs/bundle/release/app-release.aab "$AAB_OUT"
cp android/app/build/outputs/apk/release/app-release.apk "$APK_OUT"

# Only certificates are read here, so no passwords are involved. The .aab is jar-signed, which
# keytool reads; the .apk carries v2/v3 signatures only, which need apksigner.
echo
echo "Bundle signed by:"
keytool -printcert -jarfile "$AAB_OUT" | grep -E '^Owner:|SHA256:' | sed 's/^[[:space:]]*/  /'

APKSIGNER="$(ls -d "$SDK_DIR"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$APKSIGNER" ]]; then
  echo "APK signed by:"
  "$APKSIGNER" verify --print-certs "$APK_OUT" | grep -E 'certificate DN|SHA-256 digest' | sed 's/^/  /'
else
  echo "apksigner not found under $SDK_DIR/build-tools; skipped the APK certificate check." >&2
fi

echo
echo "Wrote:"
echo "  $AAB_OUT"
echo "  $APK_OUT"
