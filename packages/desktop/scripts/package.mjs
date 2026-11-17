#!/usr/bin/env node
// Packages the desktop app:  node scripts/package.mjs --linux | --win   (RELEASE_VERSION=1.2.3 to stamp a version)
// The workspace is not bundled: core loads worker scripts and wasm grammars next to its own files. Instead the Spider
// packages are packed, installed with npm into a temp stage (flat node_modules), the web app is copied in, and
// electron-builder packages that folder. Output: packages/desktop/release/<platform>.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
// outside the repository: inside it, electron-builder finds the pnpm workspace and reads its node_modules instead
const stage = path.join(os.tmpdir(), 'spider-desktop-stage');
const platform = process.argv.includes('--win') ? 'win' : process.argv.includes('--linux') ? 'linux' : undefined;
if (!platform) {
  console.error('usage: package.mjs --linux | --win');
  process.exit(2);
}
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('› building the workspace');
run(pnpm, [
  '-r',
  '--filter',
  '@spider/shared',
  '--filter',
  '@spider/core',
  '--filter',
  '@spider/server',
  '--filter',
  '@spider/web',
  '--filter',
  'spider-desktop',
  'run',
  'build',
]);

console.log('› staging the app (packed workspace packages + npm, flat node_modules)');
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'pkgs'), { recursive: true });
// pnpm pack turns workspace:* into real versions; overrides point those at the packed tarballs
const tarball = {};
for (const name of ['shared', 'core', 'server']) {
  const out = execFileSync(pnpm, ['pack', '--pack-destination', path.join(stage, 'pkgs')], {
    cwd: path.join(root, 'packages', name),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  tarball[`@spider/${name}`] = `file:./pkgs/${path.basename(out.trim().split(/\r?\n/).pop())}`;
}
const desktopPkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(
  readFileSync(path.join(desktop, 'node_modules/electron/package.json'), 'utf8'),
).version;
const pkg = {
  name: desktopPkg.name,
  productName: desktopPkg.productName,
  version: (process.env.RELEASE_VERSION ?? desktopPkg.version).replace(/^v/, ''),
  description: desktopPkg.description,
  author: desktopPkg.author,
  license: desktopPkg.license,
  homepage: desktopPkg.homepage,
  type: 'module',
  main: desktopPkg.main,
  dependencies: {
    '@spider/core': tarball['@spider/core'],
    '@spider/server': tarball['@spider/server'],
    'electron-updater': desktopPkg.dependencies['electron-updater'],
  },
  overrides: tarball,
  // electron-builder reads the Electron version from here
  devDependencies: { electron: electronVersion },
};
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
cpSync(path.join(desktop, 'dist'), path.join(stage, 'dist'), { recursive: true });
cpSync(path.join(desktop, 'resources'), path.join(stage, 'resources'), { recursive: true });
cpSync(path.join(root, 'packages/web/dist'), path.join(stage, 'web'), { recursive: true });
// shortcut: npm resolves third-party versions fresh (no lockfile); pin via a stage lockfile if drift ever bites
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage);
if (!existsSync(path.join(stage, 'node_modules/@spider/core/dist/index.js')))
  throw new Error('stage is missing @spider/core');

console.log(`› packaging Spider ${pkg.version} for ${platform} (Electron ${electronVersion})`);
const builder = path.join(
  desktop,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
run(
  builder,
  [
    `--${platform}`,
    '--projectDir',
    stage,
    '--config',
    path.join(desktop, 'electron-builder.json'),
    `-c.directories.output=${path.join(desktop, 'release', platform)}`,
    `-c.electronVersion=${electronVersion}`,
    '--publish',
    'never',
  ],
  desktop,
);
