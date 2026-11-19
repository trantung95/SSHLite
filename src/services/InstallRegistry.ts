// @author hybr8
import * as fs from 'fs';
import * as path from 'path';

/**
 * InstallRegistry — tiny vscode-free record in `~/.ssh-lite/installs.json` that
 * lets the `vscode:uninstall` script (plain Node, no VS Code API) find THIS
 * editor's globalStorage, and lets the next activation know the extension was
 * uninstalled in between (so a reinstall behaves like a fresh install).
 *
 *   installs:    { <extension folder>: <globalStorage folder> }   written on activation
 *   uninstalled: [ <globalStorage folder> ]                         written by vscode:uninstall
 *
 * Keys are compared normalized (forward slashes, no trailing slash, lower-case
 * on Windows). Every operation is best-effort and never throws: a broken or
 * missing registry only degrades cleanup, never activation.
 */

export interface RegistryFsApi {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string): void;
  /** Resolve symlinks / junctions (`__dirname` in the uninstall process is a realpath). */
  realpathSync?(p: string): string;
}

const defaultFs: RegistryFsApi = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  renameSync: (a, b) => fs.renameSync(a, b),
  mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
  realpathSync: (p) => fs.realpathSync.native(p),
};

/** Registry key for an extension folder: realpath when resolvable, then normalized. */
function extKeyOf(p: string, fsApi: RegistryFsApi): string {
  let real = p;
  try {
    real = fsApi.realpathSync ? fsApi.realpathSync(p) : p;
  } catch {
    /* folder gone or unreadable: fall back to the given path */
  }
  return normalizeRegistryPath(real);
}

interface RegistryData {
  installs: Record<string, string>;
  uninstalled: string[];
}

export function normalizeRegistryPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

export const registryFile = (home: string): string => path.join(home, '.ssh-lite', 'installs.json');

function read(home: string, fsApi: RegistryFsApi): RegistryData {
  const empty: RegistryData = { installs: {}, uninstalled: [] };
  try {
    const file = registryFile(home);
    if (!fsApi.existsSync(file)) {
      return empty;
    }
    const v = JSON.parse(fsApi.readFileSync(file), (k, val) => (k === '__proto__' || k === 'constructor' ? undefined : val));
    const installs: Record<string, string> = {};
    if (v && typeof v.installs === 'object' && v.installs) {
      for (const [k, val] of Object.entries(v.installs)) {
        if (typeof val === 'string') {
          installs[k] = val;
        }
      }
    }
    const uninstalled = Array.isArray(v?.uninstalled) ? v.uninstalled.filter((x: unknown) => typeof x === 'string') : [];
    return { installs, uninstalled };
  } catch {
    return empty;
  }
}

function write(home: string, data: RegistryData, fsApi: RegistryFsApi): void {
  try {
    const file = registryFile(home);
    fsApi.mkdirSync(path.dirname(file));
    // Per-process temp name: two editors starting at once must not share it.
    const tmp = file + '.' + process.pid + '.tmp';
    fsApi.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fsApi.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/**
 * Called on activation. Records extension folder → storage folder, prunes
 * entries whose extension folder is gone (old versions after an update), and
 * reports whether this storage was uninstalled since the last run (consuming
 * the tombstone). Writes only when something changed.
 */
export function recordInstall(
  home: string,
  extensionPath: string,
  storagePath: string,
  fsApi: RegistryFsApi = defaultFs
): { reinstalled: boolean } {
  try {
    const data = read(home, fsApi);
    const extKey = extKeyOf(extensionPath, fsApi);
    const storageKey = normalizeRegistryPath(storagePath);
    let changed = false;
    for (const k of Object.keys(data.installs)) {
      if (k !== extKey && !fsApi.existsSync(k)) {
        delete data.installs[k];
        changed = true;
      }
    }
    if (data.installs[extKey] !== storagePath) {
      data.installs[extKey] = storagePath;
      changed = true;
    }
    const before = data.uninstalled.length;
    data.uninstalled = data.uninstalled.filter((s) => normalizeRegistryPath(s) !== storageKey);
    const reinstalled = data.uninstalled.length !== before;
    if (changed || reinstalled) {
      write(home, data, fsApi);
    }
    return { reinstalled };
  } catch {
    return { reinstalled: false };
  }
}

/** Storage folder recorded for an extension folder, if any. */
export function lookupStorage(home: string, extensionPath: string, fsApi: RegistryFsApi = defaultFs): string | undefined {
  const installs = read(home, fsApi).installs;
  return installs[extKeyOf(extensionPath, fsApi)] ?? installs[normalizeRegistryPath(extensionPath)];
}

/**
 * Called by vscode:uninstall: drop the install entry and leave a tombstone for
 * its storage (the next activation there resets the hook auto-setup flag).
 *
 * `rearmOthers`: the purge removed a hook. Hooks are shared per AI tool, so
 * another editor's SSH Lite (Code vs Code - Insiders vs Cursor) may have been
 * relying on it while its own auto-setup flag says "already done" — mark every
 * other recorded install too, so each one sets its hook up again on next use.
 */
export function markUninstalled(
  home: string,
  extensionPath: string,
  opts: { rearmOthers?: boolean } = {},
  fsApi: RegistryFsApi = defaultFs
): void {
  const data = read(home, fsApi);
  let extKey = extKeyOf(extensionPath, fsApi);
  if (data.installs[extKey] === undefined) {
    extKey = normalizeRegistryPath(extensionPath);
  }
  const storage = data.installs[extKey];
  if (storage === undefined && !opts.rearmOthers) {
    return;
  }
  const tombstones = storage === undefined ? [] : [storage];
  if (storage !== undefined) {
    delete data.installs[extKey];
  }
  if (opts.rearmOthers) {
    tombstones.push(...Object.values(data.installs));
  }
  for (const s of tombstones) {
    const key = normalizeRegistryPath(s);
    if (!data.uninstalled.some((u) => normalizeRegistryPath(u) === key)) {
      data.uninstalled.push(s);
    }
  }
  write(home, data, fsApi);
}