/** Quoting for the few places where a value must go inside another language's source. */

/** POSIX shell single-quoted word: nothing inside is interpreted. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string: only the quote itself needs doubling (incl. typographic quotes PowerShell also accepts). */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** Value for powershell.exe -EncodedCommand (base64 of UTF-16LE), which avoids command-line quoting entirely. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** VBScript string literal: double quotes are doubled. */
export function vbsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Wraps a path in double quotes for cmd.exe (paths cannot contain `"` on Windows). */
export function cmdQuotePath(value: string): string {
  return `"${value}"`;
}
