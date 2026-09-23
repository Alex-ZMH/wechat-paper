[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$targets = @(
  'releases\build-staging\site-package-v26-c4f11de-final2',
  'releases\legacy\artifacts',
  'releases\legacy\discarded-staging',
  'releases\legacy\failed-packaging',
  'outputs\content-desk-v24-3efcc3f.tar.gz',
  'outputs\content-desk-v25-b422018.tar.gz',
  'outputs\content-desk-v26-c4f11de-final2.tar.gz'
)

foreach ($relativePath in $targets) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
  if (-not $target.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing target outside project: $target"
  }
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "Already absent: $relativePath"
    continue
  }
  if ($PSCmdlet.ShouldProcess($target, 'Delete obsolete Content Desk build artifact')) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Deleted: $relativePath"
  }
}

$preserved = @(
  'outputs\content-desk-v27-b61d880.tar.gz',
  'outputs\content-desk-v28-3febe49.tar.gz',
  'releases\v27.json',
  'releases\v28.json'
)
foreach ($relativePath in $preserved) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath))) {
    throw "Required rollback/current artifact is missing: $relativePath"
  }
}

Write-Host 'Cleanup complete. v27 rollback and v28 current artifacts are preserved.'
