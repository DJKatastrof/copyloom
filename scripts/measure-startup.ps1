param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$ProbeDirectory, [int]$Runs = 3)
$ErrorActionPreference = 'Stop'
$taskBinary = (Resolve-Path -LiteralPath $Binary).Path
$taskProbe = [IO.Path]::GetFullPath($ProbeDirectory)
New-Item -ItemType Directory -Path $taskProbe -Force | Out-Null
$taskResults = @()
for ($taskRun = 1; $taskRun -le $Runs; $taskRun++) {
    $taskLaunchUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $taskWatch = [Diagnostics.Stopwatch]::StartNew()
    $taskProcess = Start-Process -FilePath $taskBinary -ArgumentList ('--startup-probe="' + $taskProbe + '"') -WindowStyle Hidden -PassThru
    if (-not $taskProcess.WaitForExit(45000)) {
        Stop-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue
        throw 'The isolated startup probe did not finish within 45 seconds.'
    }
    $taskWatch.Stop()
    if ($taskProcess.ExitCode -ne 0) { throw ('Startup probe exit code: ' + $taskProcess.ExitCode) }
    $taskReportFile = Get-Item -LiteralPath (Join-Path $taskProbe 'data/startup-timing.json')
    $taskReport = Get-Content -LiteralPath $taskReportFile.FullName -Raw | ConvertFrom-Json
    $taskReadyUnixMs = ($taskReport.stages | Where-Object name -eq 'frontend_ready').unix_ms
    if (-not $taskReadyUnixMs) { $taskReadyUnixMs = ([DateTimeOffset]$taskReportFile.LastWriteTimeUtc).ToUnixTimeMilliseconds() }
    $taskResults += [PSCustomObject]@{ run=$taskRun; processWallMs=$taskWatch.ElapsedMilliseconds; launchUnixMs=$taskLaunchUnixMs; launchToReadyMs=($taskReadyUnixMs - $taskLaunchUnixMs); report=$taskReport }
}
$taskResults | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskProbe 'measurements.json') -Encoding utf8
$taskResults | ForEach-Object { [PSCustomObject]@{ run=$_.run; build=$_.report.build; processWallMs=$_.processWallMs; launchToReadyMs=$_.launchToReadyMs; frontendReadyMs=($_.report.stages | Where-Object name -eq 'frontend_ready').elapsed_ms; webviewCreatedMs=($_.report.stages | Where-Object name -eq 'webview_created_setup_enter').elapsed_ms } } | Format-Table
