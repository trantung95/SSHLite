#!/usr/bin/env node
// @author hybr8
/**
 * Fixture seeding + assertions for the real VS Code uninstall / reinstall test.
 * Plain Node.js (no dependencies): runs inside the Linux container and on the
 * Windows leg. VS Code must be CLOSED while a phase runs (state.vscdb is SQLite).
 *
 *   node e2e.js activated        registry was written by activate()
 *   node e2e.js seed             install hooks with the extension's own
 *                                HookInstallerService + set npcAutoHooksDone
 *                                (= what the NPC panel auto-setup leaves behind)
 *   node e2e.js after-uninstall  VS Code ran vscode:uninstall: hooks + staged files gone
 *   node e2e.js after-reinstall  tombstone consumed, auto-setup flag cleared, hooks work again
 *
 * Environment: USER_DATA_DIR (VS Code --user-data-dir; default per platform).
 * Exit code 0 = every check passed. Never touches anything outside os.homedir()
 * and USER_DATA_DIR — callers point both at throwaway folders.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = os.homedir();
const EXT_ID = 'hybr8.ssh-lite';
const MARKER = 'npc-beacon.js';
const USER_DATA_DIR =
  process.env.USER_DATA_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA || HOME, 'Code')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'Code')
      : path.join(HOME, '.config', 'Code'));
const STATE_DB = path.join(USER_DATA_DIR, 'User', 'globalStorage', 'state.vscdb');
const REGISTRY = path.join(HOME, '.ssh-lite', 'installs.json');

/** Config file of every AI tool SSH Lite can hook (mirrors HOOK_TOOLS). */
const TOOL_CONFIGS = {
  claude: path.join(HOME, '.claude', 'settings.json'),
  codex: path.join(HOME, '.codex', 'hooks.json'),
  gemini: path.join(HOME, '.gemini', 'settings.json'),
  cursor: path.join(HOME, '.cursor', 'hooks.json'),
  copilot: path.join(HOME, '.copilot', 'hooks', 'ssh-lite-npc.json'),
};

