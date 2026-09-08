# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

param([switch] $Status)
$ErrorActionPreference = 'Stop'
$mutex = $null
$acquired = $false
$exitCode = 1
try {
  # A fixed Global\ name can be pre-created by an unprivileged local process,
  # permanently denying native builds while that process holds it. Keep the
  # machine-wide identity in an administrators/SYSTEM-only directory instead.
  # Program Files also prevents an unprivileged process from planting the
  # identity before the first queued build.
  $identityDir = Join-Path $env:ProgramFiles 'screenpipe-native-build-queue'
  $identityFile = Join-Path $identityDir 'mutex-id'
  if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf)) {
    New-Item -ItemType Directory -Path $identityDir -Force | Out-Null
    & icacls.exe $identityDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'failed to protect native build queue identity' }
    $candidate = [Guid]::NewGuid().ToString('N')
    $temporary = Join-Path $identityDir ("mutex-id.$PID.tmp")
    [IO.File]::WriteAllText($temporary, $candidate, [Text.UTF8Encoding]::new($false))
    try { Move-Item -LiteralPath $temporary -Destination $identityFile -ErrorAction Stop }
    catch {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf)) { throw }
    }
  }
  $identity = [IO.File]::ReadAllText($identityFile).Trim()
  if ($identity -notmatch '^[0-9a-f]{32}$') { throw 'invalid native build queue identity' }
  # Kernel ownership is released even after a worker crash or reboot. All
  # worktrees use the same protected machine-wide name, not a checkout-local
  # lock file.
  $mutex = [Threading.Mutex]::new($false, "Global\ScreenpipeNativeBuildQueue-$identity")
  try { $acquired = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $acquired = $true }
  if ($Status) {
    if ($acquired) { Write-Host '[native-build-queue] idle' }
    else { Write-Host '[native-build-queue] busy: another native build' }
    $exitCode = 0
  } else {
    while (-not $acquired) {
      Write-Host '[native-build-queue] waiting for the machine-wide Windows build slot'
      try { $acquired = $mutex.WaitOne(10000) }
      catch [Threading.AbandonedMutexException] { $acquired = $true }
    }
    $request = $env:SCREENPIPE_NATIVE_QUEUE_REQUEST | ConvertFrom-Json
    if (-not $request.executable -or -not $request.runner -or -not $request.requestId) {
      throw 'missing native build queue request'
    }
    if (-not (Test-Path -LiteralPath $request.executable -PathType Leaf) -or
        -not (Test-Path -LiteralPath $request.runner -PathType Leaf)) {
      throw 'native build queue executable or runner is missing'
    }
    # Environment JSON avoids command-line reparsing of Tauri config overlays.
    $arguments = @($request.runner, '__locked', $request.requestId, $request.mode) + @($request.args)
    # Cargo warnings on native stderr are not PowerShell failures; its actual
    # exit code remains authoritative and is returned to the caller unchanged.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 1
    try {
      & $request.executable @arguments
      $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
  }
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
exit $exitCode
