/** The set file as text: round trip, layout, and every shape problem parseEnvFile reports. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkEnvPlainValues,
  ENV_FILE_PREAMBLE,
  ENV_LIMITS,
  EnvFileRefused,
  envFileHash,
  envSetFilePath,
  parseEnvFile,
  writeEnvFile,
  type EnvFileProblem,
} from '../../src/envcore';
import { toBase64Url } from '../../src/vault/bytes';
import { sha256Bytes } from '../../src/vault/crypto';
import { device, editLine, lineNumber, makeSet, parsedOk } from './fixtures';

const set = makeSet();
const isValueLine = (line: string) => line.startsWith('DATABASE_URL=');

function problemOf(text: string): EnvFileProblem {
  const result = parseEnvFile(text);
  assert.equal(result.ok, false, 'expected the file to be refused');
  return (result as { problem: EnvFileProblem }).problem;
}

/** A value line for crafted files: parse checks shape, not signatures. */
function craftedValueLine(name: string, plainBytes: number | null): string {
  const meta = set.text.split('\n').find(isValueLine)!.split(' ; ')[1]!;
  if (plainBytes === null) return `${name}=deleted ; ${meta}`;
  const box = `enc:1:${toBase64Url(new Uint8Array(12))}.${toBase64Url(new Uint8Array(plainBytes + 16))}.${toBase64Url(new Uint8Array(32))}`;
  return `${name}=${box} ; ${meta}`;
}

/** A well-formed @authority line (parse checks shape; verify checks the chain). */
const AUTHORITY_LINE = (() => {
  const birth = set.text.split('\n').find((line) => line.startsWith('@birth '))!;
  const keys = birth.split(' ').slice(3, 7).join(' ');
  return `@authority 1 takeover time=1 prev=${toBase64Url(new Uint8Array(32))} ${keys}`;
})();

function withValueLines(lines: string[]): string {
  return set.text + lines.join('\n') + '\n';
}

describe('env file round trip', () => {
  it('parses what it writes into the same model, and writes it back byte for byte', () => {
    const parsed = parsedOk(set.text);
    assert.deepEqual(parsed.file, set.file);
    assert.equal(writeEnvFile(parsed.file), set.text);
    assert.equal(parsed.headerLine, 3);
    assert.deepEqual(parsed.valueLines, [8, 9, 10]);
  });

  it('starts with the preamble, then @set, @birth, @member, @recovery, @sig and the values, ending in a newline', () => {
    const lines = set.text.split('\n');
    assert.deepEqual(lines.slice(0, 2), [...ENV_FILE_PREAMBLE]);
    assert.match(lines[2]!, /^@set acme-api format=1 id=\S{22} rev=1 epoch=1 time=\d+$/);
    assert.match(lines[3]!, /^@birth time=\d+ nonce=\S{22} ed=\S{43} x=\S{43} recovery=\S{43}\.\S{43} sig=\S{86}$/);
    assert.match(lines[4]!, /^@member \S{22} owner form=phone since=\d+ ed=\S{43} x=\S{43} key=\S{43}\.\S{64} "Maya Rao · Pixel 8"$/);
    assert.match(lines[5]!, /^@recovery \S{22} ed=\S{43} x=\S{43} key=\S{43}\.\S{64}$/);
    assert.match(lines[6]!, /^@sig \S{22} \S{86}$/);
    assert.match(lines[7]!, /^DATABASE_URL=enc:1:\S{16}\.\S+\.\S{43} ; v1 \S{22} \d+ \S{86}$/);
    assert.ok(set.text.endsWith('\n'));
  });

  it('skips comments and blank lines, and reads a file without its final newline', () => {
    const text = set.text.replace('@sig', '# a note\n\n@sig');
    assert.deepEqual(parsedOk(text).file, set.file);
    assert.deepEqual(parsedOk(set.text.slice(0, -1)).file, set.file);
  });

  it('keeps a deleted variable as a tombstone and a member without a form', () => {
    const file = { ...set.file, values: [{ ...set.file.values[0]!, box: null }] };
    file.header = { ...file.header, members: [{ ...file.header.members[0]!, form: null }] };
    const text = writeEnvFile(file);
    assert.match(text, /^DATABASE_URL=deleted ; v1 /m);
    assert.match(text, / form=- /);
    assert.deepEqual(parsedOk(text).file, file);
  });

  it('quotes a label with quotes and backslashes and reads it back', () => {
    const member = { ...set.file.header.members[0]!, label: 'Maya "M" \\ Rao' };
    const file = { ...set.file, header: { ...set.file.header, members: [member] } };
    assert.equal(parsedOk(writeEnvFile(file)).file.header.members[0]!.label, 'Maya "M" \\ Rao');
  });

  it('hashes the file bytes as base64url SHA-256', () => {
    assert.equal(envFileHash(set.text), toBase64Url(sha256Bytes(new TextEncoder().encode(set.text))));
  });

  it('places a set at .authdeck/<name>.env and refuses names that are not file names', () => {
    assert.equal(envSetFilePath('acme-api'), '.authdeck/acme-api.env');
    assert.throws(() => envSetFilePath('../evil'));
    assert.throws(() => envSetFilePath('Acme'));
  });
});

