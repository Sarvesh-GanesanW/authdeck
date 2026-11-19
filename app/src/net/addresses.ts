/**
 * Which addresses AuthDeck will talk to: computers on the local network only. A pairing link or a
 * typed address naming anything else is refused, so a link from outside can't point the app at a
 * server on the internet.
 *
 * Allowed: private IPv4 (10/8, 172.16/12, 192.168/16), shared address space (100.64/10, which
 * Tailscale uses for its devices), link-local (169.254/16, fe80::/10), IPv6 unique-local (fc00::/7,
 * which also covers Tailscale's IPv6 addresses) and `.local` names. `.ts.net` names stay refused:
 * Tailscale Funnel can make them public. Loopback (127/8, ::1, localhost) only where the
 * agent can run on the same machine as the app, which is the web build.
 */

export interface HostRules {
  allowLoopback: boolean;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** A DNS label's characters; the hyphen rule is checked apart, so no pattern has overlapping quantifiers. */
const LABEL_CHARS = /^[a-z0-9-]{1,63}$/;
const MDNS_SUFFIX = 'local';
const IPV6_CHARS = /^[0-9a-f:.]+$/;

/** The four octets, or null. Leading zeros are refused: some resolvers read "010" as octal. */
function ipv4Octets(host: string): number[] | null {
  const m = IPV4.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5);
  if (parts.some((p) => p.length > 1 && p.startsWith('0'))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isLocalIpv4([a, b]: number[], rules: HostRules): boolean {
  if (a === 10) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true;
  if (a === 169 && b === 254) return true;
  return a === 127 && rules.allowLoopback;
}

/** The first 16 bits of an IPv6 address, or null when it isn't one. */
function ipv6FirstGroup(host: string): number | null {
  if (!host.includes(':') || !IPV6_CHARS.test(host) || (host.match(/::/g)?.length ?? 0) > 1) return null;
  if (host.startsWith('::')) return 0;
  const group = host.split(':')[0]!;
  return /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : null;
}

function isLocalIpv6(host: string, rules: HostRules): boolean {
  if (host === '::1') return rules.allowLoopback;
  const first = ipv6FirstGroup(host);
  if (first === null) return false;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  return linkLocal || uniqueLocal;
}

/** True when `host` is on the local network (see the module comment for what that covers). */
export function isLocalNetworkHost(host: string, rules: HostRules): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!h) return false;
  const octets = ipv4Octets(h);
  if (octets) return isLocalIpv4(octets, rules);
  if (h.includes(':')) return isLocalIpv6(h.replace(/%[a-z0-9._-]+$/, ''), rules);
  if (h === 'localhost' || h === 'localhost.') return rules.allowLoopback;
  return isMdnsName(h);
}

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. */
const isLabel = (label: string): boolean => LABEL_CHARS.test(label) && !label.startsWith('-') && !label.endsWith('-');

/** A lower-case name of one or more labels under .local, with an optional final dot. */
function isMdnsName(host: string): boolean {
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
  return labels.length >= 2 && labels.pop() === MDNS_SUFFIX && labels.every(isLabel);
}

/** Why an address was refused, in plain words. */
export function outsideNetworkMessage(host: string): string {
  return (
    `That address (${host}) is outside your local network. AuthDeck only connects to computers on the same ` +
    'Wi-Fi or wired network or your Tailscale network, with addresses like 192.168.1.24, 10.0.0.5, ' +
    '100.101.102.103 or my-computer.local.'
  );
}
