/**
 * The app's first code (out/main.cjs), before the app is ready and before Chromium starts any
 * child process. It refuses arguments the app doesn't take (launchArguments.ts) with exit code 2,
 * so nothing starts; in CLI mode it runs only the bundled authdeck command; otherwise it loads the
 * agent app. main.ts is required, not imported, so none of its start-up (the agent host, the
 * single-instance lock, windows) runs unless the app really starts: esbuild keeps a required
 * module's code from running until the require.
 */
import { app } from 'electron';
import { runCliMode } from './cliMode';
import { launchMode, refusedSwitches, refusedWords } from './launchArguments';

const REFUSED_EXIT_CODE = 2;

const launch = launchMode(process.argv, { platform: process.platform, defaultApp: process.defaultApp === true });
// Chromium parses the command line itself: a switch it saw is refused even if argv didn't show it.
const switches = refusedSwitches(process.platform);
const chromiumSwitch = switches.find((name) => app.commandLine.hasSwitch(name));
const refused = launch.mode === 'refused' ? launch.argument : chromiumSwitch === undefined ? null : `--${chromiumSwitch}`;

if (refused !== null) {
  process.stderr.write(`${refusedWords(refused)}\n`);
  app.exit(REFUSED_EXIT_CODE);
} else {
  for (const name of switches) app.commandLine.removeSwitch(name);
  if (launch.mode === 'cli') void runCliMode(launch.args);
  else require('./main');
}