describe('env file shape problems', () => {
  it('unreadable: a line that is not a value line, naming its line', () => {
    const text = withValueLines(['hello there']);
    assert.deepEqual(problemOf(text), { kind: 'unreadable', line: 11, detail: 'not a NAME=value line' });
  });

  it('unreadable: lines out of order, broken fields and Windows line ends', () => {
    const cases: [string, string][] = [
      [set.text.replace(/^@set .*\n/m, ''), 'expected the @set line first'],
      [set.text.replace(/^@sig .*\n/m, ''), 'expected @authority, @member, @recovery or @sig'],
      [set.text.replace(/^@birth .*\n/m, ''), 'expected the @birth line after @set'],
      [set.text.replace(/^(@birth .*\n)(@member .*\n)/m, '$2$1'), 'expected the @birth line after @set'],
      [set.text.replace(/^(@member .*\n)/m, `$1${AUTHORITY_LINE}\n`), '@authority after @member'],
      [set.text.replace(/^(@birth .*\n)/m, `$1${AUTHORITY_LINE.replace(' prev=', ' prev=A')}\n`), 'prev has the wrong length'],
      [set.text.replace(/^(@birth .*\n)/m, `$1${AUTHORITY_LINE.replace(' takeover ', ' handover ')}\n`), 'the change is neither takeover nor recovery'],
      [editLine(set.text, (l) => l.startsWith('@birth'), (l) => l.replace(/ recovery=\S+/, ' recovery=abc')), 'recovery= needs two keys or -'],
      [editLine(set.text, (l) => l.startsWith('@birth'), (l) => l.replace(/ nonce=\S+/, ` nonce=${toBase64Url(new Uint8Array(12))}`)), 'the nonce has the wrong length'],
      [editLine(set.text, (l) => l.startsWith('@set'), (l) => l.replace('rev=1', 'rev=01')), "rev isn't a whole number"],
      [editLine(set.text, (l) => l.startsWith('@set'), (l) => `${l} prev=-`), '@set has the wrong number of fields'],
      [editLine(set.text, (l) => l.startsWith('@set'), (l) => l.replace('epoch=1', 'epoch=0')), 'rev and epoch start at 1'],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace(' owner ', ' admin ')), 'the role is neither owner nor member'],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace('"Maya', 'Maya')), "the label isn't a quoted string"],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace('"Maya', '"\\u0007Maya')), 'the label has characters that are not allowed'],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace(/^@member \S+/, `@member ${device('other').deviceId}`)), "the id doesn't match its signing key"],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace(/ x=\S+/, ` x=${toBase64Url(new Uint8Array(32))}`)), "x isn't a usable sealing key"],
      [editLine(set.text, (l) => l.startsWith('@member'), (l) => l.replace(' owner ', ' member ')), 'the member list needs exactly one owner'],
      [editLine(set.text, isValueLine, (l) => l.replace(' ; v1 ', ' ; v0 ')), 'versions start at 1'],
      [editLine(set.text, isValueLine, (l) => l.replace('=enc:1:', '=plain:')), "the value isn't enc:<key>:<box> or deleted"],
      [editLine(set.text, isValueLine, (l) => l.replace(' ; ', ' ;; ')), 'expected one ";" after the value'],
      [editLine(set.text, isValueLine, (l) => l.slice(0, -2) + 'A_'), "the signature isn't base64url"],
      [withValueLines(['@member x']), 'a header line after @sig'],
      [set.text.replace('\n@sig', '\r\n@sig'), 'a Windows line end'],
      [ENV_FILE_PREAMBLE.join('\n') + '\n', 'no @set line'],
    ];
    for (const [text, detail] of cases) {
      const problem = problemOf(text);
      assert.equal(problem.kind, 'unreadable', `${detail}: got ${JSON.stringify(problem)}`);
      assert.equal((problem as { detail: string }).detail, detail);
    }
  });

  it('conflict-markers: git left a merge unfinished', () => {
    for (const marker of ['<<<<<<< HEAD', '=======', '>>>>>>> theirs', '||||||| base']) {
      const text = set.text.replace('DATABASE_URL=', `${marker}\nDATABASE_URL=`);
      assert.deepEqual(problemOf(text), { kind: 'conflict-markers', line: 8 });
    }
  });

  it('newer-format: a format above ENV_FORMAT, whatever else the line holds', () => {
    const text = editLine(set.text, (l) => l.startsWith('@set'), (l) => l.replace('format=1', 'format=2') + ' extra=1');
    assert.deepEqual(problemOf(text), { kind: 'newer-format', format: 2 });
  });

  it('bad-name and duplicate-name, at their line', () => {
    assert.deepEqual(problemOf(withValueLines([craftedValueLine('1BAD', 4)])), { kind: 'bad-name', line: 11, name: '1BAD' });
    assert.deepEqual(problemOf(withValueLines([craftedValueLine('MY VAR', 4)])), { kind: 'bad-name', line: 11, name: 'MY VAR' });
    assert.deepEqual(problemOf(withValueLines([craftedValueLine('PEM', 4)])), { kind: 'duplicate-name', line: 11, name: 'PEM' });
  });

  it('too-large: file, names, one value, all values, members', () => {
    const padding = `# ${'x'.repeat(1000)}\n`.repeat(Math.ceil(ENV_LIMITS.fileBytes / 1000));
    assert.deepEqual(problemOf(set.text + padding), { kind: 'too-large', limit: 'file' });

    const names = Array.from({ length: ENV_LIMITS.names - 2 }, (_, i) => craftedValueLine(`N${i}`, null));
    assert.deepEqual(problemOf(withValueLines(names)), { kind: 'too-large', limit: 'names' });
    assert.equal(parseEnvFile(withValueLines(names.slice(1))).ok, true, 'exactly at the cap is fine');

    assert.deepEqual(problemOf(withValueLines([craftedValueLine('BIG', ENV_LIMITS.valueBytes + 1)])), { kind: 'too-large', limit: 'value', name: 'BIG' });
    assert.equal(parseEnvFile(withValueLines([craftedValueLine('BIG', ENV_LIMITS.valueBytes)])).ok, true);

    const many = Array.from({ length: 5 }, (_, i) => craftedValueLine(`V${i}`, 30 * 1024));
    assert.deepEqual(problemOf(withValueLines(many)), { kind: 'too-large', limit: 'values' });

    const memberLine = set.text.split('\n')[4]!;
    const extra = Array.from({ length: ENV_LIMITS.members }, (_, i) => {
      const other = device(`member-${i}`);
      return memberLine
        .replace(/^@member \S+ owner/, `@member ${other.deviceId} member`)
        .replace(/ ed=\S+/, ` ed=${toBase64Url(other.edPublic)}`)
        .replace(/ x=\S+/, ` x=${toBase64Url(other.xPublic)}`);
    });
    const tooMany = set.text.replace('@recovery', `${extra.join('\n')}\n@recovery`);
    assert.deepEqual(problemOf(tooMany), { kind: 'too-large', limit: 'members' });
    assert.equal(lineNumber(tooMany, (l) => l.startsWith('@recovery')) > 0, true);
  });

  it('writeEnvFile refuses a model no reader would accept', () => {
    const line = set.file.values[0]!;
    const refuse = (values: typeof set.file.values) => {
      try {
        writeEnvFile({ ...set.file, values });
      } catch (err) {
        assert.ok(err instanceof EnvFileRefused);
        return err.problem;
      }
      assert.fail('expected EnvFileRefused');
    };
    assert.deepEqual(refuse([{ ...line, name: 'NO-DASH' }]), { kind: 'bad-name', line: 8, name: 'NO-DASH' });
    assert.deepEqual(refuse([line, line]), { kind: 'duplicate-name', line: 9, name: 'DATABASE_URL' });
    const names = Array.from({ length: ENV_LIMITS.names + 1 }, (_, i) => ({ ...line, name: `N${i}` }));
    assert.deepEqual(refuse(names), { kind: 'too-large', limit: 'names' });
  });
});

