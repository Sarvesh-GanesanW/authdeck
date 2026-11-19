import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentError, appNotOpen } from './errors';
import { classifyFailure } from './failures';
import { LAUNCH_SETTLE_MS, describePlan, type OpenProbe, type OsStep, type Plan } from './plan';
import type { WinHelper } from './platform/winHelper';
import { isSpawnNotFound, runProcess, spawnDetached } from './proc';
import { missingTool } from './tools';

const DEFAULT_RUN_TIMEOUT_MS = 15_000;
const OPEN_PROBE_TIMEOUT_MS = 3000;
const OPEN_POLL_MS = 250;

export interface ExecuteOptions {
  /** The plan carries a secret (a typed 2FA code): never print or echo its steps. */
  secret?: boolean;
  /** The plan types text, which may be a password in a snippet: a failure never carries tool output. */
  typesText?: boolean;
}

export interface ExecutorDeps {
  /** Named in macOS permission hints. */
  hostAppName: string;
  /** Only on Windows. */
  winHelper: WinHelper | null;
}

/** Carries out plans for real. */
export class PlanExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(plan: Plan, options: ExecuteOptions = {}): Promise<void> {
    if (!options.secret && !options.typesText) {
      for (const step of plan) await this.executeStep(step);
      return;
    }
    try {
      for (const step of plan) await this.executeStep(step);
    } catch (err) {
      // Tool output can echo the text it was given; keep only the error's kind and fixed hint.
      const code = err instanceof AgentError ? err.code : 'failed';
      const message = options.secret ? 'Could not type the code.' : 'Could not type the text.';
      throw new AgentError(code, message, err instanceof AgentError ? err.hint : undefined, err instanceof AgentError ? err.permission : undefined);
    }
  }

  private async executeStep(step: OsStep): Promise<void> {
    switch (step.kind) {
      case 'run':
        return this.run(step);
      case 'detach':
        try {
          await spawnDetached(step.cmd, step.args, { cwd: step.cwd, verbatimArgs: step.verbatimArgs });
        } catch (err) {
          if (isSpawnNotFound(err)) throw missingTool(path.basename(step.cmd), step.purpose);
          throw new AgentError('failed', `Could not ${step.purpose}: ${(err as Error).message}`);
        }
        return;
      case 'helper':
        return this.helper(step);
      case 'writeFile':
        await fs.mkdir(path.dirname(step.path), { recursive: true });
        await fs.writeFile(step.path, step.content, 'utf8');
        return;
      case 'wait':
        await sleep(step.ms);
        return;
      case 'requireOpen':
        return this.requireOpen(step);
    }
  }

  private async run(step: Extract<OsStep, { kind: 'run' }>): Promise<void> {
    let outcome;
    try {
      outcome = await runProcess(step.cmd, step.args, { input: step.input, timeoutMs: step.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, tailChars: 4000 });
    } catch (err) {
      if (isSpawnNotFound(err)) throw missingTool(step.cmd, step.purpose);
      throw err;
    }
    if (outcome.timedOut) throw new AgentError('failed', `${step.cmd} took too long to ${step.purpose}.`);
    if (outcome.exitCode !== 0) throw classifyFailure(step.failure, step.cmd, step.purpose, outcome.stderr || outcome.stdout, this.deps.hostAppName);
  }

  private async helper(step: Extract<OsStep, { kind: 'helper' }>): Promise<void> {
    const response = await this.winHelper().request(step.request);
    if (response.ok) return;
    if (response.error === 'not_found') throw new AgentError('not_found', `Could not ${step.purpose}: it has no open window.`);
    throw new AgentError('failed', `Could not ${step.purpose}: ${response.error ?? 'unknown error'}`);
  }

  private winHelper(): WinHelper {
    if (!this.deps.winHelper) throw new Error('The Windows helper is only available on Windows.');
    return this.deps.winHelper;
  }

  private async requireOpen(step: Extract<OsStep, { kind: 'requireOpen' }>): Promise<void> {
    const deadline = Date.now() + step.waitMs;
    if (await this.isOpen(step.probe)) return;
    while (Date.now() < deadline) {
      await sleep(Math.min(OPEN_POLL_MS, deadline - Date.now()));
      if (await this.isOpen(step.probe)) {
        // It has only just started: give it time to show a window that can take keys.
        await sleep(LAUNCH_SETTLE_MS);
        return;
      }
    }
    throw appNotOpen(step.appName, step.waitMs);
  }

  private async isOpen(probe: OpenProbe): Promise<boolean> {
    if (probe.kind === 'helper') {
      const response = await this.winHelper().request(probe.request);
      if (response.ok) return true;
      if (response.error === 'not_found') return false;
      throw new AgentError('failed', `Could not ${probe.purpose}: ${response.error ?? 'unknown error'}`);
    }
    let outcome;
    try {
      outcome = await runProcess(probe.cmd, probe.args, { timeoutMs: OPEN_PROBE_TIMEOUT_MS, tailChars: 4000 });
    } catch (err) {
      if (isSpawnNotFound(err)) throw missingTool(probe.cmd, probe.purpose);
      throw err;
    }
    if (outcome.timedOut) throw new AgentError('failed', `${probe.cmd} took too long to ${probe.purpose}.`);
    if (outcome.stdout.trim() !== '') return true;
    // A search that finds nothing may exit nonzero quietly; one that couldn't search says why.
    if (outcome.exitCode !== 0 && outcome.stderr.trim() !== '') {
      throw classifyFailure(probe.failure, probe.cmd, probe.purpose, outcome.stderr, this.deps.hostAppName);
    }
    return false;
  }
}

/** --dry-run: prints what would run instead of running it. */
export class DryRunExecutor {
  constructor(private readonly log: (line: string) => void) {}

  async execute(plan: Plan, options: ExecuteOptions = {}): Promise<void> {
    if (options.secret) {
      this.log(`  [dry-run] type a secret (${plan.length} step${plan.length === 1 ? '' : 's'}, not shown)`);
      return;
    }
    for (const line of describePlan(plan)) this.log(`  [dry-run] ${line}`);
  }
}

export type Executor = Pick<PlanExecutor, 'execute'>;
