$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeRoot = Join-Path $repoRoot 'codex-cli-bridge'
$studioRoot = Join-Path $repoRoot 'studio'
$bridgeHealth = 'http://127.0.0.1:43127/health'
$studioUpstreamUrl = 'http://127.0.0.1:43126/'
$browserUrl = 'http://127.0.0.1:43127/'
$expectedBridgeVersion = 'codex-bridge.v40-20260903'
$expectedStudioMarker = 'CONTENT_DESK_BUILD=v40'

function Get-JsonHealth([string]$uri) {
  try {
    return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Stop-StartedStudio {
  $listenerId = Get-ListeningProcessId 43126
  if ($null -ne $listenerId -and (Test-StudioProcessOwner $listenerId)) {
    Stop-Process -Id $listenerId -Force -ErrorAction SilentlyContinue
    return
  }
  if ($null -ne $studioProcess -and -not $studioProcess.HasExited) {
    Stop-Process -Id $studioProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

function Test-StudioResponse($response, [bool]$requireBridgeMarker = $false) {
  if ($null -eq $response -or $response.StatusCode -lt 200 -or $response.StatusCode -ge 400) { return $false }
  # Stable build markers prevent treating an unrelated service or stale build
  # on 43126 as this workbench. Do not accept arbitrary HTML/HTTP 200 here.
  if (-not [bool]($response.Content -match [regex]::Escape($expectedStudioMarker))) { return $false }
  if ($requireBridgeMarker -and $response.Headers['X-Bridge-Build'] -ne $expectedBridgeVersion) { return $false }
  return $true
}

function Test-StudioAssets($response) {
  if ($null -eq $response) { return $false }
  $assetPaths = @([regex]::Matches([string]$response.Content, 'src="([^"]+\.js)"') |
    ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -match '^/_next/' } |
    Sort-Object -Unique)
  if ($assetPaths.Count -eq 0) { return $false }
  foreach ($assetPath in $assetPaths) {
    try {
      $assetUri = [Uri]::new([Uri]$studioUpstreamUrl, $assetPath)
      $assetResponse = Invoke-WebRequest -UseBasicParsing -Uri $assetUri -Method Get -TimeoutSec 3 -ErrorAction Stop
      if ($assetResponse.StatusCode -lt 200 -or $assetResponse.StatusCode -ge 400 -or $assetResponse.RawContentLength -le 0) {
        return $false
      }
    } catch {
      return $false
    }
  }
  return $true
}

function Get-StudioBuildInputs([string]$rootPath) {
  # Vinext consumes application code, static assets, package metadata and the
  # root-level build/type/tooling configuration. Keep generated output out of
  # this set so a stale dist cannot make the freshness check self-fulfilling.
  $inputs = @()
  foreach ($directory in @('app', 'lib', 'public')) {
    $directoryPath = Join-Path $rootPath $directory
    if (Test-Path -LiteralPath $directoryPath -PathType Container) {
      $inputs += @(Get-ChildItem -LiteralPath $directoryPath -Recurse -File -Force -ErrorAction SilentlyContinue)
    }
  }
  foreach ($pattern in @('package*.json', '*config.*', 'tsconfig*.json', 'next-env.d.ts', 'vinext*', '.env*', '*.toml')) {
    $inputs += @(Get-ChildItem -LiteralPath $rootPath -File -Force -Filter $pattern -ErrorAction SilentlyContinue)
  }
  $rootPrefix = [IO.Path]::GetFullPath($rootPath).TrimEnd('\') + '\'
  return @($inputs |
    Where-Object {
      $fullPath = [IO.Path]::GetFullPath($_.FullName)
      $relative = if ($fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $fullPath.Substring($rootPrefix.Length)
      } else {
        $fullPath
      }
      $relative -notmatch '(?i)(?:^|[\\/])(?:dist|node_modules|\.next)(?:[\\/]|$)'
    } |
    Sort-Object -Property FullName -Unique)
}

function Test-StudioDistCurrent([string]$distPath, [string]$sourceRootPath) {
  # A dist directory can exist while still containing the previous bundle.
  # Require the exact centralized release marker and a compiled bundle
  # carrying that marker whose timestamp is at least as new as every build
  # input, not just page.tsx.
  if (-not (Test-Path -LiteralPath $distPath -PathType Container)) { return $false }
  if (-not (Test-Path -LiteralPath $sourceRootPath -PathType Container)) { return $false }
  $markerSourcePath = Join-Path $sourceRootPath 'lib\release.ts'
  if (-not (Test-Path -LiteralPath $markerSourcePath -PathType Leaf)) { return $false }
  $sourceText = Get-Content -LiteralPath $markerSourcePath -Raw -ErrorAction SilentlyContinue
  if ($sourceText -notmatch [regex]::Escape($expectedStudioMarker)) { return $false }
  $sourceFiles = @(Get-StudioBuildInputs $sourceRootPath)
  if ($sourceFiles.Count -eq 0) { return $false }
  $sourceTimes = @($sourceFiles |
    ForEach-Object { (Get-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue).LastWriteTimeUtc } |
    Where-Object { $null -ne $_ })
  if ($sourceTimes.Count -eq 0) { return $false }
  $newestSourceTime = $sourceTimes | Sort-Object | Select-Object -Last 1
  $markerFiles = @(Get-ChildItem -LiteralPath $distPath -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.js', '.html') } |
    Select-String -Pattern ([regex]::Escape($expectedStudioMarker)) -List)
  if ($markerFiles.Count -eq 0) { return $false }
  $distTimes = @($markerFiles | ForEach-Object {
      (Get-Item -LiteralPath $_.Path -ErrorAction SilentlyContinue).LastWriteTimeUtc
    } | Where-Object { $null -ne $_ })
  if ($distTimes.Count -eq 0) { return $false }
  $newestDistTime = $distTimes | Sort-Object | Select-Object -Last 1
  return $newestDistTime -ge $newestSourceTime
}

function Get-ListeningProcessId([int]$port) {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $connection) { return $null }
  return [int]$connection.OwningProcess
}

function Test-StudioProcessOwner([int]$processId) {
  if ($processId -le 0) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { return $false }
  $root = [IO.Path]::GetFullPath($studioRoot).TrimEnd('\')
  $sameRoot = $process.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $samePort = $process.CommandLine -match '(?i)(?:^|\s)--port\s+43126(?:\s|$)'
  return [bool]($sameRoot -and $samePort)
}

function Wait-StudioPortFree([int]$attempts = 20) {
  for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
    if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 43126 -WarningAction SilentlyContinue -InformationLevel Quiet)) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$studioProcess = $null
$studioDist = Join-Path $studioRoot 'dist'
$studioSourceRoot = $studioRoot
$studioCanReuse = $false
$studioResponse = $null
try {
  $studioResponse = Invoke-WebRequest -UseBasicParsing -Uri $studioUpstreamUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
} catch {
  $studioResponse = $null
}

# A healthy marker alone is not enough: an already-running server can still
# serve a bundle compiled before the source changed. Reuse only a fresh dist;
# stale dist is rebuilt after an ownership-checked, exact-PID restart below.
if ($null -ne $studioResponse -and (Test-StudioResponse $studioResponse)) {
  if ((Test-StudioDistCurrent $studioDist $studioSourceRoot) -and (Test-StudioAssets $studioResponse)) {
    $studioCanReuse = $true
  } else {
    $studioOwnerId = Get-ListeningProcessId 43126
    if ($null -eq $studioOwnerId -or -not (Test-StudioProcessOwner $studioOwnerId)) {
      Write-Error 'Studio build/assets are stale, but port 43126 is not owned by this workbench; no process was stopped.'
      exit 1
    }
    Stop-Process -Id $studioOwnerId -Force -ErrorAction Stop
    if (-not (Wait-StudioPortFree)) {
      Write-Error 'The owned Studio process did not release port 43126 before rebuild; no other process was stopped.'
      exit 1
    }
  }
}

# A missing or unexpected response retains the fail-closed port check below;
# only a healthy response with a fresh dist is reusable.
if (-not $studioCanReuse) {
  $studioPortInUse = Test-NetConnection -ComputerName 127.0.0.1 -Port 43126 -WarningAction SilentlyContinue -InformationLevel Quiet
  if ($studioPortInUse) {
    $studioOwnerId = Get-ListeningProcessId 43126
    if ($null -eq $studioOwnerId -or -not (Test-StudioProcessOwner $studioOwnerId)) {
      Write-Error 'Port 43126 is occupied by an unknown process; no process was killed or replaced.'
      exit 1
    }
    # An older workbench build does not carry the current marker, but the exact
    # workspace path and fixed port still prove ownership. Replace only that PID.
    Stop-Process -Id $studioOwnerId -Force -ErrorAction Stop
    if (-not (Wait-StudioPortFree)) {
      Write-Error 'The owned legacy Studio process did not release port 43126; no other process was stopped.'
      exit 1
    }
  }
  if (-not (Test-StudioDistCurrent $studioDist $studioSourceRoot)) {
    $buildNode = Get-Command npm.cmd -ErrorAction Stop
    $buildProcess = Start-Process -WindowStyle Hidden -FilePath $buildNode.Source -ArgumentList @('run', 'build') -WorkingDirectory $studioRoot -Wait -PassThru
    if ($buildProcess.ExitCode -ne 0 -or -not (Test-StudioDistCurrent $studioDist $studioSourceRoot)) {
      Write-Error 'Workbench build did not complete; no background process was started.'
      exit 1
    }
  }
  $studioNode = Get-Command npm.cmd -ErrorAction Stop
  $studioProcess = Start-Process `
    -WindowStyle Hidden `
    -FilePath $studioNode.Source `
    -ArgumentList @('run', 'start', '--', '--hostname', '127.0.0.1', '--port', '43126') `
    -WorkingDirectory $studioRoot `
    -PassThru
}

$powershellCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($null -eq $powershellCommand) { $powershellCommand = Get-Command powershell.exe -ErrorAction Stop }
$bridgeLauncher = Start-Process `
  -WindowStyle Hidden `
  -FilePath $powershellCommand.Source `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $bridgeRoot 'start-hidden.ps1')) `
  -WorkingDirectory $bridgeRoot `
  -Wait `
  -PassThru

if ($bridgeLauncher.ExitCode -ne 0) {
  Stop-StartedStudio
  Write-Error 'Codex bridge launcher failed; workbench was not started.'
  exit 1
}

$bridgeReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 250
    $health = Get-JsonHealth $bridgeHealth
  if ($null -ne $health -and $health.bridgeVersion -eq $expectedBridgeVersion -and $health.execReady -eq $true -and $health.authenticated -eq $true) {
    $bridgeReady = $true
    break
  }
}
if (-not $bridgeReady) {
  Stop-StartedStudio
  Write-Error 'Codex bridge is not healthy; workbench was not started.'
  exit 1
}

$studioReady = $false
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $studioUpstreamUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
    if (Test-StudioResponse $response) {
      $studioReady = $true
      break
    }
  } catch {
    if ($null -ne $studioProcess -and $studioProcess.HasExited) { break }
  }
}
if (-not $studioReady) {
  Stop-StartedStudio
  Write-Error 'Workbench production server did not become ready; no background process was killed.'
  exit 1
}

$proxyReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $proxyResponse = Invoke-WebRequest -UseBasicParsing -Uri $browserUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
    if (Test-StudioResponse $proxyResponse $true) {
      $proxyReady = $true
      break
    }
  } catch { }
}
if (-not $proxyReady) {
  Stop-StartedStudio
  Write-Error 'Local same-origin bridge proxy did not become ready.'
  exit 1
}

Start-Process $browserUrl
$studioPid = if ($null -ne $studioProcess) { $studioProcess.Id } else { 'reused' }
Write-Output ("Workbench opened in the default browser: {0}; bridge PID {1}, studio PID {2} (background windows hidden)." -f $browserUrl, $bridgeLauncher.Id, $studioPid)
