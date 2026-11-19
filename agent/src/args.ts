export type CliCommand =
  | { kind: 'run'; port?: number; dryRun: boolean }
  | { kind: 'pair'; port?: number }
  | { kind: 'devices'; revokeAll: boolean }
  | { kind: 'autostart'; enable: boolean }
  /** folder: undefined shows the current one, null clears it. */
  | { kind: 'team-folder'; folder?: string | null }
  | { kind: 'help' }
  | { kind: 'version' };

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): CliCommand {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };
  const [command, ...rest] = args;
  switch (command) {
    case 'pair': {
      const options = parseRunArgs(rest);
      if (options.kind !== 'run' || options.dryRun) throw new UsageError('Use: authdeck-agent pair [--port <n>]');
      return { kind: 'pair', port: options.port };
    }
    case 'pin':
      throw new UsageError('A PIN now lasts one pairing window. Run "authdeck-agent pair" to show a new PIN and QR code.');
    case 'devices':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--revoke-all')) throw new UsageError('Use: authdeck-agent devices [--revoke-all]');
      return { kind: 'devices', revokeAll: rest[0] === '--revoke-all' };
    case 'autostart':
      if (rest.length !== 1 || (rest[0] !== 'enable' && rest[0] !== 'disable')) throw new UsageError('Use: authdeck-agent autostart enable|disable');
      return { kind: 'autostart', enable: rest[0] === 'enable' };
    case 'team-folder':
      if (rest.length > 1) throw new UsageError('Use: authdeck-agent team-folder [<path> | --clear]');
      if (rest.length === 0) return { kind: 'team-folder' };
      return { kind: 'team-folder', folder: rest[0] === '--clear' ? null : rest[0]! };
    default:
      return parseRunArgs(args);
  }
}

function parseRunArgs(args: string[]): CliCommand {
  let port: number | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.includes('=') ? arg.slice('--port='.length) : args[++i];
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`"${value ?? ''}" is not a port number (1-65535).`);
    } else throw new UsageError(`Unknown option "${arg}". Run authdeck-agent --help.`);
  }
  return { kind: 'run', port, dryRun };
}
