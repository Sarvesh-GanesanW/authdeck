import { powerShellEmitJson, runPowerShellJson } from '../platform/powershell';
import type { InstalledApp } from './types';

const SCAN_TIMEOUT_MS = 60_000;

/** Start Menu links whose name says they are not an app to launch. */
// Embedded in a single-quoted PowerShell string, so its apostrophe is doubled.
const SKIP_NAME_PATTERN = "(?i)\\b(uninstall|uninstaller|remove|readme|read me|help|documentation|manual|license|licence|release notes|changelog|what''s new)\\b";
/** Link targets that are documents rather than programs. */
const SKIP_TARGET_EXT_PATTERN = '(?i)^\\.(txt|html?|pdf|chm|url|rtf|md|log)$';

/** One PowerShell run that lists Start Menu links (with resolved targets) and packaged Store apps. */
export function windowsScanScript(): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$lnks = New-Object System.Collections.Generic.List[object]
$roots = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))
foreach ($root in $roots) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
  foreach ($file in (Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -File)) {
    $name = [IO.Path]::GetFileNameWithoutExtension($file.Name)
    if ($name -match '${SKIP_NAME_PATTERN}') { continue }
    $target = ''
    try { $target = [string]$shell.CreateShortcut($file.FullName).TargetPath } catch { $target = '' }
    if ($target) {
      if ([IO.Path]::GetFileName($target) -match '(?i)^(unins|uninstall)') { continue }
      if ([IO.Path]::GetExtension($target) -match '${SKIP_TARGET_EXT_PATTERN}') { continue }
      if (Test-Path -LiteralPath $target -PathType Container) { continue }
    }
    $lnks.Add([pscustomobject]@{ path = $file.FullName; name = $name; target = $target })
  }
}
$packaged = New-Object System.Collections.Generic.List[object]
if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
  foreach ($app in (Get-StartApps)) {
    if ($app.AppID -like '*!*') { $packaged.Add([pscustomobject]@{ name = [string]$app.Name; appId = [string]$app.AppID }) }
  }
}
${powerShellEmitJson('@{ lnks = $lnks.ToArray(); packaged = $packaged.ToArray() }')}
`;
}

interface ScanOutput {
  lnks?: { path: string; name: string; target: string | null }[] | null;
  packaged?: { name: string; appId: string }[] | null;
}

/** Turns the scan output into apps: links deduplicated by name+target, Store apps hidden when a link has the same name. */
export function windowsAppsFromScan(output: ScanOutput): InstalledApp[] {
  const apps: InstalledApp[] = [];
  const seenLinks = new Set<string>();
  const linkNames = new Set<string>();
  for (const lnk of output.lnks ?? []) {
    const target = lnk.target ?? '';
    const key = `${lnk.name.toLowerCase()}|${target.toLowerCase()}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    linkNames.add(lnk.name.toLowerCase());
    apps.push({
      platform: 'windows',
      kind: 'lnk',
      entry: { id: `win:lnk:${lnk.path}`, name: lnk.name, detail: target || lnk.path, hasIcon: true },
      lnkPath: lnk.path,
      targetPath: target,
    });
  }
  const seenAumids = new Set<string>();
  for (const pkg of output.packaged ?? []) {
    if (!pkg.appId || seenAumids.has(pkg.appId) || linkNames.has(pkg.name.toLowerCase())) continue;
    seenAumids.add(pkg.appId);
    apps.push({
      platform: 'windows',
      kind: 'aumid',
      entry: { id: `win:aumid:${pkg.appId}`, name: pkg.name, detail: pkg.appId, hasIcon: true },
      aumid: pkg.appId,
    });
  }
  return apps;
}

export async function scanWindowsApps(): Promise<InstalledApp[]> {
  return windowsAppsFromScan((await runPowerShellJson(windowsScanScript(), SCAN_TIMEOUT_MS)) as ScanOutput);
}
