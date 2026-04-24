import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { SystemToolsService, ProcessEntry, ServiceEntry } from '../services/SystemToolsService';
import { ToolsContext, pickConnection } from './sshToolsCommands';

export function registerProcessAndServiceCommands(ctx: ToolsContext): vscode.Disposable[] {
  const { log, logResult, outputChannel } = ctx;

  const procCmd = vscode.commands.registerCommand('sshLite.showRemoteProcesses', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to view processes', preConn);
    if (!connection) { return; }
    log('showRemoteProcesses', connection.host.name);
    try {
      const procs = await SystemToolsService.getInstance().listProcesses(connection, 100);
      if (procs.length === 0) {
        vscode.window.showInformationMessage(`No processes returned from ${connection.host.name}`);
        return;
      }
      const items = procs.map((p: ProcessEntry) => ({
        label: `$(process) ${p.command}`,
        description: `PID ${p.pid}`,
        detail: `user=${p.user}  cpu=${p.cpu}%  mem=${p.mem}%`,
        proc: p,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Processes on ${connection.host.name} (top ${procs.length} by CPU) — pick one to kill`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      const action = await vscode.window.showWarningMessage(
        `Send SIGTERM to PID ${pick.proc.pid} (${pick.proc.command}) on ${connection.host.name}?`,
        { modal: true },
        'Kill', 'Kill (sudo)'
      );
      if (!action) { return; }
      await SystemToolsService.getInstance().killProcess(connection, pick.proc.pid, action === 'Kill (sudo)');
      vscode.window.setStatusBarMessage(`$(check) Sent SIGTERM to PID ${pick.proc.pid}`, 3000);
      logResult('showRemoteProcesses', true, `killed ${pick.proc.pid}`);
    } catch (err) {
      logResult('showRemoteProcesses', false, (err as Error).message);
      vscode.window.showErrorMessage(`Process viewer failed: ${(err as Error).message}`);
    }
  });

  const svcCmd = vscode.commands.registerCommand('sshLite.manageRemoteService', async (preConn?: SSHConnection) => {
    const connection = await pickConnection('Pick host to manage services', preConn);
    if (!connection) { return; }
    log('manageRemoteService', connection.host.name);
    try {
      const services = await SystemToolsService.getInstance().listServices(connection);
      if (services.length === 0) {
        vscode.window.showInformationMessage(`No systemd services found on ${connection.host.name}`);
        return;
      }
      const pickedService = await vscode.window.showQuickPick(
        services.map((s: ServiceEntry) => ({
          label: s.name,
          description: `${s.active}/${s.sub}`,
          detail: s.description,
          svc: s,
        })),
        { placeHolder: `Services on ${connection.host.name} — pick one`, matchOnDescription: true, matchOnDetail: true }
      );
      if (!pickedService) { return; }
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Status', value: 'status' as const },
          { label: 'Start', value: 'start' as const },
          { label: 'Stop', value: 'stop' as const },
          { label: 'Restart', value: 'restart' as const },
        ],
        { placeHolder: `Action for ${pickedService.svc.name}` }
      );
      if (!action) { return; }
      const needSudo = action.value !== 'status';
      const output = await SystemToolsService.getInstance().runServiceAction(
        connection, pickedService.svc.name, action.value, needSudo
      );
      outputChannel.appendLine(`\n── systemctl ${action.value} ${pickedService.svc.name} on ${connection.host.name} ──`);
      outputChannel.appendLine(output || '(no output)');
      outputChannel.show(true);
      logResult('manageRemoteService', true, `${action.value} ${pickedService.svc.name}`);
    } catch (err) {
      logResult('manageRemoteService', false, (err as Error).message);
      vscode.window.showErrorMessage(`Service manager failed: ${(err as Error).message}`);
    }
  });

  return [procCmd, svcCmd];
}
