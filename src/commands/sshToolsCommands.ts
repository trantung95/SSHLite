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

/**
 * Coerce a command argument into a live SSHConnection. VS Code passes whatever
 * the invocation context provides: an SSHConnection (rare), or - when the
 * command runs from a context menu - a tree item. A host row is a
 * `ServerTreeItem` (has `.hosts`: host configs with `.id`); a credential row is
 * a `ConnectionTreeItem` (has `.connection`). Duck-typed so this module does not
 * depend on the tree-provider classes (avoids an import cycle).
 */
function resolvePreselect(arg: unknown): SSHConnection | undefined {
  if (!arg || typeof arg !== 'object') { return undefined; }
  const a = arg as Record<string, unknown>;

  // Already an SSHConnection (has exec() + a host config).
  if (typeof a.exec === 'function' && a.host) { return arg as unknown as SSHConnection; }

  // ConnectionTreeItem: carries the live connection directly.
  const conn = a.connection as Record<string, unknown> | undefined;
  if (conn && typeof conn.exec === 'function') { return conn as unknown as SSHConnection; }

  // ServerTreeItem: resolve the first connected user under this host.
  if (Array.isArray(a.hosts)) {
    const mgr = ConnectionManager.getInstance();
    for (const h of a.hosts) {
      const id = (h as Record<string, unknown> | null)?.id;
      if (typeof id === 'string') {
        const c = mgr.getConnection(id);
        if (c) { return c; }
      }
    }
  }
  return undefined;
}

export async function pickConnection(prompt: string, preselect?: unknown): Promise<SSHConnection | undefined> {
  const resolved = resolvePreselect(preselect);
  if (resolved) { return resolved; }
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
