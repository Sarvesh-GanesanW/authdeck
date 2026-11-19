// Signs Android release builds with your own key instead of the shared debug key.
// Set these in ~/.gradle/gradle.properties (never in the repo):
//   AUTHDECK_UPLOAD_STORE_FILE, AUTHDECK_UPLOAD_KEY_ALIAS,
//   AUTHDECK_UPLOAD_STORE_PASSWORD, AUTHDECK_UPLOAD_KEY_PASSWORD
// Without them, release builds fall back to the debug key so anyone can still build.
const { withAppBuildGradle } = require('expo/config-plugins');

const releaseConfig = `
        release {
            if (findProperty('AUTHDECK_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('AUTHDECK_UPLOAD_STORE_FILE'))
                storePassword findProperty('AUTHDECK_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('AUTHDECK_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('AUTHDECK_UPLOAD_KEY_PASSWORD')
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes('AUTHDECK_UPLOAD_STORE_FILE')) return mod;

    gradle = gradle.replace(
      /(signingConfigs \{\n\s+debug \{[^}]*\})/,
      `$1${releaseConfig}`,
    );
    gradle = gradle.replace(
      /(release \{\n(?:\s*\/\/.*\n)*)\s*signingConfig signingConfigs\.debug/,
      `$1            signingConfig findProperty('AUTHDECK_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
    );
    if (!gradle.includes('signingConfigs.release')) {
      throw new Error('withReleaseSigning: build.gradle layout changed; update the plugin.');
    }
    mod.modResults.contents = gradle;
    return mod;
  });
};
