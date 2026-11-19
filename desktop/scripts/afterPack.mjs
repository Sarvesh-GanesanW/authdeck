// electron-builder's afterPack hook: sets the packaged app's Electron fuses before it is signed.
// AuthDeck Agent holds the person's Accessibility and Automation grants, so no other program may
// run its own code as AuthDeck Agent: no running as plain Node (the authdeck command uses the
// app's CLI mode instead, src/main/cliMode.ts), no NODE_OPTIONS, no --inspect, and the app's code
// only from its app.asar, checked against the hash recorded at build time.
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

const EXECUTABLE_EXTENSION = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' };

export const AGENT_FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/** @param {import('app-builder-lib').AfterPackContext} context */
export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = electronPlatformName === 'linux' ? packager.executableName : packager.appInfo.productFilename;
  const executable = path.join(appOutDir, `${name}${EXECUTABLE_EXTENSION[electronPlatformName]}`);
  // Flipping a fuse edits the binary; an Apple silicon Mac runs none without a valid signature,
  // so on macOS it is signed ad hoc again here and properly when electron-builder signs the app.
  await flipFuses(executable, { ...AGENT_FUSES, resetAdHocDarwinSignature: electronPlatformName === 'darwin' || electronPlatformName === 'mas' });
}
