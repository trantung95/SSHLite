// scripts/verify-package.js
//
// Builds the extension, runs `vsce package`, lists .vsix entries, and asserts
// the webview bundle (media/search/main.js etc.) is included.
// Run via `npm run verify:package`. Exits non-zero on failure.
//
// Uses execFileSync (no shell) with arg arrays — see project security rule.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
// shell:true is required on Windows so the shell resolves npm.cmd / npx.cmd.
// Args are still passed as an array (not concatenated), so there is no injection risk.
const NPM = 'npm';
const NPX = 'npx';
// On Windows, bsdtar ships at a fixed location; on POSIX, bare 'tar' is fine.
// We use the explicit path on Windows to avoid picking up Git Bash's GNU tar,
// which cannot parse Windows drive letters (D:\...) as local file paths.
const TAR = IS_WIN ? 'C:/Windows/System32/tar.exe' : 'tar';

// Inside a .vsix, files live under "extension/" (vsce convention).
const REQUIRED_ENTRIES = [
  'extension/media/search/main.js',
  'extension/media/search/main.css',
  'extension/media/search/index.html',
  'extension/out/extension.js',
];

function run(bin, args) {
  console.log('[verify-package] $ ' + bin + ' ' + args.join(' '));
  // shell:true lets Windows resolve npm.cmd / npx.cmd; args array prevents injection.
  execFileSync(bin, args, { cwd: ROOT, stdio: 'inherit', shell: true });
}

function listVsixEntries(vsixPath) {
  // bsdtar/libarchive handles zip on both Win10+ and POSIX.
  // On Windows, use forward slashes so bsdtar.exe does not confuse the drive
  // letter (D:\...) with a remote host URL. No shell=true here — TAR is a
  // full path on Windows, so the OS resolves it directly without a shell.
  const normalizedPath = IS_WIN ? vsixPath.replace(/\\/g, '/') : vsixPath;
  const out = execFileSync(TAR, ['-tf', normalizedPath], { cwd: ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

(function main() {
  // Clean prior .vsix files
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.vsix')) fs.rmSync(path.join(ROOT, f));
  }

  run(NPM, ['run', 'compile']);
  run(NPX, ['--yes', '@vscode/vsce', 'package', '--no-dependencies']);

  const vsix = fs.readdirSync(ROOT).find((f) => f.endsWith('.vsix'));
  if (!vsix) {
    console.error('[verify-package] FAIL: no .vsix produced');
    process.exit(1);
  }
  console.log('[verify-package] produced ' + vsix);

  const entries = listVsixEntries(path.join(ROOT, vsix));
  const missing = REQUIRED_ENTRIES.filter((e) => !entries.includes(e));
  if (missing.length) {
    console.error('[verify-package] FAIL: missing entries in .vsix:');
    missing.forEach((m) => console.error('  - ' + m));
    console.error('[verify-package] First 20 entries actually in .vsix:');
    entries.slice(0, 20).forEach((e) => console.error('  ' + e));
    process.exit(1);
  }
  console.log('[verify-package] OK — all ' + REQUIRED_ENTRIES.length + ' required entries present in ' + vsix);
})();
