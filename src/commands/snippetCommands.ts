import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { SnippetService } from '../services/SnippetService';
import { ToolsContext, pickConnection } from './sshToolsCommands';

async function runOnConnection(connection: SSHConnection, command: string): Promise<string> {
  return connection.exec(command);
}

export function registerSnippetCommands(ctx: ToolsContext): vscode.Disposable[] {
  const { log, logResult, outputChannel } = ctx;
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('sshLite.runSnippet', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to run snippet', preConn);
    if (!connection) { return; }
    const snippets = SnippetService.getInstance().getAll();
    const pick = await vscode.window.showQuickPick(
      snippets.map((s) => ({
        label: s.name,
        description: s.builtin ? '(built-in)' : '',
        detail: s.command.length > 120 ? s.command.slice(0, 117) + '...' : s.command,
        snip: s,
      })),
      { placeHolder: 'Pick a snippet to run', matchOnDetail: true }
    );
    if (!pick) { return; }
    log('runSnippet', pick.snip.name);
    try {
      const out = await runOnConnection(connection, pick.snip.command);
      outputChannel.appendLine('\n── ' + pick.snip.name + ' on ' + connection.host.name + ' ──');
      outputChannel.appendLine(pick.snip.command);
      outputChannel.appendLine('');
      outputChannel.appendLine(out);
      outputChannel.show(true);
      logResult('runSnippet', true, pick.snip.name);
    } catch (err) {
      logResult('runSnippet', false, (err as Error).message);
      vscode.window.showErrorMessage('Snippet failed: ' + (err as Error).message);
    }
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.addSnippet', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Snippet name',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? null : 'Name is required'),
    });
    if (!name) { return; }
    const command = await vscode.window.showInputBox({
      prompt: 'Snippet command',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? null : 'Command is required'),
    });
    if (!command) { return; }
    await SnippetService.getInstance().add(name, command);
    vscode.window.setStatusBarMessage('$(check) Snippet "' + name + '" saved', 2000);
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.manageSnippets', async () => {
    const user = SnippetService.getInstance().getUserSnippets();
    if (user.length === 0) {
      vscode.window.showInformationMessage('No user snippets yet. Use "Add Snippet" first.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      user.map((s) => ({ label: s.name, description: s.command.slice(0, 80), snip: s })),
      { placeHolder: 'Pick a snippet to rename or delete' }
    );
    if (!pick) { return; }
    const action = await vscode.window.showQuickPick(['Rename', 'Edit Command', 'Delete'], { placeHolder: 'Action' });
    if (!action) { return; }
    if (action === 'Delete') {
      await SnippetService.getInstance().remove(pick.snip.id);
      vscode.window.setStatusBarMessage('$(trash) Snippet deleted', 2000);
    } else if (action === 'Rename') {
      const newName = await vscode.window.showInputBox({ prompt: 'New name', value: pick.snip.name, ignoreFocusOut: true });
      if (newName) { await SnippetService.getInstance().rename(pick.snip.id, newName); }
    } else if (action === 'Edit Command') {
      const newCmd = await vscode.window.showInputBox({ prompt: 'New command', value: pick.snip.command, ignoreFocusOut: true });
      if (newCmd) { await SnippetService.getInstance().update(pick.snip.id, newCmd); }
    }
  }));

  return disposables;
}
