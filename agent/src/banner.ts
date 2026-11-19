import type os from 'node:os';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode-terminal/vendor/QRCode';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel';
import { linkKeyWords } from './link/keys';
import { PAIR_URL_PREFIX, PROTOCOL_VERSION } from './protocol';
import { toBase64Url } from './vault/bytes';

const VIRTUAL_INTERFACE = /^(docker|br-|veth|vmnet|vboxnet|virbr|utun|tun|tap|bridge|zt|tailscale|ham|awdl|llw|lo|vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback)/i;

/** LAN IPv4 addresses, physical-looking interfaces (en0, eth0, wlan0, Wi-Fi, Ethernet) first. */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const physical: string[] = [];
  const other: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      (VIRTUAL_INTERFACE.test(name) ? other : physical).push(info.address);
    }
  }
  return [...new Set([...physical, ...other])];
}

/** What the QR code carries. The link key is what makes scanning it authenticate the computer. */
export interface PairLinkInfo {
  name: string;
  port: number;
  hosts: readonly string[];
  /** The computer's static link public key. */
  linkKey: Uint8Array;
  /** The current one-time pairing secret (base64url). */
  pairSecret: string;
}

export function pairUrl(info: PairLinkInfo): string {
  const query = [
    `v=${PROTOCOL_VERSION}`,
    `n=${encodeURIComponent(info.name)}`,
    `p=${info.port}`,
    `h=${info.hosts.map(encodeURIComponent).join(',')}`,
    `k=${toBase64Url(info.linkKey)}`,
    `s=${encodeURIComponent(info.pairSecret)}`,
  ].join('&');
  return `${PAIR_URL_PREFIX}?${query}`;
}

/** The six key words as shown on the computer and in the app: "word · word · … · word". */
export function keyWordsText(linkKey: Uint8Array): string {
  return linkKeyWords(linkKey).join(' · ');
}

/** The QR code as rows of dark (true) and light modules, same encoding as the terminal QR. */
export function qrModules(text: string): boolean[][] {
  const code = new QRCode(-1, QRErrorCorrectLevel.L);
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
}

function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, resolve));
}

function spacedPin(pin: string): string {
  return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}

/** What the agent prints when it starts. It never holds the PIN or the QR code: logs keep it. */
export interface BannerInfo {
  name: string;
  version: string;
  port: number;
  addresses: string[];
  dryRun: boolean;
  linkKey: Uint8Array;
}

export function bannerText(info: BannerInfo): string {
  const addressLines = info.addresses.length > 0 ? info.addresses.map((a) => `    ${a}:${info.port}`) : ['    (no network found: connect this computer to Wi-Fi or Ethernet)'];
  return [
    '',
    `  AuthDeck agent ${info.version}${info.dryRun ? '  [DRY RUN: actions are logged, not performed]' : ''}`,
    '',
    `  Computer   ${info.name}`,
    '  Address',
    ...addressLines,
    `  Key words  ${keyWordsText(info.linkKey)}`,
    '',
    '  To pair a device, run "authdeck-agent pair" in another terminal. It shows a PIN and a QR code',
    '  for 10 minutes.',
    '  Keep this window open while you use AuthDeck. Press Ctrl+C to stop.',
    '',
  ].join('\n');
}

/** What `authdeck-agent pair` prints in its own terminal: the secrets of one pairing window. */
export interface PairingScreenInfo extends PairLinkInfo {
  pin: string;
  minutes: number;
}

export async function pairingText(info: PairingScreenInfo): Promise<string> {
  const qr = await renderQr(pairUrl(info));
  return [
    '',
    `  Pair a device with ${info.name}`,
    '',
    `  PIN        ${spacedPin(info.pin)}`,
    `  Key words  ${keyWordsText(info.linkKey)}`,
    '',
    '  Scan this with the AuthDeck app, or pick this computer in the app and type the PIN:',
    '',
    qr.replace(/^/gm, '  '),
    `  Pairing is open for ${info.minutes} minutes. Press Ctrl+C to close it sooner.`,
    '',
  ].join('\n');
}

/** Printed by `authdeck-agent pair` when the PIN was replaced after too many wrong guesses. */
export function newPinText(pin: string, pausedSeconds: number): string {
  const pause = pausedSeconds > 0 ? ` PIN pairing is paused for ${pausedSeconds} seconds.` : '';
  return `  Too many wrong PINs, so the PIN is now ${spacedPin(pin)}.${pause} The QR code still works.`;
}