describe('plain value checks', () => {
  it('passes good values and names each problem', () => {
    assert.equal(checkEnvPlainValues([{ name: 'A', value: 'x' }, { name: 'lower_ok', value: '' }]), null);
    assert.deepEqual(checkEnvPlainValues([{ name: 'A', value: '' }, { name: '9A', value: '' }]), { kind: 'bad-name', line: 2, name: '9A' });
    assert.deepEqual(checkEnvPlainValues([{ name: 'A', value: '' }, { name: 'A', value: '' }]), { kind: 'duplicate-name', line: 2, name: 'A' });
    assert.deepEqual(checkEnvPlainValues([{ name: 'A', value: 'é'.repeat(ENV_LIMITS.valueBytes / 2 + 1) }]), { kind: 'too-large', limit: 'value', name: 'A' });
    assert.equal(checkEnvPlainValues([{ name: 'A', value: 'x'.repeat(ENV_LIMITS.valueBytes) }]), null);
    const total = Array.from({ length: 5 }, (_, i) => ({ name: `V${i}`, value: 'x'.repeat(30 * 1024) }));
    assert.deepEqual(checkEnvPlainValues(total), { kind: 'too-large', limit: 'values' });
    const names = Array.from({ length: ENV_LIMITS.names + 1 }, (_, i) => ({ name: `N${i}`, value: '' }));
    assert.deepEqual(checkEnvPlainValues(names), { kind: 'too-large', limit: 'names' });
    assert.equal(checkEnvPlainValues([{ name: 'N'.repeat(128), value: '' }]), null);
    assert.equal(checkEnvPlainValues([{ name: 'N'.repeat(129), value: '' }])?.kind, 'bad-name');
  });
});
