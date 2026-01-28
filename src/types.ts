import type { Client, ClientChannel } from 'ssh2';

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
  /** SSH port (default: 22) */
  port: number;
  /** Username for authentication */
  username: string;
  /** Path to private key file */
  privateKeyPath?: string;
  /** Short label for editor tab prefix (e.g. "PRD", "DEV"). When set, tabs show [label] instead of [SSH]. */
  tabLabel?: string;
  /** Source of this host config */
  source: 'ssh-config' | 'saved';
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
 * SSH connection interface
 */
export interface ISSHConnection {
  /** Unique connection ID */
  readonly id: string;
  /** Host configuration */
  readonly host: IHostConfig;
  /** Current connection state */
  readonly state: ConnectionState;
  /** Underlying SSH client */
  readonly client: Client | null;

  /** Connect to the remote host */
  connect(): Promise<void>;
  /** Disconnect from the remote host */
  disconnect(): Promise<void>;

  /** Execute a command on the remote host */
  exec(command: string): Promise<string>;

  /** Create an interactive shell */
  shell(): Promise<ClientChannel>;

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
  /** Get file stats */
  stat(remotePath: string): Promise<IRemoteFile>;

  /** Forward a local port to a remote port */
  forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<void>;
  /** Stop a port forward */
  stopForward(localPort: number): Promise<void>;
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
