import * as vscode from 'vscode';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { Client as FtpRawClient } from 'basic-ftp';
import type { FileInfo, UnixPermissions } from 'basic-ftp';
import {
  IConnection,
  IConnectionCapabilities,
  IHostConfig,
  IRemoteFile,
  ConnectionState,
  AuthenticationError,
  ConnectionError,
  FTPError,
} from '../types';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { diagLog, infoLog } from '../utils/diagnosticLog';
import { parseFtpModifiedTime } from './ftpDate';

/**
 * FTP / FTPS connection — a protocol-agnostic IConnection sibling of SSHConnection
 * backed by the pure-JS `basic-ftp` library. Supports plain FTP, explicit FTPS
 * (TLS) and anonymous login.
 *
 * Scope is deliberately file-operations only (browse / read / write / rename /
 * delete / mkdir / stat). Shell-dependent features (exec, shell, port forward,
 * search, sudo, server-side backup, native watch) are NOT available over FTP and
 * are reported as unsupported via `capabilities` so the UI can hide them.
 *
 * IMPORTANT: `basic-ftp` uses a single control socket and can run only ONE command
 * at a time. The file tree preloads directories in parallel, so every public
 * method is funnelled through an internal serialization queue (`enqueue`). Do not
 * add a connection pool — that breaks both basic-ftp's model and the LITE
 * "reuse a single connection" principle.
 */
export class FTPConnection implements IConnection {
  public readonly id: string;
  public state: ConnectionState = ConnectionState.Disconnected;

  private _client: FtpRawClient | null = null;
  private _credential: SavedCredential | undefined;
  private _homePath = '/';
  private _closing = false;

  /** Serialization queue — basic-ftp allows one command at a time. */
  private _chain: Promise<unknown> = Promise.resolve();

  private readonly _onStateChange = new vscode.EventEmitter<ConnectionState>();
  public readonly onStateChange = this._onStateChange.event;

  private readonly _onFileChange = new vscode.EventEmitter<{ remotePath: string; event: 'modify' | 'delete' | 'create' }>();
  public readonly onFileChange = this._onFileChange.event;

  constructor(public readonly host: IHostConfig, credential?: SavedCredential) {
    this.id = `${host.host}:${host.port}:${host.username}`;
    this._credential = credential;
  }

  get capabilities(): IConnectionCapabilities {
    return {
      type: 'ftp',
      supportsExec: false,
      supportsShell: false,
      supportsPortForward: false,
      supportsNativeWatch: false,
      supportsSearch: false,
      supportsServerBackup: false,
      supportsSudo: false,
    };
  }

  get credential(): SavedCredential | undefined {
    return this._credential;
  }

  /** FTP has no `~`; the login directory (PWD after connect) is the home. */
  async resolveHomePath(): Promise<string> {
    return this._homePath;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.state === ConnectionState.Connected) {
      return;
    }
    if (!this.host.host || this.host.host.trim() === '') {
      throw new ConnectionError('Invalid host configuration: hostname is missing or empty.');
    }

    this.setState(ConnectionState.Connecting);
    const config = vscode.workspace.getConfiguration('sshLite');
    const timeout = config.get<number>('connectionTimeout', 10000);
    const rejectUnauthorized = config.get<boolean>('ftpRejectUnauthorized', true);
    const connectStart = Date.now();

    const anonymous = this.host.anonymous === true;
    infoLog('ftp-connect', 'begin', {
      connectionId: this.id,
      host: this.host.host,
      port: this.host.port,
      username: anonymous ? 'anonymous' : this.host.username,
      secure: !!this.host.secure,
      anonymous,
      timeoutMs: timeout,
    });

    const client = new FtpRawClient(timeout);
    client.ftp.verbose = false;
    this._client = client;
    this._closing = false;

