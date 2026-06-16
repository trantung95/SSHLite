import type { Client, ClientChannel } from 'ssh2';
import type * as vscode from 'vscode';

/**
 * Connection transport protocol. Absence of `connectionType` on a saved host
 * is treated as 'ssh' everywhere (backward compatibility) — see getConnectionType().
 */
export type ConnectionType = 'ssh' | 'ftp';

/**
 * SSH host configuration
 */
export interface IHostConfig {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Hostname or IP address */
  host: string;
  /** SSH port (default: 22) or FTP port (default: 21) */
  port: number;
  /** Username for authentication. Empty string ('') on an endpoint record (no account yet). */
  username: string;
  /** True when this record is a server endpoint (host:port) with no account yet. */
  isEndpoint?: boolean;
  /** Path to private key file (SSH only) */
  privateKeyPath?: string;
  /** Short label for editor tab prefix (e.g. "PRD", "DEV"). When set, tabs show [label] instead of [SSH]. */
  tabLabel?: string;
  /** Source of this host config */
  source: 'ssh-config' | 'saved';
  /** Transport protocol. Absent ⇒ 'ssh' (backward compat). */
  connectionType?: ConnectionType;
  /** FTP only: use explicit FTPS (TLS) when true. */
  secure?: boolean;
  /** FTP only: anonymous login (username 'anonymous', empty password). */
  anonymous?: boolean;
}

/**
 * Connection state
 */
export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Error = 'error',
}

/**
 * Remote file/directory info
 */
export interface IRemoteFile {
  /** File/directory name */
  name: string;
  /** Full remote path */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (Unix ms) */
  modifiedTime: number;
  /** Last access timestamp (Unix ms) - optional for backward compatibility */
  accessTime?: number;
  /** Owner username - optional for backward compatibility */
  owner?: string;
  /** Group name - optional for backward compatibility */
  group?: string;
  /** Unix permissions string (e.g., "rwxr-xr-x") - optional */
  permissions?: string;
  /** Connection this file belongs to */
  connectionId: string;
}

/**
 * Saved port forward rule (persisted, per-host)
 */
export interface ISavedPortForwardRule {
  /** Unique identifier */
  id: string;
  /** Local port to listen on */
  localPort: number;
  /** Remote host (usually localhost or 127.0.0.1) */
  remoteHost: string;
  /** Remote port */
  remotePort: number;
}

/**
 * Port forward configuration
 */
export interface IPortForward {
  /** Unique identifier */
  id: string;
  /** Connection ID */
  connectionId: string;
  /** Local port */
  localPort: number;
  /** Remote host (usually localhost or 127.0.0.1) */
  remoteHost: string;
  /** Remote port */
  remotePort: number;
  /** Whether the forward is active */
  active: boolean;
}

/**
 * File transfer progress
 */
export interface ITransferProgress {
  /** File path */
  path: string;
  /** Bytes transferred */
  transferred: number;
  /** Total bytes */
  total: number;
  /** Transfer direction */
  direction: 'upload' | 'download';
}

/**
 * What a connection's transport can actually do. Used to gate shell-only
 * features (terminal, search, monitor, sudo, server-side backup, native watch,
 * port forwarding) that work over SSH but not over plain FTP.
 */
export interface IConnectionCapabilities {
  readonly type: ConnectionType;
  /** Can run arbitrary shell commands (exec). False for FTP. */
  readonly supportsExec: boolean;
  /** Can open an interactive shell/PTY. False for FTP. */
  readonly supportsShell: boolean;
  /** Can forward TCP ports. False for FTP. */
  readonly supportsPortForward: boolean;
  /** Has native (inotify/fswatch) file watching. False for FTP (poll only). */
  readonly supportsNativeWatch: boolean;
  /** Can run remote search (find/grep/rg). False for FTP. */
  readonly supportsSearch: boolean;
  /** Can create server-side backups (mkdir/cp via exec). False for FTP. */
  readonly supportsServerBackup: boolean;
  /** Supports sudo escalation. False for FTP. */
  readonly supportsSudo: boolean;
}

