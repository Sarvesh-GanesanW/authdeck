/** Reading and writing .env files: the dialect parseDotenv reads, and exact round trips. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { formatDotenv, formatDotenvLine, NO_EQUALS_NAME, parseDotenv, unportableDotenvValue } from '../../src/envcli/dotenv';
import type { EnvPlainValue } from '../../src/envcore/types';

function values(text: string): Record<string, string> {
  const read = parseDotenv(text);
  assert.ok(read.ok, JSON.stringify(read));
  return Object.fromEntries(read.values.map(({ name, value }) => [name, value]));
}

describe('parseDotenv', () => {
  it('reads plain lines, export prefixes, comments and blank lines', () => {
    const text = '# comment\n\nexport A=1\nB = two words  \n  export   C=3\n# D=hidden\nlower_case=ok\n';
    assert.deepEqual(values(text), { A: '1', B: 'two words', C: '3', lower_case: 'ok' });
  });

  it('ends an unquoted value at a # after whitespace, but keeps a # inside it', () => {
    assert.deepEqual(values('URL=https://x.dev/a#frag # the url\nEMPTY=\nNOTE= # only a comment\nHASH=#start\n'), {
      URL: 'https://x.dev/a#frag',
      EMPTY: '',
      NOTE: '',
      HASH: '#start',
    });
  });

  it('keeps single and backtick quotes literal, and lets them span lines', () => {
    assert.deepEqual(values("A='a \\n $HOME \"b\"'\nB=`x 'y'`\nKEY='-----BEGIN-----\nabc\n-----END-----'\n"), {
      A: 'a \\n $HOME "b"',
      B: "x 'y'",
      KEY: '-----BEGIN-----\nabc\n-----END-----',
    });
  });

  it('understands escapes in double quotes and keeps unknown ones as written', () => {
    assert.deepEqual(values('A="line1\\nline2\\ttab \\"q\\" back\\\\slash \\d $X"\n'), { A: 'line1\nline2\ttab "q" back\\slash \\d $X' });
  });

  it('reads multi-line double-quoted values and comments after a closing quote', () => {
    assert.deepEqual(values('PEM="-----BEGIN KEY-----\nMIIB\n-----END KEY-----" # the key\nNEXT=1\n'), { PEM: '-----BEGIN KEY-----\nMIIB\n-----END KEY-----', NEXT: '1' });
  });

  it('reads CRLF files and a byte-order mark', () => {
    assert.deepEqual(values('\uFEFFA=1\r\nB="x"\r\n'), { A: '1', B: 'x' });
  });

  it('keeps the last value of a name given twice, in its first place', () => {
    const read = parseDotenv('A=1\nB=2\nA=3\n');
    assert.ok(read.ok);
    assert.deepEqual(read.values, [
      { name: 'A', value: '3' },
      { name: 'B', value: '2' },
    ]);
  });

  it('refuses a name outside the contract pattern, naming its line', () => {
    assert.deepEqual(parseDotenv('A=1\n1BAD=x\n'), { ok: false, problem: { kind: 'bad-name', line: 2, name: '1BAD' } });
    assert.deepEqual(parseDotenv('MY-VAR=x\n'), { ok: false, problem: { kind: 'bad-name', line: 1, name: 'MY-VAR' } });
  });

  it('never echoes a line without "=" (it may be a pasted secret)', () => {
    assert.deepEqual(parseDotenv('A=1\nsk_live_123secret\n'), { ok: false, problem: { kind: 'bad-name', line: 2, name: NO_EQUALS_NAME } });
  });

  it('refuses an unclosed quote and text after a closing quote', () => {
    assert.deepEqual(parseDotenv('A=1\nB="never closes\nC=3\n'), { ok: false, problem: { kind: 'unclosed-quote', line: 2, name: 'B', quote: '"' } });
    assert.deepEqual(parseDotenv("A='x' trailing\n"), { ok: false, problem: { kind: 'after-quote', line: 1, name: 'A' } });
    assert.deepEqual(parseDotenv('A="x\ny" z\n'), { ok: false, problem: { kind: 'after-quote', line: 2, name: 'A' } });
  });
});

describe('formatDotenv round trip', () => {
  const tricky: EnvPlainValue[] = [
    { name: 'PLAIN', value: 'abc123' },
    { name: 'EMPTY', value: '' },
    { name: 'URL', value: 'postgres://u:p@db:5432/app?ssl=true' },
    { name: 'SPACES', value: '  padded value  ' },
    { name: 'HASH', value: 'a #b' },
    { name: 'SINGLE', value: "it's" },
    { name: 'DOUBLE', value: 'say "hi"' },
    { name: 'BOTH', value: `'"mixed"'` },
    { name: 'BACKSLASH', value: 'C:\\path\\n\\to' },
    { name: 'DOLLAR', value: '$HOME and ${X}' },
    { name: 'PEM', value: '-----BEGIN KEY-----\nMIIBIjAN\n-----END KEY-----\n' },
    { name: 'CRLF', value: 'a\r\nb' },
    { name: 'TAB', value: 'a\tb' },
    { name: 'UNICODE', value: 'héllo · 世界 🎉' },
    { name: 'EQUALS', value: 'a=b=c' },
    { name: 'BACKTICK', value: '`cmd`' },
    { name: 'LEADING_QUOTE', value: '"unbalanced' },
    { name: 'TRAILING_BACKSLASH', value: 'ends\\' },
    { name: 'export_like', value: 'export X=1' },
  ];

  it('reads back every tricky value exactly, in order', () => {
    const read = parseDotenv(formatDotenv(tricky, ['Written by a test.']));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.values, tricky);
  });

  it('reads back random values exactly', () => {
    const alphabet = 'aZ09 _-=#"\'`\\$\n\r\t.:/@é世';
    for (let round = 0; round < 300; round++) {
      const bytes = randomBytes(40);
      const value = [...bytes].slice(0, bytes[0]! % 40).map((b) => alphabet[b % alphabet.length]).join('');
      const one = [{ name: `V${round}`, value }];
      const read = parseDotenv(formatDotenv(one));
      assert.ok(read.ok, JSON.stringify({ value, read }));
      assert.deepEqual(read.values, one, JSON.stringify(value));
    }
  });

  it('writes plain values bare, and quotes only what needs it', () => {
    assert.equal(formatDotenvLine({ name: 'A', value: 'abc' }), 'A=abc');
    assert.equal(formatDotenvLine({ name: 'A', value: 'a b' }), "A='a b'");
    assert.equal(formatDotenvLine({ name: 'A', value: 'a\nb $X' }), "A='a\nb $X'");
    assert.equal(formatDotenvLine({ name: 'A', value: "it's\nx" }), 'A="it\'s\nx"');
    assert.equal(formatDotenvLine({ name: 'A', value: "it's $(x) `y` \\" }), 'A="it\'s \\$(x) \\`y\\` \\\\"');
    assert.equal(formatDotenvLine({ name: 'A', value: "it's\r\nx\ry" }), 'A="it\'s\\r\nx\ry"');
  });

  it('reads \\$ and \\` in double quotes as a shell does', () => {
    assert.deepEqual(values('A="\\$HOME \\`x\\`"\n'), { A: '$HOME `x`' });
  });

  it('writes nothing for no values and no header', () => {
    assert.equal(formatDotenv([]), '');
  });
});

describe('a shell sourcing the written file', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-shell-')));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'ran');

  /** Each value as `set -a; . ./.env; set +a` leaves it, read back through the shell. */
  function sourced(values: EnvPlainValue[]): EnvPlainValue[] {
    fs.writeFileSync(path.join(dir, '.env'), formatDotenv(values));
    const script = `set -a; . ./.env; set +a; ${values.map(({ name }) => `printf '%s\\0' "$${name}"`).join('; ')}`;
    const out = execFileSync('/bin/sh', ['-c', script], { cwd: dir, encoding: 'utf8' }).split('\0');
    return values.map(({ name }, index) => ({ name, value: out[index]! }));
  }

  it('never runs a value as a command, and reads every one back exactly', () => {
    const attacks = [`it's $(touch ${marker})`, `it's \`touch ${marker}\``, `$(touch ${marker})`, `\`touch ${marker}\``, `it's \\"; touch ${marker}; "`, `'; touch ${marker}; '`];
    const tricky = [
      ...attacks.map((value, i) => ({ name: `ATTACK${i}`, value })),
      { name: 'PEM', value: 'a\nb\n' },
      { name: 'MIXED', value: `it's "q"\nnext` },
      { name: 'LITERAL', value: '$HOME `x` \\n' },
    ];
    assert.deepEqual(sourced(tricky), tricky);
    assert.equal(fs.existsSync(marker), false, 'a value ran as a command');
  });

  it('reads back random values exactly, apart from a carriage return before a line break', () => {
    const alphabet = 'aZ09 _-=#"\'`\\$()\n\r\t;|&<>*?~!{}é';
    for (let round = 0; round < 40; round++) {
      const batch = Array.from({ length: 10 }, (_, i) => {
        const bytes = randomBytes(30);
        const value = [...bytes].slice(0, bytes[0]! % 30).map((b) => alphabet[b % alphabet.length]).join('');
        return { name: `V${i}`, value: value.replace(/\r+(?=\n)/g, '') };
      });
      assert.deepEqual(sourced(batch), batch);
    }
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('unportableDotenvValue', () => {
  it("accepts values without a ', and values with one but no $, ` or \\", () => {
    for (const value of ['$(x) `y` \\', "it's", "it's \"q\"\nx", 'a\rb']) assert.equal(unportableDotenvValue(value), null, value);
  });

  it("names why a ' with $, ` or \\ can't be written the same for every reader", () => {
    for (const value of ["it's $(x)", "it's `x`", "it's C:\\x"]) assert.equal(unportableDotenvValue(value), "it has a ' together with $, ` or \\", value);
    for (const value of ['a\r\n$b', 'line1\r\nline2']) assert.equal(unportableDotenvValue(value), 'it has a carriage return before a line break', value);
  });
});
