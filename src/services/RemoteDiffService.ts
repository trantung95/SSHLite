import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SSHConnection } from '../connection/SSHConnection';

/**
 * Download a remote file to a read-only temp path and open it in a VS Code
 * diff editor against a chosen local file.
 */
export class RemoteDiffService {
  private static _instance: RemoteDiffService;

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshlite-diff-'));
    const tmpPath = path.join(tmpDir, `remote-${baseName}`);
    fs.writeFileSync(tmpPath, buffer);

    const title = `${path.basename(localPath)} ↔ ${connection.host.name}:${baseName}`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(localPath),
      vscode.Uri.file(tmpPath),
      title
    );
  }
}
