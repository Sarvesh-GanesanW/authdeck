import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { AgentError } from '../errors';
import type { WinHelperRequest } from '../plan';
import { POWERSHELL_EXE } from './powershell';
import { WIN_HELPER_CSHARP } from './winHelperSource';

const REQUEST_TIMEOUT_MS = 15_000;
/** Compiling the C# takes a few seconds on a cold machine. */
const START_TIMEOUT_MS = 30_000;

/** PowerShell loop: one JSON request per stdin line, one JSON response per stdout line. */
export function winHelperScript(): string {
  return `$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$source = @'
${WIN_HELPER_CSHARP}
'@
Add-Type -TypeDefinition $source
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    switch ([string]$req.op) {
      'keys' {
        [AuthDeckNative]::SendKeys([int[]]@($req.modifiers), [int]$req.vk)
        $resp = @{ id = $id; ok = $true }
      }
      'text' {
        [AuthDeckNative]::TypeText([string]$req.text)
        $resp = @{ id = $id; ok = $true }
      }
      'focus' {
        $found = [AuthDeckNative]::Focus([string]$req.exe, [string]$req.aumid)
        if ($found) { $resp = @{ id = $id; ok = $true } } else { $resp = @{ id = $id; ok = $false; error = 'not_found' } }
      }
      'foreground' {
        $app = [AuthDeckNative]::Foreground()
        if ($null -eq $app) { $resp = @{ id = $id; ok = $true; exe = $null; aumid = $null; name = '' } }
        else { $resp = @{ id = $id; ok = $true; exe = $app.Exe; aumid = $app.Aumid; name = $app.Name } }
      }
      default { $resp = @{ id = $id; ok = $false; error = ('unknown op ' + $req.op) } }
    }
  } catch {
    $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $resp))
  [Console]::Out.Flush()
}
`;
}

/** JSON with every non-ASCII character escaped, so the line survives any console code page. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface WinHelperResponse {
  id: string;
  ok: boolean;
  error?: string;
  exe?: string | null;
  aumid?: string | null;
  name?: string;
}

interface Pending {
  resolve: (response: WinHelperResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Long-lived PowerShell process doing SendInput and window work; started on first use, restarted if it dies. */
function spawnHelper(scriptPath: string) {
  return spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class WinHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(private readonly scriptDir: string) {}

  async request(request: WinHelperRequest): Promise<WinHelperResponse> {
    await this.start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError('failed', 'The Windows input helper did not answer in time.'));
      }, REQUEST_TIMEOUT_MS);
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        clearTimeout(timer);
        reject(new AgentError('failed', 'The Windows input helper stopped.'));
        return;
      }
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${asciiJson({ id, ...request })}\n`);
    });
  }

  stop(): void {
    this.child?.kill();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const scriptPath = path.join(this.scriptDir, 'win-helper.ps1');
    let child: ReturnType<typeof spawnHelper>;
    try {
      fs.mkdirSync(this.scriptDir, { recursive: true });
      fs.writeFileSync(scriptPath, winHelperScript(), 'utf8');
      child = spawnHelper(scriptPath);
    } catch (err) {
      // The script couldn't be written (antivirus, no file handles) or PowerShell started: the
      // next request tries again instead of failing until the agent restarts.
      return Promise.reject(new AgentError('failed', `The Windows input helper could not start: ${(err as Error).message}`));
    }
    this.ready = new Promise<void>((resolve, reject) => {
      this.child = child;
      let stderr = '';
      let startTimer: NodeJS.Timeout | undefined;
      let gone = false;
      const onGone = (err?: Error) => {
        if (gone) return;
        gone = true;
        clearTimeout(startTimer);
        const reason = err?.message ?? (stderr.trim() || 'it stopped');
        const failure = new AgentError('failed', `The Windows input helper stopped: ${reason}`);
        reject(failure);
        for (const waiting of this.pending.values()) {
          clearTimeout(waiting.timer);
          waiting.reject(failure);
        }
        this.pending.clear();
        this.child = null;
        this.ready = null; // next request starts a fresh helper
      };
      // Listen before anything else: a helper that can't start (EMFILE, missing PowerShell) says so here.
      child.once('error', onGone);
      child.once('exit', () => onGone());
      if (!child.stdin || !child.stdout || !child.stderr) return; // the 'error' event follows
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      startTimer = setTimeout(() => {
        reject(new AgentError('failed', 'The Windows input helper did not start in time.'));
        child.kill();
      }, START_TIMEOUT_MS);

      const lines = readline.createInterface({ input: child.stdout });
      // readline passes on its input's errors: a broken pipe ends this helper, not the agent.
      lines.on('error', (err: Error) => {
        onGone(err);
        child.kill();
      });
      lines.on('line', (line) => {
        let message: WinHelperResponse & { ready?: boolean };
        try {
          message = JSON.parse(line) as WinHelperResponse & { ready?: boolean };
        } catch {
          return; // stray output from PowerShell itself
        }
        if (message.ready) {
          clearTimeout(startTimer);
          resolve();
          return;
        }
        const waiting = this.pending.get(String(message.id));
        if (!waiting) return;
        this.pending.delete(String(message.id));
        clearTimeout(waiting.timer);
        waiting.resolve(message);
      });
    });
    return this.ready;
  }
}
