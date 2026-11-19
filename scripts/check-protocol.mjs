// Fails if the agent and app copies of shared code differ: the wire protocol, the vault core, the
// encrypted link and the env set file model.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;

const agentProtocol = readFileSync(join(root, 'agent/src/protocol.ts'), 'utf8');
const appProtocol = readFileSync(join(root, 'app/src/protocol.ts'), 'utf8');
if (agentProtocol !== appProtocol) {
  console.error('agent/src/protocol.ts and app/src/protocol.ts differ. Copy the agent one over the app one.');
  failed = true;
}

const files = (dir) => readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();

/** Compares agent/src/<folder> with app/src/<folder>, file by file and byte for byte. */
function checkSharedFolder(folder, what) {
  const agentDir = join(root, 'agent/src', folder);
  const appDir = join(root, 'app/src', folder);
  const agentFiles = files(agentDir);
  const appFiles = files(appDir);
  const differing = [...new Set([...agentFiles, ...appFiles])].filter((name) => {
    if (!agentFiles.includes(name) || !appFiles.includes(name)) return true;
    return readFileSync(join(agentDir, name), 'utf8') !== readFileSync(join(appDir, name), 'utf8');
  });
  if (differing.length === 0) return;
  console.error(`The ${what} copies differ (${differing.join(', ')}). Copy agent/src/${folder} over app/src/${folder}: rm -r app/src/${folder} && cp -r agent/src/${folder} app/src/${folder}`);
  failed = true;
}

checkSharedFolder('vault', 'vault core');
checkSharedFolder('link', 'link');
checkSharedFolder('envcore', 'env core');

/**
 * The env core runs in the app as well as the agent, so it may import only itself, the vault core
 * (by relative path, which resolves to each side's identical copy) and the crypto packages both
 * sides pin. Anything else (Node APIs, agent or app modules) would break one side or split them.
 */
const ENVCORE_IMPORT = /^(\.\/[\w.]+|\.\.\/vault\/[\w.]+|@noble\/(ciphers|curves|hashes)\/[\w./-]+|@scure\/bip39(\/[\w./-]+)?)$/;
const envcoreDir = join(root, 'agent/src/envcore');
for (const name of files(envcoreDir)) {
  const source = readFileSync(join(envcoreDir, name), 'utf8');
  for (const [, specifier] of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
    if (ENVCORE_IMPORT.test(specifier)) continue;
    console.error(`agent/src/envcore/${name} imports '${specifier}'. The env core may import only ./, ../vault/ and the @noble and @scure packages, so the app copy works too.`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('protocol, vault core, link and env core copies match');
