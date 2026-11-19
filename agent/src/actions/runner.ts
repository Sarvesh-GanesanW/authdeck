import path from 'node:path';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppCatalog } from '../apps/catalog';
import type { InstalledApp } from '../apps/types';
import { AgentError } from '../errors';
import type { ExecuteOptions, Executor } from '../executor';
import { resolveUserPath } from '../host';
import { APP_START_WAIT_MS, type Plan } from '../plan';
import type { Action, CommandAction, RunResult, StepAction } from '../protocol';
import { DEFAULT_COMMAND_TIMEOUT_SEC, type BackgroundOutcome } from './background';
import type { BuildContext, PlatformActions, ShellInvocation } from './context';
import { normalizeUrl } from './url';
import { validateAction } from './validate';
import { windowsOpenWithIsDirect } from './windows';

export interface RunnerDeps {
  ctx: BuildContext;
  actions: PlatformActions;
  catalog: AppCatalog;
  executor: Executor;
  runBackground: (shell: ShellInvocation, cwd: string, timeoutSec: number) => Promise<BackgroundOutcome>;
  log: (line: string) => void;
}

/** Steps that can start an app, so a later step aimed at that app waits for it to come up. */
const APP_STARTING_STEPS: ReadonlySet<StepAction['type']> = new Set(['launch', 'open', 'command', 'url']);

/** A relative path is taken relative to the page folder when there is one. */
function relativeTo(input: string, base: string | undefined, platform: string): string {
  if (!base) return input;
  const api = platform === 'windows' ? path.win32 : path.posix;
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\') || api.isAbsolute(input)) return input;
  return api.join(base, input);
}

/** Validates an action from the tablet, checks what it refers to exists, and carries it out. */
export class ActionRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /** `params` comes straight from the tablet (shape of RunParams, unchecked). */
  async run(params: { action?: unknown; cwd?: unknown }): Promise<RunResult> {
    const started = Date.now();
    const action = validateAction(params.action);
    const defaultCwd = typeof params.cwd === 'string' && params.cwd.trim() !== '' ? params.cwd : undefined;
    const extra = action.type === 'macro' ? await this.runMacro(action.steps, defaultCwd) : await this.runStep(action, defaultCwd);
    return { durationMs: Date.now() - started, ...extra };
  }

  private async runMacro(steps: { action: StepAction; delayMs: number }[], defaultCwd: string | undefined): Promise<Partial<RunResult>> {
    const notes: string[] = [];
    for (const [index, step] of steps.entries()) {
      const mayHaveStartedApp = steps.slice(0, index).some((earlier) => APP_STARTING_STEPS.has(earlier.action.type));
      try {
        const res = await this.runStep(step.action, defaultCwd, mayHaveStartedApp ? APP_START_WAIT_MS : 0);
        if (res.note) notes.push(`Step ${index + 1}: ${res.note}`);
      } catch (err) {
        const cause = err instanceof AgentError ? err : new AgentError('failed', (err as Error).message);
        throw new AgentError(cause.code, `Step ${index + 1} of ${steps.length} (${step.action.type}) failed: ${cause.message}`, cause.hint, cause.permission);
      }
      if (index < steps.length - 1 && step.delayMs > 0) await sleep(step.delayMs);
    }
    return notes.length ? { note: notes.join(' ') } : {};
  }

  /** `startWaitMs`: how long a step aimed at an app waits for it to start (an earlier step may have started it). */
  private async runStep(action: Exclude<Action, { type: 'macro' }>, defaultCwd: string | undefined, startWaitMs = 0): Promise<Partial<RunResult>> {
    const { actions, ctx } = this.deps;
    switch (action.type) {
      case 'launch':
        return this.execute(actions.launch(await this.app(action.appId, action.appName), ctx));
      case 'hotkey': {
        const focus = action.focusAppId ? actions.focus(await this.app(action.focusAppId), ctx, startWaitMs) : [];
        return this.execute([...focus, ...actions.hotkey(action.modifiers, action.key, ctx)]);
      }
      case 'text':
        return this.execute(actions.text(action.text, action.pressEnter === true, ctx), { secret: action.secret === true, typesText: true });
      case 'command':
        return this.command(action, defaultCwd);
      case 'url':
        return this.execute(actions.url(normalizeUrl(action.url), ctx));
      case 'open': {
        const target = await this.existingPath(relativeTo(action.path, defaultCwd, ctx.platform), 'file or folder');
        const withApp = action.withAppId ? await this.app(action.withAppId) : undefined;
        let note: string | undefined;
        if (withApp && ctx.platform === 'windows' && !windowsOpenWithIsDirect(withApp)) {
          note = `${withApp.entry.name} can't be handed a file directly, so ${target} opened with its default app.`;
          this.deps.log(`  ${note}`);
        }
        await this.execute(actions.open(target, withApp, ctx));
        return note ? { note } : {};
      }
    }
  }

  private async command(action: CommandAction, defaultCwd: string | undefined): Promise<Partial<RunResult>> {
    const { actions, ctx } = this.deps;
    const cwd = await this.existingPath(action.cwd ?? defaultCwd ?? '~', 'folder', true);
    if (action.mode === 'terminal') return this.execute(actions.terminal(action.command, cwd, ctx));
    const outcome = await this.deps.runBackground(actions.background(action.command, ctx), cwd, action.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC);
    return { exitCode: outcome.exitCode, output: outcome.output };
  }

  private async execute(plan: Plan, options: ExecuteOptions = {}): Promise<Partial<RunResult>> {
    await this.deps.executor.execute(plan, options);
    return {};
  }

  private async app(appId: string, appName?: string): Promise<InstalledApp> {
    const app = await this.deps.catalog.get(appId);
    if (!app) {
      throw new AgentError('not_found', `${appName || 'That app'} is not installed on this computer anymore.`, 'Edit the key and pick the app again.');
    }
    return app;
  }

  private async existingPath(input: string, what: string, mustBeFolder = false): Promise<string> {
    const { ctx } = this.deps;
    const resolved = resolveUserPath(input, ctx.home, ctx.platform);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) throw new AgentError('not_found', `The ${what} ${resolved} does not exist on this computer.`);
    if (mustBeFolder && !stat.isDirectory()) throw new AgentError('not_found', `${resolved} is not a folder.`);
    return resolved;
  }
}
