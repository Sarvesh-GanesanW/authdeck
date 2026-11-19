/// <reference types="node" />
/**
 * Import first in tests that load app code using Expo or React Native: points those packages at
 * test/stubs/native.cjs, so the real net and pairing code runs in Node.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NATIVE_PACKAGES = new Set([
  'expo',
  'react-native',
  '@react-native-async-storage/async-storage',
  'expo-crypto',
  'expo-secure-store',
  'expo-network',
  'expo-device',
  'expo-haptics',
  // Deck backups pick and share files; their tests only read and write the JSON.
  'expo-document-picker',
  'expo-sharing',
]);
const STUB_URL = pathToFileURL(path.join(__dirname, 'stubs', 'native.cjs')).href;
/** expo-file-system over a temporary folder (stubs/fileSystem.cjs), for the vault's local copy. */
const FILE_SYSTEM_URL = pathToFileURL(path.join(__dirname, 'stubs', 'fileSystem.cjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-file-system') return { url: FILE_SYSTEM_URL, format: 'commonjs', shortCircuit: true };
    if (NATIVE_PACKAGES.has(specifier)) return { url: STUB_URL, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/**
 * The link and /hello run over a Node TCP transport, as they do over the native module on a phone.
 * Loaded after the hooks above, so the app code it pulls in sees the stubs.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTcpTransport } = require('../src/net/tcp') as typeof import('../src/net/tcp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NodeTcpTransport } = require('./nodeTcp') as typeof import('./nodeTcp');
export const nodeTcp = new NodeTcpTransport();
setTcpTransport(nodeTcp);

/** The stubbed react-native Platform, for tests that act as the web build. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const Platform = (require('react-native') as typeof import('react-native')).Platform as { OS: string };
