/// <reference types="node" />
/**
 * The real AuthDeck Agent server (agent/src/server.ts) on a free port, through the agent's own test
 * helper, so app tests can run the whole link against it. Loaded with require: the agent's sources
 * are type-checked by the agent's own build, not the app's.
 */

export interface RealAgent {
  port: number;
  /** The agent's link public key, as a QR code carries it. */
  linkKey: Uint8Array;
  /** The QR code's current one-time pairing secret. */
  pairSecret: () => string;
  /** Devices the agent has paired, by id. */
  pairedDeviceIds: () => string[];
  close: () => Promise<void>;
}

interface AgentTestServer {
  server: { close(): Promise<void> };
  port: number;
  linkKey: { public: Uint8Array };
  config: () => { pairSecret: string; devices: { deviceId: string }[] };
}

export async function startAgent(): Promise<RealAgent> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startTestServer } = require('../../agent/test/helpers/server') as { startTestServer: (deps: object) => Promise<AgentTestServer> };
  const agent = await startTestServer({});
  return {
    port: agent.port,
    linkKey: agent.linkKey.public,
    pairSecret: () => agent.config().pairSecret,
    pairedDeviceIds: () => agent.config().devices.map((d) => d.deviceId),
    close: () => agent.server.close(),
  };
}
