import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { ENV_SCHEME, CRON_SCHEME, buildUri } from '../providers/VirtualDocProviders';
import { ToolsContext, pickConnection } from './sshToolsCommands';

async function saveCrontab(connection: SSHConnection, newContents: string): Promise<void> {
  const tmpPath = '/tmp/sshlite-cron-' + Date.now() + '.txt';
  try {
    await connection.writeFile(tmpPath, Buffer.from(newContents, 'utf8'));
    const esc = tmpPath.replace(/'/g, "'\\''");
    const applyCmd = "crontab '" + esc + "' && rm -f '" + esc + "'";
    await connection.exec(applyCmd);
    vscode.window.setStatusBarMessage('$(check) Crontab updated on ' + connection.host.name, 3000);
  } catch (err) {
    try { await connection.deleteFile(tmpPath); } catch { /* ignore */ }
    vscode.window.showErrorMessage('Failed to save crontab: ' + (err as Error).message);
  }
}

export function registerEnvAndCronCommands(ctx: ToolsContext): vscode.Disposable[] {
  const { log, envProvider, cronProvider } = ctx;
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('sshLite.showRemoteEnv', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to inspect environment', preConn);
    if (!connection) { return; }
    log('showRemoteEnv', connection.host.name);
    const uri = buildUri(ENV_SCHEME, connection.id, 'env-' + connection.host.name + '.txt');
    envProvider.refresh(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.editRemoteCron', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to view crontab', preConn);
    if (!connection) { return; }
    log('editRemoteCron', connection.host.name);
    const uri = buildUri(CRON_SCHEME, connection.id, 'crontab-' + connection.host.name + '.cron');
    cronProvider.refresh(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const choice = await vscode.window.showInformationMessage(
      'Crontab opened. Edit the buffer then run "Save Remote Crontab" to apply.',
      'Save Remote Crontab'
    );
    if (choice === 'Save Remote Crontab') {
      await saveCrontab(connection, editor.document.getText());
    }
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.saveRemoteCron', async () => {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.scheme !== CRON_SCHEME) {
      vscode.window.showErrorMessage('Open a remote crontab first (Edit Remote Cron).');
      return;
    }
    const connId = decodeURIComponent(active.document.uri.authority);
    const connection = ConnectionManager.getInstance().getConnection(connId);
    if (!connection) {
      vscode.window.showErrorMessage('Connection for this crontab is no longer active.');
      return;
    }
    await saveCrontab(connection, active.document.getText());
  }));

  return disposables;
}
