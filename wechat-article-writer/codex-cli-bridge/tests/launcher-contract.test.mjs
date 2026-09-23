import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDirectory, '../..');

test('local launcher pins the current bridge and Studio marker, and rebuilds stale dist', async () => {
  const launcher = await readFile(path.join(projectRoot, 'start-local-workbench.ps1'), 'utf8');
  assert.match(launcher, /codex-bridge\.v40-20260903/);
  assert.match(launcher, /CONTENT_DESK_BUILD=v40/);
  assert.match(launcher, /-Wait/);
  assert.match(launcher, /Test-StudioDistCurrent/);
  assert.match(launcher, /Test-StudioAssets/);
  assert.match(launcher, /Get-StudioBuildInputs/);
  assert.match(launcher, /X-Bridge-Build/);
  assert.match(launcher, /@\('app', 'lib', 'public'\)/);
  assert.match(launcher, /package\*\.json/);
  assert.match(launcher, /\*config\.\*/);
  assert.match(launcher, /tsconfig\*\.json/);
  assert.match(launcher, /next-env\.d\.ts/);
  assert.match(launcher, /vinext\*/);
  assert.match(launcher, /\.env\*/);
  assert.match(launcher, /\*\.toml/);
  assert.match(launcher, /dist\|node_modules\|\\.next/);
  assert.match(launcher, /newestSourceTime/);
  assert.doesNotMatch(launcher, /\$studioPageSource/);
  assert.match(launcher, /npm\.cmd/);
});

test('launcher never reuses a marker-only Studio and restarts only an owned stale process', async () => {
  const launcher = await readFile(path.join(projectRoot, 'start-local-workbench.ps1'), 'utf8');
  const reuseCheckStart = launcher.indexOf('if ($null -ne $studioResponse -and (Test-StudioResponse $studioResponse))');
  const reuseCheckEnd = launcher.indexOf('# A missing or unexpected response retains', reuseCheckStart);
  assert.ok(reuseCheckStart >= 0 && reuseCheckEnd > reuseCheckStart, 'healthy Studio branch must be present');
  const reuseBranch = launcher.slice(reuseCheckStart, reuseCheckEnd);
  assert.match(reuseBranch, /Test-StudioDistCurrent\s+\$studioDist\s+\$studioSourceRoot/);
  assert.match(reuseBranch, /Test-StudioAssets\s+\$studioResponse/);
  assert.match(reuseBranch, /Get-ListeningProcessId\s+43126/);
  assert.match(reuseBranch, /Test-StudioProcessOwner\s+\$studioOwnerId/);
  assert.match(reuseBranch, /Stop-Process\s+-Id\s+\$studioOwnerId\s+-Force/);
  assert.match(reuseBranch, /Wait-StudioPortFree/);

  const listenerFunction = launcher.slice(
    launcher.indexOf('function Get-ListeningProcessId'),
    launcher.indexOf('function Test-StudioProcessOwner'),
  );
  assert.match(listenerFunction, /Get-NetTCPConnection\s+-LocalAddress\s+127\.0\.0\.1/);

  const ownerFunction = launcher.slice(
    launcher.indexOf('function Test-StudioProcessOwner'),
    launcher.indexOf('function Wait-StudioPortFree'),
  );
  assert.match(ownerFunction, /studioRoot/);
  assert.match(ownerFunction, /--port\\s\+43126/);
  assert.doesNotMatch(ownerFunction, /Stop-Process|taskkill|Get-Process\s+-Name/);

  const occupiedPortBranch = launcher.slice(
    launcher.indexOf('if (-not $studioCanReuse)'),
    launcher.indexOf('$powershellCommand = Get-Command', launcher.indexOf('if (-not $studioCanReuse)')),
  );
  assert.match(occupiedPortBranch, /older workbench build does not carry the current marker/i);
  assert.match(occupiedPortBranch, /Test-StudioProcessOwner\s+\$studioOwnerId/);
  assert.match(occupiedPortBranch, /Stop-Process\s+-Id\s+\$studioOwnerId\s+-Force/);
});

test('ASCII double-click entry delegates to the PowerShell launcher', async () => {
  const cmd = await readFile(path.join(projectRoot, 'start-local-workbench.cmd'), 'utf8');
  assert.match(cmd, /pwsh\.exe/i);
  assert.match(cmd, /powershell\.exe/i);
  assert.match(cmd, /start-local-workbench\.ps1/i);
});

test('bridge launcher replaces only an idle owned older Content Desk bridge', async () => {
  const launcher = await readFile(path.join(projectRoot, 'codex-cli-bridge', 'start-hidden.ps1'), 'utf8');
  assert.match(launcher, /existing\.engine -eq 'codex-cli'/);
  assert.match(launcher, /existing\.busy -ne \$true/);
  assert.match(launcher, /Test-BridgeProcessOwner\s+\$bridgeOwnerId/);
  assert.match(launcher, /node\.exe/);
  assert.match(launcher, /server\\\.mjs/);
  assert.match(launcher, /Stop-Process\s+-Id\s+\$bridgeOwnerId\s+-Force/);
  assert.match(launcher, /Wait-BridgePortFree/);
  assert.match(launcher, /Test-BridgeSourceCurrent/);
  assert.match(launcher, /LastWriteTimeUtc/);
});
