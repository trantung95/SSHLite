#!/usr/bin/env node
// @author hybr8
/**
 * Real VS Code uninstall / reinstall end-to-end test (npm run test:vscode-uninstall).
 *
 * Up:   package the VSIX into test-docker/vscode-uninstall/.artifacts/, build the
 *       container image (real VS Code + Xvfb), run the test inside it.
 * Down: ALWAYS (pass or fail): `docker compose down --volumes --rmi all
 *       --remove-orphans` + delete .artifacts/. Nothing is left on the machine.
 *
 * Flags: --keep     skip the teardown (debugging; run `--down` later)
 *        --down     teardown only
 * See .adn/testing/vscode-uninstall-e2e.md.
 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = path.join(ROOT, 'test-docker', 'docker-compose.vscode-uninstall.yml');
const ARTIFACTS = path.join(ROOT, 'test-docker', 'vscode-uninstall', '.artifacts');
const VSIX = path.join(ARTIFACTS, 'ssh-lite.vsix');
const args = new Set(process.argv.slice(2));

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const r = cp.spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status === null ? 1 : r.status;
}

function down() {
  run('docker', ['compose', '-f', COMPOSE, 'down', '--volumes', '--rmi', 'all', '--remove-orphans']);
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  console.log('cleanup done: container, network, volumes, local image and staged VSIX removed');
}

function up() {
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  if (run('npx', ['vsce', 'package', '--out', VSIX]) !== 0 || !fs.existsSync(VSIX)) {
    console.error('VSIX packaging failed');
    return 1;
  }
  if (run('docker', ['compose', '-f', COMPOSE, 'build']) !== 0) {
    console.error('image build failed');
    return 1;
  }
  return run('docker', ['compose', '-f', COMPOSE, 'run', '--rm', 'vscode-linux']);
}

// ---------------------------------------------------------------------------
// Windows leg (--windows, Windows host only): portable VS Code (zip build) in a
// throwaway folder with a fake USERPROFILE. No Docker: Windows containers would
// need Docker Desktop switched out of Linux mode, and Electron needs a desktop.
// The real VS Code install, real ~/.claude etc. and real extensions are untouched.
// ---------------------------------------------------------------------------
const WIN_ROOT = path.join(require('os').tmpdir(), 'sshlite-vscode-uninstall-e2e');
const E2E_JS = path.join(ROOT, 'test-docker', 'vscode-uninstall', 'e2e.js');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function psQuote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Kill every process whose executable lives under the throwaway VS Code folder. */
function winStopGui(appDir) {
  const ps =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psQuote(appDir)}, 'OrdinalIgnoreCase') } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  for (let i = 0; i < 3; i++) {
    cp.spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    sleep(1500);
  }
}

function winDown() {
  winStopGui(path.join(WIN_ROOT, 'vscode'));
  for (let i = 0; i < 5 && fs.existsSync(WIN_ROOT); i++) {
    try {
      fs.rmSync(WIN_ROOT, { recursive: true, force: true });
    } catch {
      sleep(2000); // a just-killed process may still hold a file handle
    }
  }
  console.log(fs.existsSync(WIN_ROOT) ? `WARNING: could not delete ${WIN_ROOT}` : `cleanup done: ${WIN_ROOT} (VS Code, fake home, VSIX) removed`);
}

