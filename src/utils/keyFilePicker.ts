import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface PickKeyOptions {
  /** Placeholder/title shown to the user (e.g. "Private key for user@host"). */
  title: string;
  /** Pre-fill the "type the path" input box (e.g. the current value when editing). */
  initialPath?: string;
  /**
   * The host's CURRENT key path (edit flows). When set, a "Keep current key"
   * choice is offered as the first item so the existing key is one click away
   * and is never silently lost. The caller should also treat a cancelled pick
   * (undefined) as "keep current" in edit flows.
   */
  current?: string;
  /**
   * When true the key is optional: a "No key — use password auth" choice is
   * offered and an empty selection is a valid answer (returns '').
   * When false the key is required (no such choice).
   */
  optional?: boolean;
}

/**
 * Result of {@link pickPrivateKeyPath}:
 *  - a non-empty string  → the chosen key path,
 *  - ''                  → the user explicitly chose "no key" (only when `optional`),
 *  - undefined           → the user cancelled.
 */
export type PickKeyResult = string | undefined;

/**
 * Ask the user for a private-key path, offering BOTH a file browser (pick the
 * file with the mouse via the OS dialog) and manual typing (which keeps a `~`
 * path portable across machines). This is the shared entry point for every
 * place that needs a key path — add host, edit host, and the "add user with
 * key" flow — so the experience is identical everywhere.
 *
 * The OS file dialog opens at `~/.ssh` when that folder exists (where keys
 * usually live), otherwise at the home directory.
 */
export async function pickPrivateKeyPath(options: PickKeyOptions): Promise<PickKeyResult> {
  const KEEP = '$(check) Keep current key';
  const BROWSE = '$(folder-opened) Browse for key file…';
  const TYPE = '$(keyboard) Type the path (supports ~)';
  const NONE = '$(circle-slash) No key — use password auth';

  const items: vscode.QuickPickItem[] = [];
  if (options.current) {
    items.push({ label: KEEP, detail: options.current });
  }
  items.push(
    { label: BROWSE, detail: 'Pick the private key file with the mouse' },
    { label: TYPE, detail: 'Enter the path manually (e.g. ~/.ssh/id_rsa)' }
  );
  if (options.optional) {
    items.push({ label: NONE, detail: 'Connect with a password instead of a key' });
  }

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: options.title,
    ignoreFocusOut: true,
  });
  if (!choice) return undefined; // cancelled the picker
  if (choice.label === KEEP) return options.current;
  if (choice.label === NONE) return '';

  if (choice.label === BROWSE) {
    const sshDir = path.join(os.homedir(), '.ssh');
    // fs.existsSync never throws (returns false on error), so no try/catch.
    const defaultDir = fs.existsSync(sshDir) ? sshDir : os.homedir();
    let defaultUri: vscode.Uri | undefined;
    try {
      defaultUri = vscode.Uri.file(defaultDir);
    } catch {
      defaultUri = undefined;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select private key',
      title: options.title,
      defaultUri,
    });
    if (!picked || picked.length === 0) return undefined; // dialog cancelled
    return picked[0].fsPath;
  }

  // TYPE
  const typed = await vscode.window.showInputBox({
    prompt: options.title,
    placeHolder: '~/.ssh/id_rsa',
    value: options.initialPath,
    ignoreFocusOut: true,
  });
  if (typed === undefined) return undefined; // input box cancelled
  return typed; // may be '' — caller decides what an empty answer means
}
