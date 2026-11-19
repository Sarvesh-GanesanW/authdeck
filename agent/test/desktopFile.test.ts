import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeDesktopValue, expandExecArgs, localized, parseDesktopEntry, quoteExecArg, splitList, tokenizeExec } from '../src/apps/desktopFile';

describe('.desktop parsing', () => {
  it('reads only the [Desktop Entry] group and decodes escapes', () => {
    const fields = parseDesktopEntry('# c\n[Desktop Entry]\nName=A\\sB\nExec=x\n[Desktop Action new]\nName=Other\nExec=y\n');
    assert.equal(fields.get('Name'), 'A B');
    assert.equal(fields.get('Exec'), 'x');
  });

  it('picks localised values by LANG', () => {
    const fields = parseDesktopEntry('[Desktop Entry]\nName=Files\nName[de]=Dateien\nName[pt_BR]=Arquivos\n');
    assert.equal(localized(fields, 'Name', 'de_DE.UTF-8'), 'Dateien');
    assert.equal(localized(fields, 'Name', 'pt_BR.UTF-8'), 'Arquivos');
    assert.equal(localized(fields, 'Name', 'fr_FR.UTF-8'), 'Files');
    assert.equal(localized(fields, 'Name', undefined), 'Files');
  });

  it('splits lists, honouring escaped semicolons', () => {
    assert.deepEqual(splitList('GNOME;Unity;'), ['GNOME', 'Unity']);
    assert.deepEqual(splitList('a\\;b;c'), ['a;b', 'c']);
    assert.deepEqual(splitList(undefined), []);
  });
});

describe('Exec lines', () => {
  it('tokenizes quoted arguments with the spec escapes', () => {
    assert.deepEqual(tokenizeExec('"/opt/My App/run" --flag "a \\"q\\" \\$HOME \\\\ \\`x\\`" %U'), ['/opt/My App/run', '--flag', 'a "q" $HOME \\ `x`', '%U']);
    assert.deepEqual(tokenizeExec("sh -c 'echo hi; sleep 1'"), ['sh', '-c', 'echo hi; sleep 1']);
    assert.deepEqual(tokenizeExec('a  ""  b'), ['a', '', 'b']);
  });

  it('strips field codes when launching', () => {
    assert.deepEqual(expandExecArgs(tokenizeExec('code --unity-launch %F')), ['code', '--unity-launch']);
    assert.deepEqual(expandExecArgs(tokenizeExec('app %u %i %c %k --x')), ['app', '--x']);
    assert.deepEqual(expandExecArgs(['app', '--file=%f', '100%%']), ['app', '--file=', '100%']);
  });

  it('puts the file where the file code is, or appends it', () => {
    assert.deepEqual(expandExecArgs(tokenizeExec('code %F'), '/a b'), ['code', '/a b']);
    assert.deepEqual(expandExecArgs(tokenizeExec('kate -b %U --x'), '/p'), ['kate', '-b', '/p', '--x']);
    assert.deepEqual(expandExecArgs(tokenizeExec('gedit'), '/p'), ['gedit', '/p']);
    assert.deepEqual(expandExecArgs(['app', '--open=%f'], '/p'), ['app', '--open=/p']);
  });

  it('quotes Exec arguments so the parser reads them back unchanged', () => {
    const awkward = ['/usr/bin/node', '/home/ada/My "Tools"/$HOME/`x`/back\\slash/100%/authdeck-agent.cjs'];
    const line = awkward.map(quoteExecArg).join(' ');
    // Written to the file with value escapes, then read back as a desktop file would be.
    const fields = parseDesktopEntry(`[Desktop Entry]\nExec=${encodeDesktopValue(line)}\n`);
    assert.deepEqual(expandExecArgs(tokenizeExec(fields.get('Exec')!)), awkward);
  });
});
