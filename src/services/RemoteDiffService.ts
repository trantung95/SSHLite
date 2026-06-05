import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SSHConnection } from '../connection/SSHConnection';
import { diagLog, infoLog } from '../utils/diagnosticLog';

/** Prefix of the per-diff temp directories created under os.tmpdir(). */
export const DIFF_TMP_PREFIX = 'sshlite-diff-';

/**
 * Download a remote file to a read-only temp path and open it in a VS Code
 * diff editor against a chosen local file.
 *
 * Temp directories created here are tracked and removed once their diff tab is
 * closed (and all remaining ones on dispose), so they don't accumulate. The
 * HousekeepingService additionally sweeps orphaned `sshlite-diff-*` dirs left by
 * a crashed session.
 */
export class RemoteDiffService {
  private static _instance: RemoteDiffService;

  /** Active temp dirs → the temp file inside them whose diff tab we track. */
  private readonly tempDirs = new Map<string, string>();
  private tabListener: vscode.Disposable | undefined;

  private constructor() {}

  static getInstance(): RemoteDiffService {
    if (!RemoteDiffService._instance) {
      RemoteDiffService._instance = new RemoteDiffService();
    }
    return RemoteDiffService._instance;
  }

  /**
   * Download the remote file to tmp and open a diff editor.
   * @param connection SSH connection
   * @param remotePath Path on the remote host
   * @param localPath Absolute path on the local filesystem
   */
  async diffRemoteWithLocal(
    connection: SSHConnection,
    remotePath: string,
    localPath: string
  ): Promise<void> {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`);
    }

    const buffer = await connection.readFile(remotePath);
    const baseName = path.basename(remotePath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), DIFF_TMP_PREFIX));
    const tmpPath = path.join(tmpDir, `remote-${baseName}`);
    fs.writeFileSync(tmpPath, buffer);
    this.tempDirs.set(tmpDir, tmpPath);
    this.ensureTabListener();

    const title = `${path.basename(localPath)} ↔ ${connection.host.name}:${baseName}`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(localPath),
      vscode.Uri.file(tmpPath),
      title
    );
  }

  /** Subscribe once to tab changes so we can clean up when a diff tab closes. */
  private ensureTabListener(): void {
    if (this.tabListener) {
      return;
    }
    const groups = vscode.window.tabGroups;
    if (!groups || typeof groups.onDidChangeTabs !== 'function') {
      return; // older API / test env without tab groups
    }
    this.tabListener = groups.onDidChangeTabs(() => this.pruneClosedDiffs());
  }

  /** Remove temp dirs whose diff tab is no longer open. */
  private pruneClosedDiffs(): void {
    const openPaths = this.collectOpenTabPaths();
    for (const [dir, tmpPath] of [...this.tempDirs]) {
      if (!openPaths.has(tmpPath)) {
        this.removeDir(dir);
        this.tempDirs.delete(dir);
      }
    }
    if (this.tempDirs.size === 0 && this.tabListener) {
      this.tabListener.dispose();
      this.tabListener = undefined;
    }
  }

  /** fsPaths currently shown in any editor tab (text or diff inputs). */
  private collectOpenTabPaths(): Set<string> {
    const paths = new Set<string>();
    const groups = vscode.window.tabGroups;
    for (const group of groups?.all ?? []) {
      for (const tab of group.tabs ?? []) {
        const input = tab.input as { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri } | undefined;
        if (input?.uri) {
          paths.add(input.uri.fsPath);
        }
        if (input?.modified) {
          paths.add(input.modified.fsPath);
        }
        if (input?.original) {
          paths.add(input.original.fsPath);
        }
      }
    }
    return paths;
  }

  private removeDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      diagLog('remote-diff', 'temp-cleanup', { dir });
    } catch (err) {
      diagLog('remote-diff', 'temp-cleanup-failed', { dir, error: (err as Error).message });
    }
  }

  dispose(): void {
    this.tabListener?.dispose();
    this.tabListener = undefined;
    let removed = 0;
    for (const dir of this.tempDirs.keys()) {
      this.removeDir(dir);
      removed++;
    }
    this.tempDirs.clear();
    if (removed > 0) {
      infoLog('remote-diff', 'dispose-cleanup', { removed });
    }
  }
}
