param([string]$Binary = './dist-desktop/Copyloom.exe')
$ErrorActionPreference = 'Stop'
$taskProbe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache/startup-probe/regression'))
$taskPreviousDelay = $env:COPYLOOM_TEST_TRAY_DELAY_MS
try {
    $env:COPYLOOM_TEST_TRAY_DELAY_MS = '3000'
    & (Join-Path $PSScriptRoot 'measure-startup.ps1') -Binary $Binary -ProbeDirectory $taskProbe -Runs 1
} finally {
    if ($null -eq $taskPreviousDelay) { Remove-Item Env:COPYLOOM_TEST_TRAY_DELAY_MS -ErrorAction SilentlyContinue }
    else { $env:COPYLOOM_TEST_TRAY_DELAY_MS = $taskPreviousDelay }
}
$taskReport = Get-Content -LiteralPath (Join-Path $taskProbe 'data/startup-timing.json') -Raw | ConvertFrom-Json
$taskReady = ($taskReport.stages | Where-Object name -eq 'frontend_ready').elapsed_ms
$taskTrayBegin = ($taskReport.stages | Where-Object name -eq 'tray_begin').elapsed_ms
$taskTrayReady = ($taskReport.stages | Where-Object name -eq 'tray_created').elapsed_ms
if ($null -eq $taskTrayBegin -or $null -eq $taskReady -or $taskReady -ge ($taskTrayBegin + 2500)) { throw 'The UI waited for the delayed system tray.' }
if (-not ($taskReport.stages | Where-Object name -eq 'tray_menu_verified')) { throw 'Native tray menu actions were not verified.' }
Write-Output ('PASS: UI ready ' + $taskReady + ' ms; tray ready ' + $taskTrayReady + ' ms; native pause/resume menu verified.')
