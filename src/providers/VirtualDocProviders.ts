import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';

export const ENV_SCHEME = 'sshlite-env';
export const CRON_SCHEME = 'sshlite-cron';

/**
 * Build a URI of the form <scheme>://<connectionId>/<path-or-label>
 */
export function buildUri(scheme: string, connectionId: string, pathOrLabel: string): vscode.Uri {
  const encPath = pathOrLabel.startsWith('/') ? pathOrLabel : '/' + pathOrLabel;
  return vscode.Uri.parse(`${scheme}://${encodeURIComponent(connectionId)}${encPath}`);
}

function resolveConnection(uri: vscode.Uri): SSHConnection | undefined {
  const connectionId = decodeURIComponent(uri.authority);
  return ConnectionManager.getInstance().getConnection(connectionId);
}

/**
 * Read-only provider backing `sshlite-env://<connId>/env`
 */
export class RemoteEnvDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const connection = resolveConnection(uri);
    if (!connection) {
      return '# Connection not active';
    }
    try {
      const out = await connection.exec('env | sort');
      return `# Environment on ${connection.host.name}\n# Re-run "Show Remote Env" to refresh\n\n${out}`;
    } catch (err) {
      return `# Failed to read env: ${(err as Error).message}`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Read-only provider backing `sshlite-cron://<connId>/crontab`
 * (Writing-back to the remote happens via a separate `editRemoteCron` command.)
 */
export class RemoteCronDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const connection = resolveConnection(uri);
    if (!connection) {
      return '# Connection not active';
    }
    try {
      const out = await connection.exec('crontab -l 2>/dev/null || true');
      return out || '# (no crontab for this user)\n';
    } catch (err) {
      return `# Failed to read crontab: ${(err as Error).message}`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
