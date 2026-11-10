// Builds a release for GitHub: the installer, its updater signature and latest.json, which installed
// copies of Copyloom read to find the new version.
// Usage: node scripts/build-release.mjs
// The signing key is %USERPROFILE%\.copyloom\updater.key, or the file named in COPYLOOM_UPDATER_KEY.
// Its public half is plugins.updater.pubkey in tauri.conf.json; without the same key, installed
// copies refuse the update. Output: dist-desktop/release/v<version>/, uploaded as-is to the release.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const keyPath = process.env.COPYLOOM_UPDATER_KEY || join(homedir(), '.copyloom', 'updater.key');
if (!existsSync(keyPath)) { console.error('No updater key at ' + keyPath + '. Set COPYLOOM_UPDATER_KEY to its path.'); process.exit(1); }
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: (await readFile(keyPath, 'utf8')).trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' };
// Only release builds sign: a plain `tauri build` from the public repository needs no key.
const config = JSON.stringify({ bundle: { createUpdaterArtifacts: true } });
const code = await new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/tauri-local.mjs', 'build', '--config', config], { env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); resolve(1); });
  child.on('exit', resolve);
});
if (code !== 0) process.exit(code ?? 1);

const bundle = `src-tauri/target/release/bundle/nsis/Copyloom_${version}_x64-setup.exe`;
const setup = `Copyloom-${version}-setup.exe`, out = `dist-desktop/release/v${version}`;
await mkdir(out, { recursive: true });
await copyFile(bundle, join(out, setup));
await copyFile(bundle, join('dist-desktop', setup));
await copyFile('src-tauri/target/release/copyloom.exe', `dist-desktop/Copyloom-${version}.exe`);
const notesPath = `dist-desktop/release/RELEASE-NOTES-${version}.md`;
const notes = existsSync(notesPath) ? (await readFile(notesPath, 'utf8')).split(/\r?\n/).find(line => line.trim()) ?? '' : '';
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': {
    signature: (await readFile(bundle + '.sig', 'utf8')).trim(),
    url: `https://github.com/DJKatastrof/copyloom/releases/download/v${version}/${setup}`,
  } },
};
await writeFile(join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nRelease v${version}: ${out}/`);
console.log(`Upload ${setup} and latest.json to the GitHub release tagged v${version}, and mark it as the latest release.`);
