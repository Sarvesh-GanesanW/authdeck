/**
 * `authdeck-agent pair`: opens the running agent's pairing window for 10 minutes and shows its PIN
 * and QR code in this terminal only, never in the agent's log. It ends when a device pairs, when
 * the window closes, or on Ctrl+C (or the terminal closing, or a kill), and the PIN and QR code stop
 * working then. The agent itself closes the window when a device pairs.
 */
import os from 'node:os';
import { lanAddresses, newPinText, pairingText } from './banner';
import { generatePairSecret, generatePin, loadConfig, loadLinkKey, updateConfig, watchConfig, type AgentConfig } from './config';
import { PAIRING_WINDOW_MS, Pairing, printableName } from './pairing';
import { HELLO_PATH, type HelloResponse } from './protocol';

const AGENT_CHECK_TIMEOUT_MS = 2000;
const CLOSING_SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGHUP', 'SIGTERM'];

/** Whether this computer's agent answers on the port: the window only works while it runs. */
async function agentAnswers(port: number, agentId: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HELLO_PATH}`, { signal: AbortSignal.timeout(AGENT_CHECK_TIMEOUT_MS) });
    const hello = (await response.json()) as Partial<HelloResponse>;
    return hello.app === 'authdeck-agent' && hello.agentId === agentId;
  } catch {
    return false;
  }
}

function deviceKeys(config: AgentConfig): Set<string> {
  return new Set(config.devices.map((d) => `${d.deviceId} ${d.linkKey ?? ''}`));
}

export async function runPairCommand(home: string, port: number | undefined, print: (text: string) => void): Promise<void> {
  const config = loadConfig(home);
  const agentPort = port ?? config.port;
  if (!(await agentAnswers(agentPort, config.agentId))) {
    throw new Error(`No AuthDeck agent is running on port ${agentPort}. Start it first ("authdeck-agent", or the AuthDeck Agent app), then run "authdeck-agent pair" again.`);
  }
  const pairing = new Pairing({ load: () => loadConfig(home), update: (change) => updateConfig(home, change), newPin: generatePin, newPairSecret: generatePairSecret });
  const window = pairing.openWindow(PAIRING_WINDOW_MS);
  const before = deviceKeys(loadConfig(home));
  const shown = await pairingText({
    name: config.name,
    port: agentPort,
    hosts: lanAddresses(os.networkInterfaces()),
    linkKey: loadLinkKey(home).public,
    pairSecret: window.pairSecret,
    pin: window.pin,
    minutes: PAIRING_WINDOW_MS / 60_000,
  });

  await new Promise<void>((resolve) => {
    let shownPin = window.pin;
    let done = false;
    const finish = (message: string, close: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(expiry);
      stopWatching();
      for (const signal of CLOSING_SIGNALS) process.off(signal, interrupted);
      if (close) {
        try {
          pairing.expireWindow(window.closesAt);
        } catch (err) {
          print(`  Could not close pairing: ${(err as Error).message}. It closes by itself within ${PAIRING_WINDOW_MS / 60_000} minutes.`);
        }
      }
      print(message);
      resolve();
    };
    // Ctrl+C, the terminal window closing, or a kill: the PIN shown here stops working.
    const interrupted = () => finish('  Pairing closed.', true);
    const expiry = setTimeout(() => finish(`  Pairing closed after ${PAIRING_WINDOW_MS / 60_000} minutes. Run "authdeck-agent pair" to pair another device.`, true), window.closesAt - Date.now());
    const stopWatching = watchConfig(home, () => {
      let latest: AgentConfig;
      try {
        latest = loadConfig(home);
      } catch {
        return; // Mid-change; the next file event reads it again.
      }
      const paired = latest.devices.find((d) => !before.has(`${d.deviceId} ${d.linkKey ?? ''}`));
      if (paired) return finish(`  Paired ${printableName(paired.deviceName)}. Pairing is closed again.`, true);
      if (latest.pairingOpenUntil !== window.closesAt) return finish('  Pairing was closed on this computer.', false);
      if (latest.pin !== shownPin) {
        shownPin = latest.pin;
        print(newPinText(latest.pin, Math.max(0, Math.ceil(((latest.pinGuard?.lockedUntil ?? 0) - Date.now()) / 1000))));
      }
    });
    for (const signal of CLOSING_SIGNALS) process.once(signal, interrupted);
    // Shown only once a signal closes it again.
    print(shown);
  });
}
