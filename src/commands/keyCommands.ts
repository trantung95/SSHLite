import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SSHConnection } from '../connection/SSHConnection';
import { SshKeyService } from '../services/SshKeyService';
import { ToolsContext, pickConnection } from './sshToolsCommands';

export function registerKeyCommands(ctx: ToolsContext): vscode.Disposable[] {
  const { log, logResult } = ctx;
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('sshLite.generateSshKey', async () => {
    const type = await vscode.window.showQuickPick(['ed25519', 'rsa'], { placeHolder: 'Key type' }) as 'ed25519' | 'rsa' | undefined;
    if (!type) { return; }
    let bits: number | undefined;
    if (type === 'rsa') {
      const b = await vscode.window.showQuickPick(['3072', '4096'], { placeHolder: 'RSA key size' });
      if (!b) { return; }
      bits = Number(b);
    }
    const comment = await vscode.window.showInputBox({
      prompt: 'Key comment (e.g. user@host)',
      value: os.userInfo().username + '@' + os.hostname(),
      ignoreFocusOut: true,
    });
    if (comment === undefined) { return; }
    const keyDir = SshKeyService.getInstance().defaultKeyDir();
    const defaultName = type === 'ed25519' ? 'id_ed25519' : 'id_rsa';
    const outFile = await vscode.window.showInputBox({
      prompt: 'Output file path',
      value: path.join(keyDir, defaultName),
      ignoreFocusOut: true,
    });
    if (!outFile) { return; }
    if (fs.existsSync(outFile)) {
      const overwrite = await vscode.window.showWarningMessage(
        'File exists: ' + outFile + ' — overwrite?', { modal: true }, 'Overwrite'
      );
      if (overwrite !== 'Overwrite') { return; }
    }
    const passphrase = await vscode.window.showInputBox({
      prompt: 'Passphrase (leave empty for none)',
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) { return; }

    log('generateSshKey', outFile);
    try {
      const parentDir = path.dirname(outFile);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      }
      const result = await SshKeyService.getInstance().generateKey({ type, bits, comment, passphrase, outFile });
      logResult('generateSshKey', true, result.privateKeyPath);
      vscode.window.showInformationMessage('Generated ' + result.privateKeyPath + ' and ' + result.publicKeyPath);
    } catch (err) {
      logResult('generateSshKey', false, (err as Error).message);
      vscode.window.showErrorMessage('Key generation failed: ' + (err as Error).message);
    }
  }));

  disposables.push(vscode.commands.registerCommand('sshLite.pushPubKeyToHost', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to push pubkey to', preConn);
    if (!connection) { return; }
    const keyDir = SshKeyService.getInstance().defaultKeyDir();
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: fs.existsSync(keyDir) ? vscode.Uri.file(keyDir) : undefined,
      filters: { 'Public Keys': ['pub'], All: ['*'] },
      title: 'Select public key (.pub) to install on remote',
    });
    if (!picks || picks.length === 0) { return; }
    log('pushPubKeyToHost', picks[0].fsPath + ' → ' + connection.host.name);
    try {
      const result = await SshKeyService.getInstance().pushPublicKey(connection, picks[0].fsPath);
      logResult('pushPubKeyToHost', true, result.added ? 'added' : 'skipped');
      if (result.added) {
        vscode.window.showInformationMessage('Public key installed on ' + connection.host.name);
      } else {
        vscode.window.showInformationMessage(result.reason || 'Key already installed');
      }
    } catch (err) {
      logResult('pushPubKeyToHost', false, (err as Error).message);
      vscode.window.showErrorMessage('Push failed: ' + (err as Error).message);
    }
  }));

  return disposables;
}
