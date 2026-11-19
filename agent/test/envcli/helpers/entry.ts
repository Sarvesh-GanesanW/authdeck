/** The authdeck binary as main.ts builds it, but with the fake core: what subprocess tests run. */
import os from 'node:os';

import { authdeckHome } from '../../../src/config';
import { runEnvCli } from '../../../src/envcli/cli';
import { envSocketPath } from '../../../src/envSocketContract';
import { fakeCore } from './fakeCore';

void runEnvCli(
  {
    core: fakeCore,
    cwd: process.cwd(),
    env: process.env,
    socketPath: envSocketPath(authdeckHome(), process.platform, os.userInfo().username),
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (_question, fallback) => fallback,
    now: Date.now,
  },
  { argv: process.argv.slice(2), hasTerminal: false },
).then((code) => {
  process.exitCode = code;
});
