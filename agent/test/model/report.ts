/**
 * Turns a minimised counterexample into a readable story and a standalone PoC script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VaultState } from '../../src/vault/index';
import { loadReplay, ModelContext, type ReplayFn } from './context';
import { checkWorld, INVARIANTS, type Violation } from './invariants';
import { clockViolations, type Counterexample } from './search';
import { applyOp, FILL_LINES, FLOOD_LINES, folderView, labelOfId, newWorld, stateOf, type Line, type Op, type World } from './world';

const MODEL_DIR = fileURLToPath(new URL('.', import.meta.url));

function lineName(line: Line): string {
  return `${line.label}#${line.seq} ${line.entry.kind}${line.subject ? ` ${line.subject}` : ''}`;
}

function seenText(world: World, line: Line): string {
  const refs = Object.entries(line.entry.seen).map(([id, ref]) => {
    const label = labelOfId(world, id);
    const named = world.lines[label]?.[ref.seq];
    return named ? lineName(named) : `${label}#${ref.seq}`;
  });
  return refs.length > 0 ? refs.join(', ') : 'nothing of other devices';
}

function timing(op: { pull?: boolean; push?: boolean }): string {
  return `${op.pull ? 'after syncing' : 'on the copy it already had'}, ${op.push ? 'sent to the folder at once' : 'kept unsent for now'}`;
}

function cutText(cut: Record<string, number>): string {
  const parts = Object.entries(cut)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}#0..${n - 1}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export function describeOp(before: World, op: Op): string {
  const thief = before.config.thief;
  switch (op.t) {
    case 'add':
      return `${op.by} approves the new device ${op.device}${before.config.kind === 'team' ? ` as ${op.role === 'member' ? 'a plain member' : 'an admin'}` : ''} (online: it syncs first and sends at once); ${op.device} reads the folder and writes its hello.`;
    case 'reapprove':
      return `${op.by} approves ${op.device} again (same keys), because a rotation left ${op.device} without the current key.`;
    case 'remove':
      return `${op.by} removes ${op.target} (${timing(op)}).`;
    case 'recoverySet':
      return `${op.by} sets a new recovery phrase, ${op.recovery} (${timing(op)}).`;
    case 'rotate':
      return `${op.by} writes a fresh key because its copy says the vault needs one (${timing(op)}).`;
    case 'put':
      return `${op.by} ${op.remake ? 'writes account' : 'adds account'} ${op.account}${op.remake ? ' again (the app remakes a rejected change)' : ''} (${timing(op)}).`;
    case 'delete':
      return `${op.by} deletes account ${op.account} (${timing(op)}).`;
    case 'restore':
      return `The owner restores with the current recovery phrase: the recovery identity approves the new device ${op.device}, which writes its hello.`;
    case 'sync':
      return `${op.device} syncs: it sends its unsent lines${before.config.agent ? ' (through the agent)' : ''}, reads the folder${Object.keys(before.copies[op.device] ?? {}).length > 0 ? ', publishes any fork proof it finds' : ''}${before.config.beacons ? ' and signs a beacon' : ''}.`;
    case 'attack': {
      const who = op.as && !op.as.startsWith('RX') ? `The thief's puppet ${op.as}` : `The thief (${thief}, ${before.config.kind === 'team' ? 'a malicious device of the team' : 'stolen with its keys'})`;
      if (op.kind === 'beacon') return `${who} writes a lying head beacon: a newer epoch and a line of ${op.target} the folder doesn't have.`;
      if (op.kind === 'forkProof') return `${op.as ? `The thief's own recovery phrase ${op.as}` : who} signs a second version of its own line #${op.forkAt} and publishes the pair as a fork proof (vault.forks.write); the folder keeps the first version.`;
      if (op.kind === 'flood') return `${who} signs ${FLOOD_LINES} account.puts in a row (filling its quota) and ${op.publish ? (op.direct ? 'writes them straight into the folder' : 'sends them') : 'withholds them'}.`;
      const send = op.publish ? (before.config.agent && !op.direct ? 'sends it through the honest agent' : 'writes it straight into the folder') : 'withholds it';
      if (op.kind === 'plantKey') return `${who} sees ${op.target}'s join request and signs an approval of ${op.target} with its real signing and sealing keys, but seals to it a key that is not the vault key, dated early so it sorts first; it ${send}.`;
      if (op.kind === 'garbageSig') return `A folder writer (the thief) puts in ${thief}'s log ${op.fork ? 'in place of its last sent line ' : ''}an account.put with a garbage signature, then an account.put validly signed by ${thief} chained on it; it ${send}.`;
      if (op.kind === 'fillReserve') return `${who} signs ${FILL_LINES} key.rotates in a row (filling its reserve and the vault's) and ${op.publish ? 'sends them' : 'withholds them'}.`;
      if (op.kind === 'badSeal') return `${who} signs ${op.sealAs === 'recoverySet' ? 'a recovery.set with its own phrase' : 'a key.rotate'} whose keyCheck is right but whose key sealed to ${op.victims === 'recovery' ? 'the recovery identity' : 'every other recipient (the recovery identity included)'} is another key; it ${send}.`;
      if (op.kind === 'reencode') return `A folder writer rewrites ${op.target}'s published lines with whitespace (the same signed entries, other bytes).`;
      if (op.kind === 'squat') return `${who} sees ${op.target}'s join request and signs an approval of ${op.target} with ${op.target}'s signing key but its own sealing key, dated early, before any honest approval; it ${before.config.agent ? 'sends it through the honest agent' : 'writes it straight into the folder'}.`;
      const what =
        op.kind === 'remove'
          ? `a removal of ${op.target}`
          : op.kind === 'recoverySet'
            ? 'a recovery.set with its own phrase'
            : op.kind === 'rotate'
              ? 'a key.rotate'
              : op.kind === 'put'
                ? 'an account.put'
                : op.kind === 'slander'
                  ? `an account.put whose seen names a hash ${op.target}'s log doesn't have (${op.slander === 'pastEnd' ? 'past its end' : op.slander === 'ownFork' ? "the thief's own second version from its fork proof" : 'at a seq it has'})`
                  : op.as ? `an approval of its own puppet device, signed with its recovery phrase ${op.as}` : 'an approval of its own puppet device';
      const how = before.config.agent ? 'sends it through the honest agent' : 'writes it straight into the folder';
      const fork = op.fork ? ' at the seq of its last sent line (a second line there: a fork; devices that read the first keep it)' : '';
      return `${who} signs ${what}${fork} on a copy holding ${cutText(op.cut)}, naming the ${op.seenMode} heads in seen${op.grind ? ', its hash ground below every other key change' : ''}; ${op.publish ? `it ${how} (with any lines it held back)` : 'it withholds it'}.`;
    }
    case 'release':
      return 'The thief releases its withheld lines into the folder.';
  }
}

function folderLines(world: World, state: VaultState): string[] {
  const out: string[] = [];
  const items = state.history;
  for (const label of Object.keys(world.lines).sort()) {
    for (const line of world.lines[label]!) {
      if (line.seq >= (world.published[label] ?? 0)) {
        out.push(`- ${lineName(line)}: not in the folder (unsent)`);
        continue;
      }
      const item = items.find((h) => h.hash === line.hash);
      const who = line.honest ? '' : line.slander ? ' [thief, slander]' : ' [thief]';
      out.push(`- ${lineName(line)}${who}: ${item ? `${item.status}${item.reason ? ` (${item.reason})` : ''}` : 'not read (no applied entry introduces its author)'}`);
    }
  }
  return out;
}

function summary(world: World, state: VaultState): string {
  const members = Object.values(state.members)
    .map((m) => `${labelOfId(world, m.deviceId)}${world.config.kind === 'team' ? ` ${m.role}` : ''}${m.removed ? ' (removed)' : ''}`)
    .join(', ');
  const holders = Object.keys(state.sealedKeys[state.epoch] ?? {})
    .map((id) => labelOfId(world, id))
    .join(', ');
  const recovery = state.recovery ? labelOfId(world, state.recovery.deviceId) : 'none';
  const forked = Object.entries(state.forked).map(([id, seq]) => `${labelOfId(world, id)}@${seq}`);
  return `${forked.length > 0 ? `forked: ${forked.join(', ')}; ` : ''}members: ${members}; epoch ${state.epoch} key sealed to: ${holders || 'nobody'}; recovery: ${recovery}; needs a fresh key: ${state.needsFreshKey}`;
}

/** Replays a counterexample step by step, returning each step's description and the final world. */
function replaySteps(ctx: ModelContext, example: Counterexample): { steps: string[]; world: World | null } {
  let world: World | null = newWorld(ctx, example.config);
  const steps: string[] = [];
  for (const op of example.ops) {
    const before: World = world!;
    world = applyOp(before, op);
    if (!world) {
      steps.push(`(this step can no longer happen on the current rules: ${describeOp(before, op)})`);
      return { steps, world: null };
    }
    const signed = Object.values(world.lines)
      .flat()
      .filter((l) => l.step === world!.trace.length - 1);
    const lines = signed.map((l) => `   - signs ${lineName(l)}; it had seen: ${seenText(world!, l)}`);
    steps.push([describeOp(before, op), ...lines].join('\n'));
  }
  return { steps, world };
}

