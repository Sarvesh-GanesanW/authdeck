/**
 * The one place the desktop app reaches the agent's env sets (agent/src/envSocketContract.ts).
 *
 * INTEGRATION: slice B is adding `env: EnvAgentControl` to RunningAgent and `onEnvEvent` to
 * AgentOptions in agent/src/agent.ts. Until it lands, the two casts below stand in for them.
 * Once it does, delete both casts: `envControl` becomes `agent?.env ?? null` and
 * `withEnvEvents` becomes `{ ...options, onEnvEvent }`.
 */
import type { AgentOptions, RunningAgent } from '../../../agent/src/agent';
import type { EnvAgentControl, EnvAgentEventListener } from '../../../agent/src/envSocketContract';

/** The agent's env grants, or null while no agent runs (or, before integration, one without env sets). */
export function envControl(agent: RunningAgent | null): EnvAgentControl | null {
  // INTEGRATION: remove this cast.
  return (agent as (RunningAgent & { env?: EnvAgentControl }) | null)?.env ?? null;
}

/** Start options that also send env events to `onEnvEvent`. */
export function withEnvEvents(options: AgentOptions, onEnvEvent: EnvAgentEventListener): AgentOptions {
  // INTEGRATION: remove this cast.
  return { ...options, onEnvEvent } as AgentOptions;
}
