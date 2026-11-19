import type { BuildContext } from '../../src/actions/context';
import type { InstalledApp } from '../../src/apps/types';
import type { Platform } from '../../src/protocol';

export function buildContext(platform: Platform, overrides: Partial<BuildContext> & { tools?: string[] } = {}): BuildContext {
  const tools = new Set(overrides.tools ?? []);
  const home = platform === 'windows' ? 'C:\\Users\\Ada' : platform === 'macos' ? '/Users/ada' : '/home/ada';
  return {
    platform,
    home,
    env: {},
    hasTool: (name) => tools.has(name),
    terminal: 'Terminal',
    scratchDir: platform === 'windows' ? 'C:\\Users\\Ada\\.authdeck\\run' : `${home}/.authdeck/run`,
    newId: () => 'fixed-id',
    ...overrides,
  };
}

export const macSafari: InstalledApp = {
  platform: 'macos',
  entry: { id: 'mac:/Applications/Safari.app', name: 'Safari', detail: 'com.apple.Safari', hasIcon: true },
  bundlePath: '/Applications/Safari.app',
  bundleId: 'com.apple.Safari',
};

export const winCode: InstalledApp = {
  platform: 'windows',
  kind: 'lnk',
  entry: { id: 'win:lnk:C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk', name: 'Visual Studio Code', hasIcon: true },
  lnkPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk',
  targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
};

export const winOffice: InstalledApp = {
  platform: 'windows',
  kind: 'lnk',
  entry: { id: 'win:lnk:C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk', name: 'Word', hasIcon: true },
  lnkPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk',
  targetPath: '',
};

export const winCalculator: InstalledApp = {
  platform: 'windows',
  kind: 'aumid',
  entry: { id: 'win:aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calculator', hasIcon: true },
  aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
};

export const linuxCode: InstalledApp = {
  platform: 'linux',
  entry: { id: 'linux:code.desktop', name: 'Visual Studio Code', detail: 'code.desktop', hasIcon: true },
  desktop: {
    desktopId: 'code.desktop',
    filePath: '/usr/share/applications/code.desktop',
    name: 'Visual Studio Code',
    exec: '/usr/share/code/code --unity-launch %F',
    icon: 'vscode',
    startupWMClass: 'Code',
    terminal: false,
  },
};
