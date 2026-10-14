param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$ProbeDirectory)
$ErrorActionPreference = 'Stop'
$taskBinary = (Resolve-Path -LiteralPath $Binary).Path
$taskProbe = [IO.Path]::GetFullPath($ProbeDirectory)
New-Item -ItemType Directory -Path $taskProbe -Force | Out-Null
$taskProcess = Start-Process -FilePath $taskBinary -ArgumentList ('--startup-probe="' + $taskProbe + '"') -WindowStyle Hidden -PassThru
$taskKnown = [Collections.Generic.HashSet[int]]::new()
[void]$taskKnown.Add($taskProcess.Id)
$taskRows = [Collections.Generic.List[object]]::new()
$taskClock = [Diagnostics.Stopwatch]::StartNew()
$taskPeakWorkingSet = 0L
try {
    while (-not $taskProcess.HasExited -and $taskClock.Elapsed.TotalSeconds -lt 45) {
        $taskChildren = @(Get-CimInstance Win32_Process -Filter "name = 'msedgewebview2.exe'")
        for ($taskPass = 0; $taskPass -lt 4; $taskPass++) {
            foreach ($taskChild in $taskChildren) { if ($taskKnown.Contains([int]$taskChild.ParentProcessId)) { [void]$taskKnown.Add([int]$taskChild.ProcessId) } }
        }
        $taskRust = 0L; $taskWebview = 0L; $taskRenderer = 0L
        foreach ($taskId in $taskKnown) {
            try {
                $taskItem = [Diagnostics.Process]::GetProcessById($taskId)
                $taskBytes = $taskItem.PrivateMemorySize64
                if ($taskId -eq $taskProcess.Id) { $taskRust = $taskBytes; $taskPeakWorkingSet = [Math]::Max($taskPeakWorkingSet, $taskItem.PeakWorkingSet64) }
                else { $taskWebview += $taskBytes; if (($taskChildren | Where-Object ProcessId -eq $taskId).CommandLine -match '--type=renderer') { $taskRenderer += $taskBytes } }
                $taskItem.Dispose()
            } catch [ArgumentException] { }
        }
        $taskRows.Add([PSCustomObject]@{ elapsedMs=$taskClock.ElapsedMilliseconds; rustPrivate=$taskRust; webviewPrivate=$taskWebview; rendererPrivate=$taskRenderer })
        Start-Sleep -Milliseconds 100
        $taskProcess.Refresh()
    }
    if (-not $taskProcess.HasExited) { $taskProcess.Kill(); throw 'Editor probe timed out.' }
    if ($taskProcess.ExitCode -ne 0) { throw ('Editor probe failed: ' + $taskProcess.ExitCode) }
    $taskSummary = [PSCustomObject]@{
        rustPrivateMax=($taskRows | Measure-Object rustPrivate -Maximum).Maximum
        webviewPrivateMax=($taskRows | Measure-Object webviewPrivate -Maximum).Maximum
        rendererPrivateMax=($taskRows | Measure-Object rendererPrivate -Maximum).Maximum
        rustPeakWorkingSet=$taskPeakWorkingSet
        samples=$taskRows.Count
        note='Observed private-memory maxima; polling includes WMI time plus 100 ms. WebView/renderer totals include the isolated library, panel and editor. Rust peak working set is OS-reported and differs from private memory.'
    }
    [PSCustomObject]@{ summary=$taskSummary; samples=$taskRows } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskProbe 'editor-memory.json') -Encoding utf8
    $taskSummary | Format-List
    Get-Content -LiteralPath (Join-Path $taskProbe 'editor-performance.json')
} finally { $taskProcess.Dispose() }
