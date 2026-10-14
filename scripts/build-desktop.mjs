import { spawn } from 'node:child_process';
import { mkdir, copyFile, stat } from 'node:fs/promises';
const child = spawn(process.execPath, ['scripts/tauri-local.mjs', 'build', '--no-bundle'], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => {
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  try {
    await mkdir('dist-desktop', { recursive: true });
    await copyFile('src-tauri/target/release/copyloom.exe', 'dist-desktop/Copyloom.exe');
    const { size } = await stat('dist-desktop/Copyloom.exe');
    console.log('Release: dist-desktop/Copyloom.exe (' + (size / 1e6).toFixed(1) + ' MB)');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
