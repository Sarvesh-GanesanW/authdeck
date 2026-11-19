// Raises AsyncStorage's database cap on Android from its default 6 MB. The cap covers every key
// together (the saved state, each computer's icons, the crash marks), and a write past it fails,
// so a few saved computers' icons could stop the main state from saving. AsyncStorage 2.x reads
// the cap, in MB, from the AsyncStorage_db_size_in_MB gradle property (its android/config.gradle).
// Each value still can't pass about 2 MB on Android (the SQLite cursor window), whatever the cap.
const { withGradleProperties } = require('expo/config-plugins');

const SIZE_PROPERTY = 'AsyncStorage_db_size_in_MB';
const SIZE_MB = '64';

module.exports = function withAsyncStorageSize(config) {
  return withGradleProperties(config, (mod) => {
    const properties = mod.modResults.filter((item) => !(item.type === 'property' && item.key === SIZE_PROPERTY));
    properties.push({ type: 'property', key: SIZE_PROPERTY, value: SIZE_MB });
    mod.modResults = properties;
    return mod;
  });
};
