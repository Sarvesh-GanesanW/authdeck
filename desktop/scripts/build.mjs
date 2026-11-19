// Bundles the main process (with the agent), the preload script, the renderer and the `authdeck`
// command (out/cli, shipped as resources/cli: see extraResources) into out/.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

const outdir = 'out';
rmSync(outdir, { recursive: true, force: true });

const common = { bundle: true, legalComments: 'none', logLevel: 'warning', sourcemap: false };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/start.ts'], outfile: `${outdir}/main.cjs`, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: `${outdir}/preload.cjs`, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: `${outdir}/renderer/renderer.js`, platform: 'browser', format: 'iife', target: 'chrome140' }),
  // Run by the app's CLI mode (src/main/cliMode.ts), which the wrappers in src/cli start.
  build({ ...common, entryPoints: ['../agent/src/envcli/main.ts'], outfile: `${outdir}/cli/authdeck.cjs`, platform: 'node', format: 'cjs', target: 'node22' }),
]);

cpSync('src/renderer/index.html', `${outdir}/renderer/index.html`);
cpSync('src/renderer/styles.css', `${outdir}/renderer/styles.css`);
cpSync('src/renderer/fonts', `${outdir}/renderer/fonts`, { recursive: true });
cpSync('src/cli', `${outdir}/cli`, { recursive: true });
cpSync('resources/tray', `${outdir}/resources`, { recursive: true });
cpSync('resources/icon.png', `${outdir}/resources/icon.png`);
console.log(`built ${outdir}/`);