/**
 * Protocol-agnostic connection contract. Both SSHConnection and FTPConnection
 * implement this. Consumers that only browse/transfer files (FileTreeProvider,
 * the file-ops paths of FileService, ConnectionManager's map) should type on
 * IConnection. Shell-dependent consumers use ISSHConnection.
 */
export interface IConnection {
  /** Unique connection ID (`host:port:username`) */
  readonly id: string;
  /** Host configuration */
  readonly host: IHostConfig;
  /** Current connection state */
  readonly state: ConnectionState;
  /** What this connection's transport can do */
  readonly capabilities: IConnectionCapabilities;

  /** Fires when the connection state changes */
  readonly onStateChange: vscode.Event<ConnectionState>;
  /** Fires when a watched remote file changes */
  readonly onFileChange: vscode.Event<{ remotePath: string; event: 'modify' | 'delete' | 'create' }>;

  /** Connect to the remote host */
  connect(): Promise<void>;
  /** Disconnect from the remote host */
  disconnect(): Promise<void>;
  /** Release all resources */
  dispose(): void;

  /** List files in a remote directory */
  listFiles(remotePath: string): Promise<IRemoteFile[]>;
  /** Read a remote file */
  readFile(remotePath: string): Promise<Buffer>;
  /** Write content to a remote file */
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  /** Delete a remote file or directory */
  deleteFile(remotePath: string): Promise<void>;
  /** Create a remote directory */
  mkdir(remotePath: string): Promise<void>;
  /** Rename/move a remote file or directory */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Get file stats */
  stat(remotePath: string): Promise<IRemoteFile>;
  /** Whether a remote path exists */
  fileExists(remotePath: string): Promise<boolean>;

  /**
   * Resolve the connection's default/home directory as an absolute path.
   * SSH: `echo ~` / realpath. FTP: the login directory (PWD after connect).
   * Replaces scattered `exec('echo ~')` calls so callers never assume a shell.
   */
  resolveHomePath(): Promise<string>;
}

/**
 * SSH connection interface — IConnection plus the shell-coupled (ssh2-specific)
 * surface that does not exist over FTP.
 */
export interface ISSHConnection extends IConnection {
  /** Underlying ssh2 client */
  readonly client: Client | null;

  /** Execute a command on the remote host */
  exec(command: string): Promise<string>;
  /** Create an interactive shell */
  shell(): Promise<ClientChannel>;

  /** Forward a local port to a remote port */
  forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<void>;
  /** Stop a port forward */
  stopForward(localPort: number): Promise<void>;
}

/** Resolve a host's transport protocol, defaulting to 'ssh' for legacy configs. */
export function getConnectionType(host: IHostConfig): ConnectionType {
  return host.connectionType ?? 'ssh';
}

/** Type guard: narrow an IConnection to ISSHConnection (shell-capable). */
export function isSSHConnection(c: IConnection): c is ISSHConnection {
  return c.capabilities.supportsExec;
}

/**
 * Last connection attempt result for failed connection indicator
 */
export interface ILastConnectionAttempt {
  timestamp: number;
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * SSH errors
 */
export class SSHError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SSHError';
  }
}

export class AuthenticationError extends SSHError {
  constructor(message: string, cause?: Error) {
    super(message, 'AUTH_FAILED', cause);
    this.name = 'AuthenticationError';
  }
}

export class ConnectionError extends SSHError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTION_FAILED', cause);
    this.name = 'ConnectionError';
  }
}

export class SFTPError extends SSHError {
  constructor(message: string, cause?: Error) {
    super(message, 'SFTP_ERROR', cause);
    this.name = 'SFTPError';
  }
}

/** A generic FTP transport error. Extends SSHError so existing error-classifier code keeps working. */
export class FTPError extends SSHError {
  constructor(message: string, cause?: Error) {
    super(message, 'FTP_ERROR', cause);
    this.name = 'FTPError';
  }
}

/** Thrown when a shell-only operation is attempted over an FTP connection. */
export class UnsupportedOverFtpError extends SSHError {
  constructor(operation: string) {
    super(`'${operation}' is not supported over FTP`, 'FTP_UNSUPPORTED');
    this.name = 'UnsupportedOverFtpError';
  }
}