/** The user's own pre-existing Claude Code hook: must survive install AND uninstall. */
const USER_HOOK_CMD = 'echo user-own-hook';

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''}`);
  if (!ok) {
    failures++;
  }
}
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined);
const readJson = (p) => {
  const t = readText(p);
  return t === undefined ? undefined : JSON.parse(t);
};

function registry() {
  return readJson(REGISTRY) || { installs: {}, uninstalled: [] };
}

/** The single install recorded by activate(): { extDir, storage }. */
function recordedInstall() {
  const entries = Object.entries(registry().installs || {});
  return entries.length === 1 ? { extDir: entries[0][0], storage: entries[0][1] } : undefined;
}

// ---- globalState (state.vscdb, table ItemTable, key = extension id) ----------
function openDb() {
  const { DatabaseSync } = require('node:sqlite'); // Node.js 22.13+
  return new DatabaseSync(STATE_DB);
}
function readGlobalState() {
  if (!fs.existsSync(STATE_DB)) {
    return undefined;
  }
  const db = openDb();
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(EXT_ID);
    return row ? JSON.parse(String(row.value)) : undefined;
  } finally {
    db.close();
  }
}
function writeGlobalState(patch) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(EXT_ID);
    const value = Object.assign(row ? JSON.parse(String(row.value)) : {}, patch);
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(EXT_ID, JSON.stringify(value));
  } finally {
    db.close();
  }
}

function findExtensionDir(extensionsDir) {
  const dirs = fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir) : [];
  const hit = dirs.find((d) => d.toLowerCase().startsWith(EXT_ID + '-'));
  return hit ? path.join(extensionsDir, hit) : undefined;
}

function configsWithMarker() {
  return Object.entries(TOOL_CONFIGS)
    .filter(([, p]) => (readText(p) || '').includes(MARKER))
    .map(([id]) => id);
}

function backupsWithMarker() {
  return Object.values(TOOL_CONFIGS)
    .map((p) => p + '.sshlite.bak')
    .filter((p) => (readText(p) || '').includes(MARKER));
}

/** Run one installed hook command exactly like the AI tool would (prompt JSON on stdin). */
function runHook(cmd) {
  return cp.spawnSync(cmd, {
    shell: true,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'e2e prompt' }),
    encoding: 'utf8',
    timeout: 15000,
  });
}

function claudeHookCommands() {
  const cfg = readJson(TOOL_CONFIGS.claude) || {};
  return ((cfg.hooks && cfg.hooks.UserPromptSubmit) || []).flatMap((m) => (m.hooks || []).map((h) => h.command));
}

/** Fake home before first launch: the AI tools "exist" and the user has their own Claude hook. */
function phasePrepareHome() {
  for (const p of Object.values(TOOL_CONFIGS)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  fs.writeFileSync(
    TOOL_CONFIGS.claude,
    JSON.stringify(
      { theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: USER_HOOK_CMD }] }] } },
      null,
      2
    )
  );
  console.log(`prepared fake home ${HOME}`);
}

function phaseActivated() {
  const rec = recordedInstall();
  check(!!rec, 'activate() recorded the install in ~/.ssh-lite/installs.json', registry());
  if (rec) {
    check(path.basename(rec.storage).toLowerCase() === EXT_ID, 'recorded storage is the globalStorage/hybr8.ssh-lite folder', rec);
  }
}

function phaseSeed(extensionsDir) {
  const rec = recordedInstall();
  const extDir = findExtensionDir(extensionsDir);
  check(!!rec && !!extDir, 'install recorded and extension folder present', { rec, extDir });
  if (!rec || !extDir) {
    return;
  }
  const { HookInstallerService } = require(path.join(extDir, 'out', 'services', 'HookInstallerService.js'));
  const installer = new HookInstallerService(HOME, {
    assetScriptPath: path.join(extDir, 'assets', 'hooks', MARKER),
    scriptPath: path.join(rec.storage, 'hooks', MARKER),
    beaconPath: path.join(rec.storage, 'npc-ai-hook-beacon.json'),
  });
  const results = installer.installAll();
  check(results.every((r) => r.ok), 'installAll() succeeded for every tool', results);
  check(configsWithMarker().length === Object.keys(TOOL_CONFIGS).length, 'every AI tool config now has the SSH Lite hook', configsWithMarker());
  check(fs.existsSync(path.join(rec.storage, 'hooks', MARKER)), 'hook script staged under globalStorage');

  const ours = claudeHookCommands().find((c) => c.includes(MARKER));
  const run = ours ? runHook(ours) : undefined;
  check(!!run && run.status === 0, 'installed hook runs and exits 0', run && { status: run.status, err: run.stderr });
  check(fs.existsSync(path.join(rec.storage, 'npc-ai-hook-beacon.json')), 'hook wrote the beacon file');

  writeGlobalState({ npcAutoHooksDone: true }); // = the NPC panel auto-setup already ran once
  check((readGlobalState() || {}).npcAutoHooksDone === true, 'globalState npcAutoHooksDone = true seeded');
  fs.writeFileSync(path.join(os.tmpdir(), 'sshlite-e2e-storage.txt'), rec.storage);
}

function phaseAfterUninstall() {
  const storage = readText(path.join(os.tmpdir(), 'sshlite-e2e-storage.txt'));
  const reg = registry();
  check(configsWithMarker().length === 0, 'no AI tool config still references npc-beacon.js', configsWithMarker());
  check(!fs.existsSync(TOOL_CONFIGS.copilot), 'Copilot dedicated hook file removed');
  check(claudeHookCommands().includes(USER_HOOK_CMD), "user's own Claude Code hook preserved", claudeHookCommands());
  check((readJson(TOOL_CONFIGS.claude) || {}).theme === 'dark', 'other Claude Code settings preserved');
  check(backupsWithMarker().length === 0, 'no .sshlite.bak backup still holds the dead hook', backupsWithMarker());
  check(!!storage && !fs.existsSync(path.join(storage, 'hooks', MARKER)), 'staged npc-beacon.js deleted');
  check(!!storage && !fs.existsSync(path.join(storage, 'hooks')), 'empty hooks/ folder removed');
  check(!!storage && !fs.existsSync(path.join(storage, 'npc-ai-hook-beacon.json')), 'beacon file deleted');
  check(Object.keys(reg.installs || {}).length === 0, 'install entry dropped from registry', reg);
  check((reg.uninstalled || []).includes(storage), 'tombstone left for this storage', reg);
}

function phaseAfterReinstall() {
  const storage = readText(path.join(os.tmpdir(), 'sshlite-e2e-storage.txt'));
  const reg = registry();
  const rec = recordedInstall();
  check(!!rec && rec.storage === storage, 'reinstall recorded the same storage', reg);
  check(!(reg.uninstalled || []).includes(storage), 'tombstone consumed by activate()', reg);
  const state = readGlobalState() || {};
  check(state.npcAutoHooksDone !== true, 'npcAutoHooksDone cleared: NPC panel will auto-set-up hooks again', state);
}

const phase = process.argv[2];
try {
  switch (phase) {
    case 'prepare-home':
      phasePrepareHome();
      break;
    case 'activated':
      phaseActivated();
      break;
    case 'seed':
      phaseSeed(process.argv[3] || path.join(HOME, '.vscode', 'extensions'));
      break;
    case 'after-uninstall':
      phaseAfterUninstall();
      break;
    case 'after-reinstall':
      phaseAfterReinstall();
      break;
    case 'registry-has-install':
      process.exit(recordedInstall() ? 0 : 1);
      break;
    case 'registry-has-tombstone':
      process.exit((registry().uninstalled || []).length > 0 ? 0 : 1);
      break;
    case 'registry-tombstone-consumed':
      process.exit(recordedInstall() && (registry().uninstalled || []).length === 0 ? 0 : 1);
      break;
    default:
      console.error(`unknown phase: ${phase}`);
      process.exit(2);
  }
} catch (e) {
  check(false, `phase ${phase} threw`, String((e && e.stack) || e));
}
process.exit(failures ? 1 : 0);
