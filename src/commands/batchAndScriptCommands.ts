import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { ToolsContext, pickConnection, pickMultiConnection } from './sshToolsCommands';

async function runCommand(connection: SSHConnection, cmd: string): Promise<string> {
  return connection.exec(cmd);
}

export function registerBatchAndScriptCommands(ctx: ToolsContext): vscode.Disposable[] {
  const { log, logResult, outputChannel } = ctx;
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('sshLite.batchRun', async () => {
    const connections = await pickMultiConnection('Pick hosts for batch command');
    if (connections.length === 0) { return; }
    const command = await vscode.window.showInputBox({
      prompt: 'Command to run on ' + connections.length + ' hosts',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? null : 'Command is required'),
    });
    if (!command) { return; }
    const hostNames = connections.map((c) => c.host.name).join(', ');
    const confirmed = await vscode.window.showWarningMessage(
      'Run "' + command + '" on ' + connections.length + ' hosts (' + hostNames + ')?',
      { modal: true },
      'Run'
    );
    if (confirmed !== 'Run') { return; }
    log('batchRun', connections.length + ' hosts');
    outputChannel.appendLine('\n═══ Batch: ' + command + ' ═══');
    outputChannel.show(true);
    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          const out = await runCommand(conn, command);
          outputChannel.appendLine('\n── [' + conn.host.name + '] ──');
          outputChannel.appendLine(out.trim() || '(no output)');
        } catch (err) {
          outputChannel.appendLine('\n── [' + conn.host.name + '] ── FAILED');
          outputChannel.appendLine((err as Error).message);
        }
      })
    );
    outputChannel.appendLine('\n═══ Batch complete ═══');
    logResult('batchRun', true, connections.length + ' hosts');
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.runLocalScriptRemote', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to run local script on', preConn);
    if (!connection) { return; }
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Scripts: ['sh', 'bash', 'py', 'pl', 'rb'], All: ['*'] },
      title: 'Select local script to run remotely',
    });
    if (!picks || picks.length === 0) { return; }
    const localPath = picks[0].fsPath;
    if (!fs.existsSync(localPath)) {
      vscode.window.showErrorMessage('File not found: ' + localPath);
      return;
    }
    const ext = path.extname(localPath) || '.sh';
    const remoteTmp = '/tmp/sshlite-run-' + Date.now() + ext;
    log('runLocalScriptRemote', path.basename(localPath) + ' → ' + connection.host.name + ':' + remoteTmp);
    try {
      const contents = fs.readFileSync(localPath);
      await connection.writeFile(remoteTmp, contents);
      const esc = remoteTmp.replace(/'/g, "'\\''");
      await runCommand(connection, "chmod +x '" + esc + "'");
      const out = await runCommand(connection, "'" + esc + "'");
      outputChannel.appendLine('\n── ' + path.basename(localPath) + ' on ' + connection.host.name + ' ──');
      outputChannel.appendLine(out);
      outputChannel.show(true);
      logResult('runLocalScriptRemote', true, path.basename(localPath));
    } catch (err) {
      logResult('runLocalScriptRemote', false, (err as Error).message);
      vscode.window.showErrorMessage('Script run failed: ' + (err as Error).message);
    } finally {
      try { await connection.deleteFile(remoteTmp); } catch { /* ignore */ }
    }
  }));

  return disposables;
}
