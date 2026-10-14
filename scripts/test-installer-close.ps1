param([string]$ProjectRoot = 'C:\Projekt\Clip')
$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path $ProjectRoot '.cache\installer-close-test'
New-Item -ItemType Directory -Force -Path "$taskRoot\target", "$taskRoot\control" | Out-Null
$taskSource = @"
using System;
using System.Windows.Forms;
class ShutdownWindow : Form {
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x11) { m.Result = new IntPtr(1); return; }
    if (m.Msg == 0x16 && m.WParam != IntPtr.Zero) { Application.ExitThread(); return; }
    base.WndProc(ref m);
  }
  [STAThread] static void Main() {
    var window = new ShutdownWindow();
    window.ShowInTaskbar = false;
    var handle = window.Handle;
    Application.Run();
    window.Dispose();
  }
}
"@
[IO.File]::WriteAllText("$taskRoot\Fixture.cs", $taskSource)
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$taskRoot\target\fixture.exe" "$taskRoot\Fixture.cs"
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
Copy-Item -LiteralPath "$taskRoot\target\fixture.exe" -Destination "$taskRoot\control\fixture.exe" -Force
$taskHarness = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include "${PROJECT_ROOT}\src-tauri\windows\hooks.nsh"
Name "Copyloom installer shutdown test"
OutFile "${PROJECT_ROOT}\.cache\installer-close-test\harness.exe"
!define MAINBINARYNAME "fixture"
Section
  StrCpy $INSTDIR "${PROJECT_ROOT}\.cache\installer-close-test\target"
  FileOpen $9 "${PROJECT_ROOT}\.cache\installer-close-test\stage.txt" w
  FileWrite $9 "before"
  FileClose $9
  StrCpy $R0 "sentinel"
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $9 "${PROJECT_ROOT}\.cache\installer-close-test\stage.txt" a
  FileWrite $9 "after"
  FileClose $9
  StrCmp $R0 "sentinel" +3
    SetErrorLevel 4
    Quit
  !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
'@
[IO.File]::WriteAllText("$taskRoot\harness.nsi", $taskHarness)
$taskNsis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
& $taskNsis /V2 "/DPROJECT_ROOT=$ProjectRoot" "$taskRoot\harness.nsi"
if ($LASTEXITCODE -ne 0) { throw 'NSIS test compilation failed' }
$taskTarget = $null; $taskControl = $null; $taskInstaller = $null
try {
  $taskTarget = Start-Process -FilePath "$taskRoot\target\fixture.exe" -WindowStyle Hidden -PassThru
  $taskControl = Start-Process -FilePath "$taskRoot\control\fixture.exe" -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 500
  if ($taskTarget.HasExited -or $taskControl.HasExited) { throw 'Fixture did not stay alive' }
  $taskInstaller = Start-Process -FilePath "$taskRoot\harness.exe" -WindowStyle Hidden -PassThru
  if (-not $taskInstaller.WaitForExit(45000)) { throw 'Shutdown hook timed out' }
  if ($taskInstaller.ExitCode -ne 0) { throw 'NSIS register preservation failed' }
  if (-not $taskTarget.WaitForExit(3000)) { throw 'Target was not stopped' }
  if ($taskControl.HasExited) { throw 'Unrelated executable was stopped' }
  'PASS: exact installed executable closed; unrelated same-name executable kept running; registers preserved; uninstall of stopped app is harmless.'
} finally {
  foreach ($taskOwned in @($taskInstaller, $taskTarget, $taskControl)) {
    if ($null -ne $taskOwned -and -not $taskOwned.HasExited) { Stop-Process -Id $taskOwned.Id -ErrorAction SilentlyContinue }
  }
}
