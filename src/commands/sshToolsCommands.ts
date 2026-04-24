import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import {
  RemoteEnvDocumentProvider, RemoteCronDocumentProvider,
} from '../providers/VirtualDocProviders';
import { registerProcessAndServiceCommands } from './processAndServiceCommands';
import { registerEnvAndCronCommands } from './envAndCronCommands';
import { registerSnippetCommands } from './snippetCommands';
import { registerBatchAndScriptCommands } from './batchAndScriptCommands';
import { registerKeyCommands } from './keyCommands';
import { registerDiffCommand } from './diffCommand';

export type Logger = (event: string, detail?: string) => void;

export interface ToolsContext {
  log: Logger;
  logResult: (event: string, success: boolean, detail?: string) => void;
  envProvider: RemoteEnvDocumentProvider;
  cronProvider: RemoteCronDocumentProvider;
  outputChannel: vscode.OutputChannel;
}

export function getConnectedConnections(): SSHConnection[] {
  return ConnectionManager.getInstance().getAllConnections().filter((c) => c.state === 'connected');
}

export async function pickConnection(prompt: string, preselect?: SSHConnection): Promise<SSHConnection | undefined> {
  if (preselect) { return preselect; }
  const conns = getConnectedConnections();
  if (conns.length === 0) {
    vscode.window.showInformationMessage('No active SSH connections.');
    return undefined;
  }
  if (conns.length === 1) { return conns[0]; }
  const pick = await vscode.window.showQuickPick(
    conns.map((c) => ({ label: c.host.name, description: `${c.host.username}@${c.host.host}`, conn: c })),
    { placeHolder: prompt, ignoreFocusOut: true }
  );
  return pick?.conn;
}

export async function pickMultiConnection(prompt: string): Promise<SSHConnection[]> {
  const conns = getConnectedConnections();
  if (conns.length < 2) {
    vscode.window.showInformationMessage('Batch runner requires at least 2 active connections.');
    return [];
  }
  const picks = await vscode.window.showQuickPick(
    conns.map((c) => ({ label: c.host.name, description: `${c.host.username}@${c.host.host}`, conn: c, picked: true })),
    { placeHolder: prompt, canPickMany: true, ignoreFocusOut: true }
  );
  return picks ? picks.map((p: any) => p.conn) : [];
}

export function registerSshToolsCommands(ctx: ToolsContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  disposables.push(...registerProcessAndServiceCommands(ctx));
  disposables.push(...registerEnvAndCronCommands(ctx));
  disposables.push(...registerSnippetCommands(ctx));
  disposables.push(...registerBatchAndScriptCommands(ctx));
  disposables.push(...registerKeyCommands(ctx));
  disposables.push(...registerDiffCommand(ctx));
  return disposables;
}
