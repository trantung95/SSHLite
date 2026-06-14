import * as vscode from 'vscode';
import { IConnection, IConnectionCapabilities } from '../types';

/**
 * Capability guards for protocol-agnostic connections.
 *
 * FTP connections (FTPConnection) implement only the file-operations subset of
 * IConnection. They have no `exec`, `shell`, `forwardPort`, `stopForward`,
 * search, sudo, native watch, or server-side backup. ConnectionManager hands out
 * connections typed as `SSHConnection` through a documented downcast, so the
 * compiler does NOT catch an SSH-only call landing on an FTP connection - it
 * would throw a runtime "x is not a function" TypeError.
 *
 * Menu `when` clauses hide SSH-only rows for FTP (`(?!\.ftp)`), but keybindings,
 * the command palette, connection pickers, and the active-connection path all
 * bypass menu gating. So every SSH-only feature must be capability-gated in code:
 *   - `ensureCapability` at a command-handler entry (shows a friendly message),
 *   - `assertCapability` at the service sink (throws, as a backstop).
 */
export type ConnectionCapabilityKey = keyof Omit<IConnectionCapabilities, 'type'>;

const ACTION_BY_CAP: Record<ConnectionCapabilityKey, string> = {
  supportsExec: 'Running remote commands',
  supportsShell: 'Opening a terminal',
  supportsPortForward: 'Port forwarding',
  supportsNativeWatch: 'Native file watching',
  supportsSearch: 'Remote search',
  supportsServerBackup: 'Server-side backups',
  supportsSudo: 'Sudo escalation',
};

function protocolLabel(connection: IConnection): string {
  return (connection.capabilities?.type ?? 'this').toUpperCase();
}

/**
 * True if the connection supports the capability. A capability is treated as
 * UNSUPPORTED only when it is explicitly `false` (which is exactly what an FTP
 * connection reports). A connection with no `capabilities` object is treated as
 * capable - real SSHConnection/FTPConnection always populate it, so the only
 * objects without it are legacy/test stubs, and the repo's convention is that a
 * connection of unknown kind defaults to SSH (full capability).
 */
export function hasCapability(connection: IConnection, capability: ConnectionCapabilityKey): boolean {
  const caps = connection?.capabilities;
  if (!caps) {
    return true;
  }
  return caps[capability] !== false;
}

/**
 * UI guard: returns true when supported; otherwise shows a standard warning and
 * returns false. Call at the start of a command handler and early-return on false.
 */
export function ensureCapability(
  connection: IConnection,
  capability: ConnectionCapabilityKey,
  action?: string
): boolean {
  if (hasCapability(connection, capability)) {
    return true;
  }
  const what = action ?? ACTION_BY_CAP[capability];
  void vscode.window.showWarningMessage(
    `${what} is not available over ${protocolLabel(connection)} connections. Use an SSH connection.`
  );
  return false;
}

/**
 * Non-UI guard: throws a clear Error when unsupported. Call at a service sink as
 * a backstop so an SSH-only method is never invoked on an FTP connection (which
 * would otherwise be an opaque TypeError). Callers that already surface errors
 * will show this message.
 */
export function assertCapability(
  connection: IConnection,
  capability: ConnectionCapabilityKey,
  action?: string
): void {
  if (!hasCapability(connection, capability)) {
    const what = action ?? ACTION_BY_CAP[capability];
    throw new Error(`${what} is not available over ${protocolLabel(connection)} connections.`);
  }
}
