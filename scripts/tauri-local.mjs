import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
const env = { ...process.env };
if (process.platform === 'win32') {
  const tools = path.resolve('.cache/tools');
  const perlRoot = existsSync(path.join(tools, 'perl-native/perl/bin/perl.exe')) ? path.join(tools, 'perl-native') : path.join(tools, 'perl');
  const perl = path.join(perlRoot, 'perl/bin/perl.exe');
  if (existsSync(perl)) { env.PERL = perl; env.OPENSSL_SRC_PERL = perl; }
  const nasmRoot = path.join(tools, 'nasm');
  const nasm = existsSync(nasmRoot) ? readdirSync(nasmRoot).find(name => existsSync(path.join(nasmRoot,name,'nasm.exe'))) : undefined;
  const rust = path.join(env.USERPROFILE || '', '.cargo/bin');
  env.LC_ALL = 'C'; env.LC_CTYPE = 'C';
  const existingPath = env.Path || env.PATH || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = [rust, path.join(perlRoot, 'c/bin'), ...(nasm ? [path.join(nasmRoot,nasm)] : []), existingPath].join(path.delimiter);
  env.CARGO_HOME ||= path.resolve('.cache/cargo');
}
const cargoMode = process.argv[2] === '--cargo';
const child = cargoMode
  ? spawn('cargo', process.argv.slice(3), { env, stdio: 'inherit' })
  : spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exit(1); });
