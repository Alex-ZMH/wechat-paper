$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$dataPath = Join-Path $project 'data'
$origin = 'http://127.0.0.1:43210'
$healthUrl = "$origin/api/health"
$logDir = Join-Path $project 'logs'
$stdoutLog = Join-Path $logDir 'workbench.out.log'
$stderrLog = Join-Path $logDir 'workbench.err.log'
$mutex = New-Object Threading.Mutex($false, 'Local\WechatArticleStudio43210Launcher')
$hasLock = $false
$startedProcess = $null
$launchSucceeded = $false
$previousStudioPort = [Environment]::GetEnvironmentVariable('WECHAT_STUDIO_PORT', 'Process')
$previousStudioDataDir = [Environment]::GetEnvironmentVariable('WECHAT_STUDIO_DATA_DIR', 'Process')

function Get-ExpectedScope {
  $jsonPath = ConvertTo-Json ([IO.Path]::GetFullPath($dataPath)) -Compress
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hex = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($jsonPath))).Replace('-', '').ToLowerInvariant()
    return $hex.Substring(0, 12)
  } finally {
    $sha.Dispose()
  }
}

$expectedScope = Get-ExpectedScope

function Get-StudioHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok -eq $true -and $health.service -eq 'wechat-article-studio-core' -and $health.workspaceScope -eq $expectedScope) {
      return $health
    }
  } catch { }
  return $null
}

function Test-PortInUse {
  param([int]$Port)
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Open-Workbench {
  if ($env:WECHAT_STUDIO_NO_BROWSER -ne '1') { Start-Process $origin }
  Write-Host "Workbench ready: $origin" -ForegroundColor Green
}

function Restore-StudioEnvironment {
  if ($null -eq $previousStudioPort) {
    Remove-Item Env:WECHAT_STUDIO_PORT -ErrorAction SilentlyContinue
  } else {
    $env:WECHAT_STUDIO_PORT = $previousStudioPort
  }
  if ($null -eq $previousStudioDataDir) {
    Remove-Item Env:WECHAT_STUDIO_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:WECHAT_STUDIO_DATA_DIR = $previousStudioDataDir
  }
}

function Stop-StartedProcessTree {
  param([object]$Process)
  if ($null -eq $Process) { return }
  try {
    # The exact PID is the process created by this invocation. /T limits
    # cleanup to its descendants; never scan for or stop arbitrary node/npm
    # processes that may belong to another workbench or user task.
    if (-not $Process.HasExited) {
      & taskkill.exe /PID ([string]$Process.Id) /T /F *> $null
    }
  } catch { }
}

try {
  $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(45))
  if (-not $hasLock) { throw 'Another launcher did not finish within 45 seconds. Close it and retry.' }
  Set-Location -LiteralPath $project
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'npm.cmd was not found. Install Node.js 20 or newer, then run this launcher again.'
  }
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  if (Get-StudioHealth) {
    Open-Workbench
    exit 0
  }
  if (Test-PortInUse 43210) {
    throw 'Port 43210 is already used by another program, not this workbench. Close that program and retry.'
  }
  # Start-Process inherits the launcher process environment. Pin both values
  # for this child, then restore the caller's values immediately afterwards so
  # an isolated test environment cannot leak into a future launch.
  $env:WECHAT_STUDIO_PORT = '43210'
  $env:WECHAT_STUDIO_DATA_DIR = [IO.Path]::GetFullPath($dataPath)
  try {
    $startedProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  } finally {
    Restore-StudioEnvironment
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Get-StudioHealth) {
      $launchSucceeded = $true
      Open-Workbench
      exit 0
    }
    if ($startedProcess.HasExited) { break }
    # A listener appearing here can be the workbench itself before its health
    # endpoint is ready. Keep polling until health succeeds or our own child
    # exits instead of treating the startup race as an unrelated process.
    Start-Sleep -Milliseconds 500
  }

  $details = @()
  if (Test-Path -LiteralPath $stderrLog) { $details += Get-Content -LiteralPath $stderrLog -Tail 12 }
  if (Test-Path -LiteralPath $stdoutLog) { $details += Get-Content -LiteralPath $stdoutLog -Tail 12 }
  $suffix = if ($details.Count) { "`n" + ($details -join "`n") } else { '' }
  throw "The workbench did not pass its health check within 45 seconds.$suffix"
} catch {
  if (-not $launchSucceeded) { Stop-StartedProcessTree $startedProcess }
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  Restore-StudioEnvironment
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
