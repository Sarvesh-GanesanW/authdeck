import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { psQuote, shQuote, vbsQuote } from '../src/actions/quote';

const NASTY = [`it's`, `"double"`, '$HOME `whoami` $(id)', 'back\\slash', "''", 'new\nline', 'semi; rm -rf ~', '*?[a]', ''];

describe('quoting', () => {
  it('shQuote round-trips through a real shell', { skip: process.platform === 'win32' }, () => {
    for (const value of NASTY) {
      const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf8' });
      assert.equal(echoed, value);
    }
  });

  it('psQuote doubles single quotes, including typographic ones', () => {
    assert.equal(psQuote("it's"), "'it''s'");
    assert.equal(psQuote('a\u2019b'), "'a\u2019\u2019b'");
    assert.equal(psQuote('$env:PATH `n'), "'$env:PATH `n'");
  });

  it('vbsQuote doubles double quotes', () => {
    assert.equal(vbsQuote('"C:\\Program Files\\node.exe" "x"'), '"""C:\\Program Files\\node.exe"" ""x"""');
  });
});
