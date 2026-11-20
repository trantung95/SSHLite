import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { ToolsContext, pickConnection, pickMultiConnection } from './sshToolsCommands';
import { infoLog, diagLog } from '../utils/diagnosticLog';

async function runCommand(connection: SSHConnection, cmd: string): Promise<string> {
  return connection.exec(cmd);
}

/**
 * Convert CRLF to LF for text scripts. A script saved on a Windows client has "#!/bin/sh\r",
 * which the kernel resolves to the missing interpreter "/bin/sh\r". Binary content (NUL byte
 * present) is returned untouched.
 */
export function normalizeScriptLineEndings(contents: Buffer): Buffer {
  if (contents.indexOf(0) !== -1) { return contents; }
  if (contents.indexOf(0x0d) === -1) { return contents; }
  return Buffer.from(contents.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
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
          const res = await conn.execWithExitCode(command);
          if (res.code !== 0) {
            infoLog('batch-run', 'host-failed', { host: conn.host.name, code: res.code });
            outputChannel.appendLine('\n── [' + conn.host.name + '] ── FAILED (exit code ' + res.code + ')');
            if (res.stdout.trim()) { outputChannel.appendLine(res.stdout.trim()); }
            outputChannel.appendLine(res.stderr.trim() || '(no stderr)');
            return;
          }
          outputChannel.appendLine('\n── [' + conn.host.name + '] ──');
          outputChannel.appendLine(res.stdout.trim() || '(no output)');
          if (res.stderr.trim()) {
            outputChannel.appendLine('[stderr]');
            outputChannel.appendLine(res.stderr.trim());
          }
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
      const raw = fs.readFileSync(localPath);
      const contents = normalizeScriptLineEndings(raw);
      if (contents !== raw) {
        infoLog('run-local-script', 'crlf-normalized', { host: connection.host.name, bytesBefore: raw.length, bytesAfter: contents.length });
      }
      await connection.writeFile(remoteTmp, contents);
      const esc = remoteTmp.replace(/'/g, "'\\''");
      await runCommand(connection, "chmod +x '" + esc + "'");
      const res = await connection.execWithExitCode("'" + esc + "'");
      diagLog('run-local-script', 'finished', { host: connection.host.name, code: res.code, stdoutBytes: res.stdout.length, stderrBytes: res.stderr.length });
      outputChannel.appendLine('\n── ' + path.basename(localPath) + ' on ' + connection.host.name + ' ──');
      outputChannel.appendLine(res.stdout);
      if (res.stderr.trim()) {
        outputChannel.appendLine('[stderr]');
        outputChannel.appendLine(res.stderr.trimEnd());
      }
      outputChannel.show(true);
      if (res.code !== 0) {
        const detail = res.stderr.trim().split('\n')[0];
        outputChannel.appendLine('[exit code ' + res.code + ']');
        logResult('runLocalScriptRemote', false, 'exit code ' + res.code);
        vscode.window.showErrorMessage('Script run failed (exit code ' + res.code + ')' + (detail ? ': ' + detail : ''));
      } else {
        logResult('runLocalScriptRemote', true, path.basename(localPath));
      }
    } catch (err) {
      logResult('runLocalScriptRemote', false, (err as Error).message);
      vscode.window.showErrorMessage('Script run failed: ' + (err as Error).message);
    } finally {
      try { await connection.deleteFile(remoteTmp); } catch { /* ignore */ }
    }
  }));

  return disposables;
}
