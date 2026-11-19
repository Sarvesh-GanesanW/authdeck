import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { windowsAppsFromScan, windowsScanScript } from '../src/apps/windows';
import { windowsIconScript } from '../src/icons/windows';
import { extractMarkedJson, powerShellJsonLiteral, powerShellStdin } from '../src/platform/powershell';
import { asciiJson, winHelperScript } from '../src/platform/winHelper';

function decodeStdin(stdin: string): string {
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(stdin);
  assert.ok(match, stdin);
  return Buffer.from(match[1]!, 'base64').toString('utf8');
}

describe('PowerShell plumbing', () => {
  it('sends the script as one base64 line, so nothing in it can be misparsed by -Command -', () => {
    const script = "Write-Output 'it''s'\nforeach ($x in 1..2) {\n  $x\n}\n";
    const stdin = powerShellStdin(script);
    assert.equal(stdin.split('\n').length, 2);
    assert.ok(stdin.endsWith('\n'));
    assert.equal(decodeStdin(stdin), script);
  });

  it('embeds data as base64 JSON, so quotes and $ in paths cannot escape the literal', () => {
    const hostile = { jobs: [{ path: "C:\\x'; Remove-Item -Recurse C:\\ ; '$(evil)" }] };
    const literal = powerShellJsonLiteral(hostile);
    assert.ok(!literal.includes('Remove-Item'));
    assert.match(literal, /^\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\) \| ConvertFrom-Json\)$/);
    assert.deepEqual(JSON.parse(decodeStdin(literal)), hostile);
  });

  it('extracts JSON between markers, ignoring other output', () => {
    assert.deepEqual(extractMarkedJson('WARNING: x\r\n<<AUTHDECK-JSON>>{"a":[1]}<<AUTHDECK-END>>\r\n'), { a: [1] });
    assert.throws(() => extractMarkedJson('no result'), /did not return/);
  });
});

describe('Windows app scan', () => {
  it('scans both Start Menu folders and Get-StartApps', () => {
    const script = windowsScanScript();
    assert.match(script, /GetFolderPath\('CommonPrograms'\)/);
    assert.match(script, /GetFolderPath\('Programs'\)/);
    assert.match(script, /CreateShortcut\(\$file\.FullName\)\.TargetPath/);
    assert.match(script, /Get-StartApps/);
    assert.match(script, /-like '\*!\*'/);
    // The skip pattern sits in a single-quoted PowerShell string: its apostrophe must be doubled.
    assert.match(script, /what''s new/);
  });

  it('turns scan output into apps, deduplicating links and preferring links over Store apps of the same name', () => {
    const apps = windowsAppsFromScan({
      lnks: [
        { path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Code.lnk', name: 'Visual Studio Code', target: 'C:\\VS\\Code.exe' },
        { path: 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Code.lnk', name: 'Visual Studio Code', target: 'c:\\vs\\code.exe' },
        { path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk', name: 'Word', target: '' },
      ],
      packaged: [
        { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
        { name: 'Word', appId: 'Microsoft.Office.Word!App' },
      ],
    });
    assert.deepEqual(
      apps.map((a) => a.entry.id),
      [
        'win:lnk:C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Code.lnk',
        'win:lnk:C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk',
        'win:aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
      ],
    );
    assert.equal(apps[0]!.platform === 'windows' && apps[0]!.kind === 'lnk' && apps[0]!.targetPath, 'C:\\VS\\Code.exe');
  });

  it('copes with empty or null lists from ConvertTo-Json', () => {
    assert.deepEqual(windowsAppsFromScan({ lnks: null, packaged: null }), []);
  });
});

describe('Windows icon and helper scripts', () => {
  it('icon script compiles the C# once and walks the jobs from an object', () => {
    const script = windowsIconScript([{ path: 'shell:AppsFolder\\A!App' }]);
    assert.match(script, /Add-Type -TypeDefinition \$source -ReferencedAssemblies System\.Drawing/);
    assert.match(script, /foreach \(\$job in \$request\.jobs\)/);
    assert.match(script, /IShellItemImageFactory/);
    assert.match(script, /ExtractAssociatedIcon/);
    // The C# here-string must not be closed early.
    assert.equal(script.match(/^'@/gm)?.length, 1);
  });

  it('helper script is ASCII (written without a BOM) and handles every op', () => {
    const script = winHelperScript();
    assert.ok(/^[\x00-\x7f]*$/.test(script), 'non-ASCII character in helper script');
    for (const op of ['keys', 'text', 'focus', 'foreground']) assert.match(script, new RegExp(`'${op}' \\{`));
    assert.match(script, /KEYEVENTF_UNICODE/);
    assert.match(script, /\[FieldOffset\(0\)\] public MOUSEINPUT mi/);
    assert.equal(script.match(/^'@/gm)?.length, 1);
  });

  it('asciiJson escapes non-ASCII so requests survive any console code page', () => {
    const line = asciiJson({ op: 'text', text: 'héllo 👋 "q"' });
    assert.ok(/^[\x20-\x7e]*$/.test(line));
    assert.deepEqual(JSON.parse(line), { op: 'text', text: 'héllo 👋 "q"' });
  });
});
