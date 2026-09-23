$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$healthUri = 'http://127.0.0.1:43127/health'
$expectedBridgeVersion = 'codex-bridge.v40-20260903'
$bridgeSourcePath = Join-Path $bridgeRoot 'server.mjs'

function Get-BridgeHealth {
  try {
    return Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-ListeningProcessId([int]$port) {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $connection) { return $null }
  return [int]$connection.OwningProcess
}

function Test-BridgeProcessOwner([int]$processId) {
  if ($processId -le 0) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { return $false }
  return [bool]($process.Name -eq 'node.exe' -and $process.CommandLine -match '(?i)(?:^|[\s"''])server\.mjs(?:[\s"'']|$)')
}

function Test-BridgeSourceCurrent([int]$processId) {
  if ($processId -le 0 -or -not (Test-Path -LiteralPath $bridgeSourcePath -PathType Leaf)) { return $false }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  $sourceTime = (Get-Item -LiteralPath $bridgeSourcePath -ErrorAction Stop).LastWriteTimeUtc
  return $process.StartTime.ToUniversalTime() -ge $sourceTime
}

function Wait-BridgePortFree([int]$attempts = 20) {
  for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
    if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 43127 -WarningAction SilentlyContinue -InformationLevel Quiet)) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$existing = Get-BridgeHealth
if ($null -ne $existing) {
  $bridgeOwnerId = Get-ListeningProcessId 43127
  if ($existing.bridgeVersion -eq $expectedBridgeVersion `
    -and $existing.execReady -eq $true `
    -and $existing.authenticated -eq $true `
    -and $null -ne $bridgeOwnerId `
    -and (Test-BridgeProcessOwner $bridgeOwnerId) `
    -and (Test-BridgeSourceCurrent $bridgeOwnerId)) {
    Write-Output 'Codex bridge already running and healthy at http://127.0.0.1:43127'
    exit 0
  }
  $knownOldBridge = $existing.engine -eq 'codex-cli' `
    -and $existing.bridgeVersion -match '^codex-bridge\.v\d+-\d{8}$' `
    -and $existing.busy -ne $true
  if (-not $knownOldBridge -or $null -eq $bridgeOwnerId -or -not (Test-BridgeProcessOwner $bridgeOwnerId)) {
    Write-Error 'Port 43127 has an unknown, busy, or unowned bridge; no process was stopped.'
    exit 1
  }
  Stop-Process -Id $bridgeOwnerId -Force -ErrorAction Stop
  if (-not (Wait-BridgePortFree)) {
    Write-Error 'The owned legacy Bridge did not release port 43127; no other process was stopped.'
    exit 1
  }
}

$portInUse = Test-NetConnection -ComputerName 127.0.0.1 -Port 43127 -WarningAction SilentlyContinue -InformationLevel Quiet
if ($portInUse) {
  Write-Error 'Port 43127 is occupied by an unknown process; no process was killed or replaced.'
  exit 1
}

$nodeCommand = Get-Command node -ErrorAction Stop
$process = Start-Process `
  -WindowStyle Hidden `
  -FilePath $nodeCommand.Source `
  -ArgumentList @('server.mjs') `
  -WorkingDirectory $bridgeRoot `
  -PassThru

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  $health = Get-BridgeHealth
  if ($null -ne $health) {
    if ($health.bridgeVersion -eq $expectedBridgeVersion -and $health.execReady -eq $true -and $health.authenticated -eq $true) {
      Write-Output ("Codex bridge started (PID {0}) at http://127.0.0.1:43127" -f $process.Id)
      exit 0
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Write-Error 'Bridge responded with an unexpected version or execReady state.'
    exit 1
  }
  if ($process.HasExited) {
    Write-Error 'Bridge process failed to start or did not return health.'
    exit 1
  }
}

Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Write-Error 'Bridge did not become healthy in time; no process was killed.'
exit 1
