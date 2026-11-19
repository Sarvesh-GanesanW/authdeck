// Bundles each binary and its dependencies into one file: dist/authdeck-agent.cjs (the agent)
// and dist/authdeck.cjs (the `authdeck env` command that ships with it).
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const binaries = [
  { entry: 'src/cli.ts', outfile: 'dist/authdeck-agent.cjs' },
  { entry: 'src/envcli/main.ts', outfile: 'dist/authdeck.cjs' },
];

for (const { entry, outfile } of binaries) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    logLevel: 'warning',
  });
  chmodSync(outfile, 0o755);
  console.log(`built ${outfile}`);
}
