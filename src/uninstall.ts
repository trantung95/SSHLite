// @author hybr8
/**
 * `vscode:uninstall` hook (package.json `scripts`). VS Code runs this file with
 * plain Node.js once the extension is fully uninstalled and VS Code restarts —
 * there is NO `vscode` module here, so only vscode-free code may be imported.
 *
 * Job: remove everything SSH Lite wrote OUTSIDE its own storage so nothing is
 * left pointing at a deleted extension, and prepare a reinstall to behave like
 * a fresh install:
 *   1. Look up THIS editor's globalStorage in `~/.ssh-lite/installs.json`
 *      (recorded on activation, keyed by the extension folder = `..` of here).
 *   2. Remove our AI prompt hooks (Claude Code, Codex, Gemini, Cursor, Copilot)
 *      and delete the staged `npc-beacon.js` script + beacon files.
 *   3. Leave a tombstone so the next activation resets the one-time hook
 *      auto-setup flag (hooks are set up again, as on a first install).
 *
 * Must never throw: a failing uninstall script only produces noise for the user.
 */
import * as os from 'os';
import * as path from 'path';
import { purgeHooksForUninstall, HookOpResult } from './services/HookInstallerService';
import { lookupStorage, markUninstalled } from './services/InstallRegistry';

export function runUninstallCleanup(
  home: string = os.homedir(),
  extensionPath: string = path.resolve(__dirname, '..')
): HookOpResult[] {
  let results: HookOpResult[] = [];
  try {
    const storageDir = lookupStorage(home, extensionPath);
    results = purgeHooksForUninstall(home, { storageDir });
  } catch {
    /* never throw from the uninstall hook */
  }
  try {
    // A removed hook may have been shared with SSH Lite in another editor: re-arm them.
    markUninstalled(home, extensionPath, { rearmOthers: results.some((r) => r.ok) });
  } catch {
    /* best-effort */
  }
  return results;
}

if (require.main === module) {
  runUninstallCleanup();
}
