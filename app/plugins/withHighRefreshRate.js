// Asks Android for the display's fastest refresh rate. Without this, some phones and
// tablets (Xiaomi's HyperOS among them) keep apps at 60 Hz even on 120 or 144 Hz screens.
const { withMainActivity } = require('expo/config-plugins');

const call = '    preferFastestRefreshRate()';

const method = `
  private fun preferFastestRefreshRate() {
    val screen = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display else @Suppress("DEPRECATION") windowManager.defaultDisplay) ?: return
    val current = screen.mode
    val fastest = screen.supportedModes
      .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
      .maxByOrNull { it.refreshRate } ?: return
    window.attributes = window.attributes.apply { preferredDisplayModeId = fastest.modeId }
  }
`;

module.exports = function withHighRefreshRate(config) {
  return withMainActivity(config, (mod) => {
    let src = mod.modResults.contents;
    if (src.includes('preferFastestRefreshRate')) return mod;

    src = src.replace(/(super\.onCreate\([^)]*\)\n)(\s*\}\n)/, `$1${call}\n$2${method}`);
    if (!src.includes(call) || !src.includes('private fun preferFastestRefreshRate')) {
      throw new Error('withHighRefreshRate: MainActivity layout changed; update the plugin.');
    }
    mod.modResults.contents = src;
    return mod;
  });
};