    try {
      const password = await this._resolvePassword();
      const user = anonymous ? 'anonymous' : this.host.username;

      await client.access({
        host: this.host.host,
        port: this.host.port,
        user,
        password,
        secure: this.host.secure ? true : false,
        secureOptions: this.host.secure ? { rejectUnauthorized } : undefined,
      });

      // Strip any trailing slash some servers append to PWD so the home/root
      // short-circuit in statRaw (and path joins) compare cleanly.
      this._homePath = ((await client.pwd()) || '/').replace(/\/+$/, '') || '/';
      this.attachCloseHandler(client);
      this.setState(ConnectionState.Connected);

      infoLog('ftp-connect', 'ready', {
        connectionId: this.id,
        elapsedMs: Date.now() - connectStart,
        home: this._homePath,
      });
    } catch (error) {
      this.setState(ConnectionState.Error);
      try {
        client.close();
      } catch {
        // ignore
      }
      this._client = null;
      const mapped = this.classifyError(error);
      infoLog('ftp-connect', 'error', {
        connectionId: this.id,
        elapsedMs: Date.now() - connectStart,
        errorName: mapped.name,
        errorMessage: mapped.message,
      });
      throw mapped;
    }
  }

  async disconnect(): Promise<void> {
    infoLog('ftp-connect', 'disconnect', { connectionId: this.id, state: this.state });
    this._closing = true;
    if (this._client) {
      try {
        this._client.close();
      } catch (err) {
        diagLog('ftp-connect', 'disconnect/close-error', { connectionId: this.id, errorMessage: (err as Error).message });
      }
      this._client = null;
    }
    this.setState(ConnectionState.Disconnected);
  }

  dispose(): void {
    void this.disconnect();
    this._onStateChange.dispose();
    this._onFileChange.dispose();
  }

  // --------------------------------------------------------------------------
  // File operations (IConnection)
  // --------------------------------------------------------------------------

  async listFiles(remotePath: string): Promise<IRemoteFile[]> {
    const base = this.resolvePath(remotePath);
    return this.enqueue('list', async (client) => {
      const list = await client.list(base);
      const mapped = this.mapFileList(list, base);
      // basic-ftp (and both vsftpd/pure-ftpd) answer LIST of a MISSING directory
      // with an empty success rather than an error — unlike SFTP `readdir`, which
      // throws "No such file". Without this guard a deleted/renamed folder would
      // render as a misleading empty folder instead of surfacing an error like the
      // SSH path does. Confirm existence only when the listing is empty, so the
      // extra round-trip is paid solely for empty/missing dirs; populated dirs and
      // the home/root (special-cased in statRaw, no network call) cost nothing.
      if (mapped.length === 0) {
        let info: IRemoteFile | null;
        try {
          info = await this.statRaw(client, base);
        } catch {
          // The directory's OWN listing already succeeded (empty); only the
          // parent probe used to confirm existence failed — e.g. an unreadable
          // parent on a non-chrooted server. Trust the successful empty listing
          // rather than surface a misleading error. We only upgrade [] to an
          // error when we can PROVE the directory is absent (parent listed fine
          // but the basename is missing).
          return mapped;
        }
        if (!info) {
          throw new FTPError(`No such directory: ${base}`);
        }
      }
      return mapped;
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const target = this.resolvePath(remotePath);
    return this.enqueue('read', async (client) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await client.downloadTo(sink, target);
      return Buffer.concat(chunks);
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    const target = this.resolvePath(remotePath);
    await this.enqueue('write', async (client) => {
      await client.uploadFrom(Readable.from(content), target);
    });
  }

  async deleteFile(remotePath: string): Promise<void> {
    const target = this.resolvePath(remotePath);
    await this.enqueue('delete', async (client) => {
      const info = await this.statRaw(client, target);
      if (info?.isDirectory) {
        await client.removeDir(target);
      } else {
        await client.remove(target);
      }
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    const target = this.resolvePath(remotePath);
    await this.enqueue('mkdir', async (client) => {
      await client.ensureDir(target);
      // ensureDir leaves the server CWD inside the new directory — restore a
      // stable CWD so later relative operations are not surprised.
      try {
        await client.cd(this._homePath);
      } catch {
        // best-effort
      }
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = this.resolvePath(oldPath);
    const to = this.resolvePath(newPath);
    await this.enqueue('rename', async (client) => {
      await client.rename(from, to);
    });
  }

  async stat(remotePath: string): Promise<IRemoteFile> {
    const target = this.resolvePath(remotePath);
    return this.enqueue('stat', async (client) => {
      const info = await this.statRaw(client, target);
      if (!info) {
        throw new FTPError(`No such file: ${target}`);
      }
      return info;
    });
  }

  async fileExists(remotePath: string): Promise<boolean> {
    const target = this.resolvePath(remotePath);
    return this.enqueue('exists', async (client) => {
      const info = await this.statRaw(client, target);
      return info !== null;
    });
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private setState(state: ConnectionState): void {
    this.state = state;
    this._onStateChange.fire(state);
  }

  /**
   * Run an FTP command under the serialization queue. The chain never rejects so
   * one failed command does not poison subsequent ones.
   */
  private enqueue<T>(label: string, fn: (client: FtpRawClient) => Promise<T>): Promise<T> {
    const run = this._chain.then(
      () => this.runOp(label, fn),
      () => this.runOp(label, fn)
    );
    this._chain = run.catch(() => undefined);
    return run;
  }

  private async runOp<T>(label: string, fn: (client: FtpRawClient) => Promise<T>): Promise<T> {
    const client = this._client;
    if (!client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('FTP connection is not connected');
    }
    const start = Date.now();
    diagLog('ftp-connection', 'op-begin', { connectionId: this.id, label });
    try {
      const result = await fn(client);
      diagLog('ftp-connection', 'op-end', { connectionId: this.id, label, durationMs: Date.now() - start });
      return result;
    } catch (error) {
      diagLog('ftp-connection', 'op-error', { connectionId: this.id, label, durationMs: Date.now() - start, errorMessage: (error as Error).message });
      // Robust drop detection: basic-ftp marks the client `closed` after any
      // timeout/connection error and on a server-initiated control-socket drop. The
      // cached-socket close handler (attachCloseHandler) can miss a socket swapped by
      // a TLS upgrade or reconnect, so also reconcile state from the failed op here —
      // flip to Disconnected so ConnectionManager's reconnect logic can react.
      if (client.closed && this.state === ConnectionState.Connected && !this._closing) {
        infoLog('ftp-connect', 'socket-close-detected-on-op', { connectionId: this.id, label });
        this.setState(ConnectionState.Disconnected);
      }
      throw error instanceof FTPError || error instanceof ConnectionError
        ? error
        : new FTPError(`FTP ${label} failed: ${(error as Error).message}`, error as Error);
    }
  }

  /** Resolve `~`/empty to the login directory; FTP paths are always POSIX. */
  private resolvePath(remotePath: string): string {
    if (!remotePath || remotePath === '~' || remotePath === '.') {
      return this._homePath;
    }
    if (remotePath.startsWith('~/')) {
      return path.posix.join(this._homePath, remotePath.slice(2));
    }
    return remotePath;
  }

  /** Stat by listing the parent directory and matching the basename (robust across servers). */
  private async statRaw(client: FtpRawClient, target: string): Promise<IRemoteFile | null> {
    const normalized = target.replace(/\/+$/, '') || '/';
    if (normalized === '/' || normalized === this._homePath) {
      return {
        name: path.posix.basename(normalized) || '/',
        path: normalized,
        isDirectory: true,
        size: 0,
        modifiedTime: 0,
        connectionId: this.id,
      };
    }
    const parent = path.posix.dirname(normalized);
    const base = path.posix.basename(normalized);
    const list = await client.list(parent);
    const match = list.find((f) => f.name === base);
    if (!match) {
      return null;
    }
    return this.mapFileInfo(match, parent);
  }

  private mapFileList(list: FileInfo[], basePath: string): IRemoteFile[] {
    return list
      .filter((item) => item.name !== '.' && item.name !== '..')
      .map((item) => this.mapFileInfo(item, basePath))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
  }

  private mapFileInfo(item: FileInfo, basePath: string): IRemoteFile {
    return {
      name: item.name,
      path: path.posix.join(basePath, item.name),
      isDirectory: item.isDirectory,
      size: item.size,
      // basic-ftp only fills `modifiedAt` for MLSD servers; LIST-mode servers
      // (the common case) leave it undefined and expose only `rawModifiedAt`.
      // Parse the raw string so timestamps don't collapse to 0 = 1970 (issue #15).
      modifiedTime: parseFtpModifiedTime(item.modifiedAt, item.rawModifiedAt) ?? 0,
      owner: item.user,
      group: item.group,
      permissions: item.permissions ? this.formatPermissions(item.permissions) : undefined,
      connectionId: this.id,
    };
  }

  private formatPermissions(p: UnixPermissions): string {
    // basic-ftp Permission bits: Read=4, Write=2, Execute=1
    const triad = (bits: number): string =>
      `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    return `${triad(p.user)}${triad(p.group)}${triad(p.world)}`;
  }

  private async _resolvePassword(): Promise<string> {
    if (this.host.anonymous === true) {
      return '';
    }
    const creds = CredentialService.getInstance();
    if (this._credential && this._credential.type === 'password') {
      // Discriminate "no secret stored" (undefined) from "a legitimately EMPTY
      // password was stored" (''). Some FTP accounts accept an empty password;
      // `!password` would discard a valid empty secret and re-prompt every connect.
      // This mirrors the no-stored-credential arm below, which also treats only
      // `undefined` as missing.
      let password = await creds.getCredentialSecret(this.id, this._credential.id);
      if (password === undefined || password === null) {
        password = await vscode.window.showInputBox({
          prompt: `Enter FTP password for ${this._credential.label} (${this.host.username}@${this.host.host})`,
          password: true,
          ignoreFocusOut: true,
        });
        if (password === undefined) {
          throw new AuthenticationError('Password is required');
        }
        const save = await vscode.window.showQuickPick(['Yes, remember this password', 'No, use only for this session'], {
          placeHolder: 'Save password?',
        });
        if (save === 'Yes, remember this password') {
          await creds.updateCredentialPassword(this.id, this._credential.id, password);
        } else {
          creds.setSessionCredential(this.id, this._credential.id, password);
        }
      }
      return password;
    }
    // No stored credential object — prompt directly.
    const password = await vscode.window.showInputBox({
      prompt: `Enter FTP password for ${this.host.username}@${this.host.host}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      throw new AuthenticationError('Password is required');
    }
    return password;
  }

  private classifyError(error: unknown): AuthenticationError | FTPError {
    const e = error as Error & { code?: number };
    const message = e?.message || String(error);
    const isAuth = e?.code === 530 || /\b530\b|not logged in|login incorrect|authentication|password/i.test(message);
    if (isAuth) {
      // Clear saved credentials so the user can retry, mirroring SSHConnection.
      try {
        CredentialService.getInstance().deleteAll(this.id);
      } catch {
        // ignore
      }
      return new AuthenticationError(`FTP authentication failed: ${message}. Saved credentials cleared - please try again.`, e);
    }
    return new FTPError(`FTP connection error: ${message}`, e);
  }

  /**
   * Surface an unexpected control-socket close as a Disconnected state so the
   * ConnectionManager's existing reconnect logic can react. Best-effort.
   */
  private attachCloseHandler(client: FtpRawClient): void {
    try {
      const socket = client.ftp.socket;
      socket.once('close', () => {
        if (this.state === ConnectionState.Connected && !this._closing) {
          infoLog('ftp-connect', 'socket-close-unexpected', { connectionId: this.id });
          this.setState(ConnectionState.Disconnected);
        }
      });
    } catch {
      // socket not available — ignore
    }
  }
}
