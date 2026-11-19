/**
 * Reads the head of an HTTP/1.1 response (status line and headers) from raw bytes, for the
 * WebSocket upgrade and /hello over AuthDeck's own TCP. Strict: anything unusual is refused, since
 * only AuthDeck Agent should be answering.
 */

export interface ResponseHead {
  status: number;
  /** Lower-case header name to its values, in order. */
  headers: Map<string, string[]>;
  /** Bytes of the response that came after the blank line. */
  rest: Uint8Array;
}

export type HeadRead = { kind: 'incomplete' } | { kind: 'refused'; reason: string } | { kind: 'head'; head: ResponseHead };

const CR = 13;
const LF = 10;
const STATUS_LINE = /^HTTP\/1\.1 (\d{3})(?: [\x20-\x7e]*)?$/;
/*
 * A header line is checked in pieces rather than by one pattern: a single regex over the whole line
 * needs overlapping quantifiers around the value's optional whitespace, and a peer could make those
 * backtrack for seconds on one line of spaces.
 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e\t]*$/;
const SPACE = 32;
const TAB = 9;

/** The blank line is 4 bytes, so a scan that resumes must back up this far to catch one split across reads. */
const BLANK_LINE_OVERLAP = 3;

/** Where the blank line ending the head starts, or -1. Looks only at positions from `from` on. */
function headEnd(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
    if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) return i;
  }
  return -1;
}

const isOptionalWhitespace = (code: number): boolean => code === SPACE || code === TAB;

/** The value with its leading and trailing spaces and tabs removed. */
function trimOptionalWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isOptionalWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isOptionalWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/** A header line's name and trimmed value, or null when it is malformed. */
function parseHeaderLine(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const name = line.slice(0, colon);
  const value = trimOptionalWhitespace(line.slice(colon + 1));
  if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) return null;
  return { name: name.toLowerCase(), value };
}

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * Parses the head once it has fully arrived. `maxHeadBytes` bounds the head (blank line included):
 * a head that hasn't ended within it is refused, so the caller never holds more. A caller reading
 * the head as it trickles in passes `scannedBytes`, how much it had last time it got 'incomplete',
 * so each read scans only the new bytes rather than everything again.
 */
export function readResponseHead(bytes: Uint8Array, maxHeadBytes: number, scannedBytes = 0): HeadRead {
  const end = headEnd(bytes.subarray(0, maxHeadBytes), scannedBytes - BLANK_LINE_OVERLAP);
  if (end < 0) return bytes.length >= maxHeadBytes ? { kind: 'refused', reason: 'its headers are too long' } : { kind: 'incomplete' };
  const lines = latin1(bytes.subarray(0, end)).split('\r\n');
  const status = STATUS_LINE.exec(lines[0]!);
  if (!status) return { kind: 'refused', reason: 'it is not an HTTP/1.1 response' };
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const header = parseHeaderLine(line);
    if (!header) return { kind: 'refused', reason: 'it has a malformed header' };
    (headers.get(header.name) ?? headers.set(header.name, []).get(header.name)!).push(header.value);
  }
  return { kind: 'head', head: { status: Number(status[1]), headers, rest: bytes.subarray(end + 4) } };
}

/** The comma-separated tokens of every value of a header, lower-cased. */
export function headerTokens(head: ResponseHead, name: string): string[] {
  return (head.headers.get(name) ?? []).flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase())).filter(Boolean);
}

/** The header's single value, or null when it is absent or repeated. */
export function singleHeader(head: ResponseHead, name: string): string | null {
  const values = head.headers.get(name);
  return values?.length === 1 ? values[0]! : null;
}