function hasAttack(example: Counterexample): boolean {
  return example.ops.some((op) => op.t === 'attack');
}

function devicesText(example: Counterexample, world: World): string {
  // Without a thief op the scenario is honest-only, whichever device the search would have stolen.
  const thief = hasAttack(example) ? example.config.thief : null;
  const lines = world.devices.map((d) => `- ${d}: ${d === 'F' ? 'the founder phone' : 'a device approved later'}${d === thief ? ', later stolen: the thief keeps its keys and its copy' : ', honest'}`);
  for (const [device, logs] of Object.entries(world.copies)) for (const [log, own] of Object.entries(logs)) lines.push(`- ${device} keeps its own copy of ${log}'s log (${own.length} lines; the version it read before the fork)`);
  for (const p of world.puppets) lines.push(`- ${p}: a device the thief approved for itself`);
  for (const r of world.recoveries) lines.push(`- ${r.label}: a recovery identity (${r.honest ? 'the owner\'s phrase' : 'the thief\'s phrase'})`);
  return lines.join('\n');
}

export function storyOf(example: Counterexample, replay?: ReplayFn, pocPath?: string): string {
  const ctx = new ModelContext(example.seed, replay);
  const { steps, world } = replaySteps(ctx, example);
  const v = example.violation;
  const head = [
    `# Invariant ${v.invariant} violated: ${v.summary}`,
    '',
    `**Invariant ${v.invariant}.** ${INVARIANTS[v.invariant]}`,
    '',
    pocPath ? `**Run it:** \`cd ~/code/devdeck/agent && node --import tsx ${pocPath}\`` : '',
    '',
    `${example.config.kind === 'team' ? 'Team' : 'Personal'} vault, every line ${example.config.agent ? 'goes through an honest agent (planAppend)' : 'is written straight into the folder'}${example.config.quota ? ', agent caps at model scale (test/model/quota.ts)' : ''}${example.config.beacons ? ', head beacons on' : ''}, clock policy \`${example.config.clock}\`, key seed \`${example.seed}\`. Minimised from a ${example.originalSteps}-step scenario to ${example.ops.length} steps.`,
    '',
  ];
  if (!world) return [...head, '## Steps', '', ...steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');
  const state = stateOf(world, folderView(world));
  return [
    ...head,
    '## Devices',
    '',
    devicesText(example, world),
    '',
    '## What happened, in order',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## The folder at the end, as replayVault decides it',
    '',
    ...folderLines(world, state),
    '',
    `State: ${summary(world, state)}`,
    '',
    '## Expected versus got',
    '',
    `- **Expected:** ${v.expected}`,
    `- **Got:** ${v.got}`,
    '',
  ].join('\n');
}

function pocScript(example: Counterexample, name: string): string {
  const report = join(MODEL_DIR, 'report.ts');
  return [
    `// Counterexample ${name}: invariant ${example.violation.invariant}. ${example.violation.summary}.`,
    '// Built by the vault model checker (agent/test/model). It signs every entry with the real builders',
    '// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).',
    `// Run: cd ~/code/devdeck/agent && node --import tsx ${name}.ts`,
    '// Prints the story and VIOLATED while the invariant still fails on the current rules.',
    `import { runCounterexample } from '${report}';`,
    '',
    `const example = ${JSON.stringify(example, null, 2)};`,
    '',
    'process.exitCode = (await runCounterexample(example)) ? 1 : 0;',
    '',
  ].join('\n');
}

/** Writes each counterexample as `<name>.md` (story) and `<name>.ts` (PoC). Returns the paths. */
export function writeCounterexamples(examples: Counterexample[], dir: string, replay?: ReplayFn): string[] {
  mkdirSync(dir, { recursive: true });
  // The PoCs use top-level await, so the folder is an ES module package.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  const paths: string[] = [];
  const perInvariant: Record<number, number> = {};
  for (const example of examples) {
    const n = (perInvariant[example.violation.invariant] = (perInvariant[example.violation.invariant] ?? 0) + 1);
    const name = `inv${example.violation.invariant}-${n}-${hasAttack(example) ? `thief-${example.config.thief}` : 'honest'}`;
    const poc = join(dir, `${name}.ts`);
    writeFileSync(poc, pocScript(example, join(dir, name)));
    writeFileSync(join(dir, `${name}.md`), storyOf(example, replay, poc));
    paths.push(join(dir, `${name}.md`));
  }
  return paths;
}

/** Replays a counterexample, prints its story and whether the invariant still fails. */
export async function runCounterexample(example: Counterexample): Promise<boolean> {
  const modulePath = process.env.VAULT_REPLAY_MODULE;
  const replay = modulePath ? await loadReplay(modulePath) : undefined;
  console.log(storyOf(example, replay));
  const ctx = new ModelContext(example.seed, replay);
  let world: World | null = newWorld(ctx, example.config);
  for (const op of example.ops) world = world && applyOp(world, op);
  if (!world) {
    console.log('HOLDS: the scenario can no longer be built on the current rules.');
    return false;
  }
  const violations = [...checkWorld(world), ...(example.violation.invariant === 5 ? clockViolations(ctx, world) : [])];
  const hit: Violation | undefined = violations.find((v) => v.invariant === example.violation.invariant);
  console.log(hit ? `VIOLATED  invariant ${hit.invariant}: ${hit.summary}\n  expected: ${hit.expected}\n  got:      ${hit.got}` : `HOLDS: invariant ${example.violation.invariant} is no longer violated here.`);
  return hit !== undefined;
}