function winUp() {
  winDown();
  const appDir = path.join(WIN_ROOT, 'vscode');
  const home = path.join(WIN_ROOT, 'home');
  const ws = path.join(WIN_ROOT, 'ws');
  const userData = path.join(appDir, 'data', 'user-data');
  const extDir = path.join(appDir, 'data', 'extensions');
  const vsix = path.join(WIN_ROOT, 'ssh-lite.vsix'); // own copy: may run while the Linux leg uses .artifacts/
  for (const d of [appDir, home, ws, path.join(appDir, 'data')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (run('npx', ['vsce', 'package', '--out', vsix]) !== 0 || !fs.existsSync(vsix)) {
    console.error('VSIX packaging failed');
    return 1;
  }
  // Windows' own curl.exe / tar.exe (bsdtar): Git Bash's GNU tar reads `C:` as a remote host.
  const sys32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
  const zip = path.join(WIN_ROOT, 'vscode.zip');
  if (run(path.join(sys32, 'curl.exe'), ['-fsSL', '-o', zip, 'https://update.code.visualstudio.com/latest/win32-x64-archive/stable']) !== 0) {
    console.error('VS Code download failed');
    return 1;
  }
  if (run(path.join(sys32, 'tar.exe'), ['-xf', zip, '-C', appDir]) !== 0) {
    console.error('VS Code extract failed');
    return 1;
  }
  // `data/` next to Code.exe = portable mode: user data + extensions stay inside appDir.
  const env = { ...process.env, USERPROFILE: home, HOME: home, USER_DATA_DIR: userData };
  delete env.VSCODE_PORTABLE;
  const cli = path.join(appDir, 'bin', 'code.cmd');
  const exe = path.join(appDir, 'Code.exe');
  const e2e = (phase, quiet) =>
    cp.spawnSync(process.execPath, [E2E_JS, phase, extDir], { env, stdio: quiet ? 'ignore' : 'inherit' }).status;
  const codeCli = (...a) => cp.spawnSync(cli, a, { env, stdio: 'inherit', shell: true }).status;
  const startGui = (label) => {
    console.log(`--- launching VS Code (${label})`);
    const child = cp.spawn(exe, ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', ws], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  };
  const waitFor = (secs, phase) => {
    for (let i = 0; i < secs; i++) {
      if (e2e(phase, true) === 0) {
        return true;
      }
      sleep(1000);
    }
    console.error(`TIMEOUT waiting for ${phase}`);
    return false;
  };
  const step = (ok) => {
    if (!ok) {
      throw new Error('step failed');
    }
  };
  try {
    console.log('=== 1. install + activate');
    step(e2e('prepare-home') === 0);
    step(codeCli('--install-extension', vsix, '--force') === 0);
    startGui('first start');
    step(waitFor(120, 'registry-has-install'));
    sleep(3000);
    winStopGui(appDir);
    step(e2e('activated') === 0);

    console.log('=== 2. seed hooks (fixture = NPC panel auto-setup result)');
    step(e2e('seed') === 0);

    console.log('=== 3. uninstall + restart (VS Code runs vscode:uninstall on this start)');
    step(codeCli('--uninstall-extension', 'hybr8.ssh-lite') === 0);
    startGui('after uninstall');
    step(waitFor(120, 'registry-has-tombstone'));
    sleep(3000);
    winStopGui(appDir);
    step(e2e('after-uninstall') === 0);

    console.log('=== 4. reinstall + activate');
    step(codeCli('--install-extension', vsix, '--force') === 0);
    startGui('after reinstall');
    step(waitFor(120, 'registry-tombstone-consumed'));
    sleep(3000);
    winStopGui(appDir);
    step(e2e('after-reinstall') === 0);
    console.log('=== ALL PHASES PASSED');
    return 0;
  } catch {
    return 1;
  }
}

const windows = args.has('--windows');
if (windows && process.platform !== 'win32') {
  console.error('--windows needs a Windows host');
  process.exit(2);
}
if (args.has('--down')) {
  windows ? winDown() : down();
  process.exit(0);
}
let status = 1;
try {
  status = windows ? winUp() : up();
} finally {
  if (args.has('--keep')) {
    console.log(`--keep: teardown skipped; run \`node scripts/test-vscode-uninstall.js${windows ? ' --windows' : ''} --down\` when done`);
  } else {
    windows ? winDown() : down();
  }
}
console.log(status === 0 ? 'VS Code uninstall e2e: PASSED' : `VS Code uninstall e2e: FAILED (exit ${status})`);
process.exit(status);
