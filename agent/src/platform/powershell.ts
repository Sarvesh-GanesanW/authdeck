import { runProcess } from '../proc';

export const POWERSHELL_EXE = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

const JSON_START = '<<AUTHDECK-JSON>>';
const JSON_END = '<<AUTHDECK-END>>';

/**
 * `-Command -` reads stdin like an interactive prompt, which mangles multi-line blocks. So stdin
 * carries a single line that decodes the real script from base64 and runs it: no quoting of the
 * script (or of any data embedded in it) can go wrong.
 */
export function powerShellStdin(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n`;
}

/** PowerShell expression that yields `value` parsed from JSON; data travels as base64 so it can't break out of a literal. */
export function powerShellJsonLiteral(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json)`;
}

/** Script lines that print `$expr` as compact JSON between markers, in UTF-8. */
export function powerShellEmitJson(expr: string): string {
  return [
    `$__json = ConvertTo-Json -Compress -Depth 5 -InputObject (${expr})`,
    `[Console]::Out.Write('${JSON_START}' + $__json + '${JSON_END}')`,
  ].join('\n');
}

/** Script prologue: UTF-8 output so app names in any language survive. */
const POWERSHELL_PROLOGUE = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false';

export function extractMarkedJson(stdout: string): unknown {
  const start = stdout.indexOf(JSON_START);
  const end = stdout.lastIndexOf(JSON_END);
  if (start < 0 || end < start) throw new Error(`PowerShell did not return a result. ${stdout.slice(-300)}`);
  return JSON.parse(stdout.slice(start + JSON_START.length, end));
}

export async function runPowerShellJson(script: string, timeoutMs: number): Promise<unknown> {
  const outcome = await runProcess(POWERSHELL_EXE, POWERSHELL_ARGS, {
    input: powerShellStdin(`${POWERSHELL_PROLOGUE}\n${script}`),
    timeoutMs,
    tailChars: 2000,
  });
  if (outcome.timedOut) throw new Error('PowerShell took too long.');
  return extractMarkedJson(outcome.stdout);
}
