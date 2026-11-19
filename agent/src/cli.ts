import path from 'node:path';
import { AGENT_VERSION, startAgent } from './agent';
import { disableAutostart, enableAutostart } from './autostart';
import { carryOverLegacyHome, configPath, loadConfig, updateConfig, authdeckHome } from './config';
import { currentPlatform } from './host';
import { UsageError, parseArgs } from './args';
import { runPairCommand } from './pairCommand';
import { printableName } from './pairing';
import { vaultFeatures } from './vault/features';

const HELP = `AuthDeck agent ${AGENT_VERSION}: lets the AuthDeck tablet app control this computer.

Usage
  authdeck-agent [--port <n>] [--dry-run]   Start the agent (default port from config, 47474)
  authdeck-agent pair [--port <n>]          Open pairing for 10 minutes: shows a PIN and QR code here
  authdeck-agent devices                    List paired devices
  authdeck-agent devices --revoke-all       Unpair every device
  authdeck-agent autostart enable|disable   Start the agent when you sign in
${vaultFeatures.multiDevice ? '  authdeck-agent team-folder [<path>|--clear]  Show, set or clear the shared folder for team vaults\n' : ''}  authdeck-agent --help | --version

Options
  --port <n>   Listen on this port instead of the configured one
  --dry-run    Log the OS commands each action would run instead of running them

Settings live in ${configPath(authdeckHome())} (set AUTHDECK_HOME to use another folder).`;

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const copiedFrom = carryOverLegacyHome();
  const home = authdeckHome();
  if (copiedFrom) console.log(`Copied your settings and pairings from ${copiedFrom} to ${home}.`);
  switch (command.kind) {
    case 'help':
      console.log(HELP);
      return;
    case 'version':
      console.log(AGENT_VERSION);
      return;
    case 'pair':
      await runPairCommand(home, command.port, (text) => console.log(text));
      process.exit(0);
      return;
    case 'devices': {
      if (command.revokeAll) {
        let count = 0;
        updateConfig(home, (latest) => {
          count = latest.devices.length;
          latest.devices = [];
        });
        console.log(`Unpaired ${count} device(s). A running agent cuts them off now; they must pair again.`);
        return;
      }
      const config = loadConfig(home);
      if (config.devices.length === 0) console.log('No paired devices.');
      for (const d of config.devices) {
        const repair = d.linkKey ? '' : ', must pair again: the connection is now encrypted';
        console.log(`${printableName(d.deviceName)}  (paired ${d.pairedAt.slice(0, 10)}, last seen ${d.lastSeenAt.slice(0, 16).replace('T', ' ')}${repair})`);
      }
      return;
    }
    case 'autostart': {
      const platform = currentPlatform();
      if (command.enable) {
        const file = await enableAutostart(platform, home);
        console.log(`The agent will start when you sign in (${file}).`);
      } else {
        const file = await disableAutostart(platform);
        console.log(file ? `Autostart turned off (removed ${file}).` : 'Autostart was not on.');
      }
      return;
    }
    case 'team-folder': {
      // Team vaults are multi-device (0.4); 0.3.0 keeps solo vaults in the agent's own folder.
      if (!vaultFeatures.multiDevice) {
        console.log('Team vaults come in AuthDeck 0.4. This version keeps one solo vault per device, backed up in the agent\'s own folder.');
        return;
      }
      if (command.folder === undefined) {
        const { teamFolder } = loadConfig(home);
        console.log(teamFolder ? `Team vaults are in ${teamFolder}.` : 'No team folder is set.');
        return;
      }
      const folder = command.folder;
      const config = updateConfig(home, (latest) => {
        if (folder === null) delete latest.teamFolder;
        else latest.teamFolder = path.resolve(folder);
      });
      console.log(`${config.teamFolder ? `Team vaults will be kept in ${config.teamFolder}.` : 'Team folder cleared.'} Restart a running agent to use it.`);
      return;
    }
    case 'run': {
      const agent = await startAgent({ port: command.port, dryRun: command.dryRun });
      const shutdown = () => {
        void agent.stop().finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return;
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof UsageError ? err.message : `AuthDeck agent: ${(err as Error).message}`);
  process.exit(1);
});
