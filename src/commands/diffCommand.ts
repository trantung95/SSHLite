import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { RemoteDiffService } from '../services/RemoteDiffService';
import { ToolsContext } from './sshToolsCommands';

export function registerDiffCommand(ctx: ToolsContext): vscode.Disposable[] {
  const { log, logResult } = ctx;
  return [
    vscode.commands.registerCommand('sshLite.diffWithLocal', async (item?: any) => {
      if (!item || !item.connection || !item.file || item.file.isDirectory) {
        vscode.window.showErrorMessage('Diff requires a remote file context.');
        return;
      }
      const connection: SSHConnection = item.connection;
      const remotePath: string = item.file.path;
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        title: 'Select local file to diff against ' + remotePath,
      });
      if (!picks || picks.length === 0) { return; }
      log('diffWithLocal', remotePath + ' ↔ ' + picks[0].fsPath);
      try {
        await RemoteDiffService.getInstance().diffRemoteWithLocal(connection, remotePath, picks[0].fsPath);
        logResult('diffWithLocal', true, remotePath);
      } catch (err) {
        logResult('diffWithLocal', false, (err as Error).message);
        vscode.window.showErrorMessage('Diff failed: ' + (err as Error).message);
      }
    }),
  ];
}
