import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chineseEntry = join(project, '打开公众号工作台.cmd');
const compatibilityEntry = join(project, 'START-WORKBENCH.cmd');
const launcher = join(project, 'scripts', 'start-workbench.ps1');

async function withIsolatedLauncher(run) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-studio-launcher-'));
  const scriptDir = join(root, 'scripts');
  await mkdir(scriptDir, { recursive: true });
  const isolatedLauncher = join(scriptDir, 'start-workbench.ps1');
  await copyFile(launcher, isolatedLauncher);
  try {
    return await run({ root, isolatedLauncher });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runPowerShell(command, { env = {} } = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ...env },
      windowsHide: true,
    },
  );
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const windowsOnly = process.platform === 'win32' ? {} : { skip: 'Windows launcher tests require powershell.exe' };

test('Chinese entry delegates to the shared launcher and isolates inherited NO_BROWSER', async () => {
  const chinese = await import('node:fs/promises').then(({ readFile }) => readFile(chineseEntry, 'utf8'));
  const compatibility = await import('node:fs/promises').then(({ readFile }) => readFile(compatibilityEntry, 'utf8'));
  assert.match(chinese, /setlocal/i);
  assert.match(chinese, /set\s+"WECHAT_STUDIO_NO_BROWSER="/i);
  assert.match(chinese, /scripts\\start-workbench\.ps1/i);
  assert.match(chinese, /%~dp0scripts\\start-workbench\.ps1/i);
  assert.match(chinese, /if\s+errorlevel\s+1/i);
  assert.match(compatibility, /scripts\\start-workbench\.ps1/i);
  assert.match(compatibility, /%~dp0scripts\\start-workbench\.ps1/i);
  assert.doesNotMatch(chinese, /WECHAT_STUDIO_NO_BROWSER=1/i);
});

test('launcher remains script-location based and browser-enabled by default', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(launcher, 'utf8'));
  assert.match(source, /Split-Path\s+-Parent\s+\$PSScriptRoot/);
  assert.match(source, /\$origin\s*=\s*'http:\/\/127\.0\.0\.1:43210'/);
  assert.match(source, /Start-Process\s+\$origin/);
  assert.match(source, /WECHAT_STUDIO_NO_BROWSER/);
  assert.match(source, /Mutex/);
  assert.match(source, /workspaceScope/);
});

test('missing npm failure is visible and isolated without starting a process', windowsOnly, async () => {
  await withIsolatedLauncher(async ({ isolatedLauncher }) => {
    const command = [
      "function Invoke-RestMethod { throw 'network blocked in launcher unit test' }",
      "function Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State); @() }",
      "function Get-Command { [CmdletBinding()] param([Parameter(Position=0)][string]$Name, [Parameter(ValueFromRemainingArguments=$true)][object[]]$Remaining); if ($Name -eq 'npm.cmd') { return $null }; Microsoft.PowerShell.Core\\Get-Command -Name $Name }",
      `& ${psLiteral(isolatedLauncher)}`,
    ].join('; ');
    const result = runPowerShell(command, {
      env: {
        WECHAT_STUDIO_NO_BROWSER: '1',
        WECHAT_STUDIO_PORT: '9999',
        WECHAT_STUDIO_DATA_DIR: join(project, 'data'),
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /npm\.cmd was not found/u);
    assert.equal(result.error, undefined);
    assert.equal(existsSync(join(rootFromScript(isolatedLauncher), 'logs', 'workbench.err.log')), false);
  });
});

test('occupied-port refusal is accurate and does not attempt cleanup of unknown processes', windowsOnly, async () => {
  await withIsolatedLauncher(async ({ isolatedLauncher }) => {
    const command = [
      "function Invoke-RestMethod { throw 'network blocked in launcher unit test' }",
      "function Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State); if ($LocalPort -eq 43210) { [pscustomobject]@{ LocalPort = 43210; State = 'Listen' } } }",
      "function Get-Command { [CmdletBinding()] param([Parameter(Position=0)][string]$Name, [Parameter(ValueFromRemainingArguments=$true)][object[]]$Remaining); if ($Name -eq 'npm.cmd') { [pscustomobject]@{ Name = 'npm.cmd' } } else { Microsoft.PowerShell.Core\\Get-Command -Name $Name } }",
      `& ${psLiteral(isolatedLauncher)}`,
    ].join('; ');
    const result = runPowerShell(command);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Port 43210 is already used by another program/u);
    assert.equal(result.error, undefined);
  });
});

function rootFromScript(scriptPath) {
  return dirname(dirname(scriptPath));
}
