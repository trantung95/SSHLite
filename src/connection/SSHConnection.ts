import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as net from 'net';
import * as vscode from 'vscode';
import {
  ISSHConnection,
  IHostConfig,
  IRemoteFile,
  ConnectionState,
  AuthenticationError,
  ConnectionError,
  SFTPError,
} from '../types';
import { expandPath } from '../utils/helpers';

/**
 * SSH Connection implementation using ssh2 library
 */
export class SSHConnection implements ISSHConnection {
  public readonly id: string;
  public state: ConnectionState = ConnectionState.Disconnected;
  private _client: Client | null = null;
  private _sftp: SFTPWrapper | null = null;
  private _portForwards: Map<number, net.Server> = new Map();

  private readonly _onStateChange = new vscode.EventEmitter<ConnectionState>();
  public readonly onStateChange = this._onStateChange.event;

  constructor(public readonly host: IHostConfig) {
    this.id = `${host.host}:${host.port}:${host.username}`;
  }

  get client(): Client | null {
    return this._client;
  }

  /**
   * Connect to the SSH host
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.Connected) {
      return;
    }

    this.setState(ConnectionState.Connecting);
    this._client = new Client();

    const config = vscode.workspace.getConfiguration('sshLite');
    const timeout = config.get<number>('connectionTimeout', 10000);
    const keepaliveInterval = config.get<number>('keepaliveInterval', 30000);

    try {
      const authConfig = await this.buildAuthConfig();

      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new ConnectionError(`Connection timeout after ${timeout}ms`));
        }, timeout);

        this._client!.on('ready', () => {
          clearTimeout(timeoutId);
          resolve();
        });

        this._client!.on('error', (err) => {
          clearTimeout(timeoutId);
          if (err.message.includes('authentication') || err.message.includes('auth')) {
            reject(new AuthenticationError(`Authentication failed: ${err.message}`, err));
          } else {
            reject(new ConnectionError(`Connection error: ${err.message}`, err));
          }
        });

        this._client!.on('close', () => {
          this.handleDisconnect();
        });

        this._client!.connect({
          host: this.host.host,
          port: this.host.port,
          username: this.host.username,
          keepaliveInterval,
          readyTimeout: timeout,
          ...authConfig,
        });
      });

      this.setState(ConnectionState.Connected);
    } catch (error) {
      this.setState(ConnectionState.Error);
      this._client?.end();
      this._client = null;
      throw error;
    }
  }

  /**
   * Build authentication configuration
   */
  private async buildAuthConfig(): Promise<Record<string, unknown>> {
    // Try private key first
    if (this.host.privateKeyPath) {
      const keyPath = expandPath(this.host.privateKeyPath);
      if (fs.existsSync(keyPath)) {
        const privateKey = fs.readFileSync(keyPath);
        // Check if key is encrypted
        const keyContent = privateKey.toString();
        if (keyContent.includes('ENCRYPTED')) {
          const passphrase = await vscode.window.showInputBox({
            prompt: `Enter passphrase for key ${this.host.privateKeyPath}`,
            password: true,
            ignoreFocusOut: true,
          });
          return { privateKey, passphrase };
        }
        return { privateKey };
      }
    }

    // Try default key locations
    const defaultKeys = [
      '~/.ssh/id_rsa',
      '~/.ssh/id_ed25519',
      '~/.ssh/id_ecdsa',
      '~/.ssh/id_dsa',
    ];

    for (const keyPath of defaultKeys) {
      const expandedKeyPath = expandPath(keyPath);
      if (fs.existsSync(expandedKeyPath)) {
        const privateKey = fs.readFileSync(expandedKeyPath);
        const keyContent = privateKey.toString();
        if (keyContent.includes('ENCRYPTED')) {
          const passphrase = await vscode.window.showInputBox({
            prompt: `Enter passphrase for key ${keyPath}`,
            password: true,
            ignoreFocusOut: true,
          });
          if (passphrase !== undefined) {
            return { privateKey, passphrase };
          }
        } else {
          return { privateKey };
        }
      }
    }

    // Try SSH agent
    const agentSocket = process.env.SSH_AUTH_SOCK;
    if (agentSocket) {
      return { agent: agentSocket };
    }

    // Fall back to password
    const password = await vscode.window.showInputBox({
      prompt: `Enter password for ${this.host.username}@${this.host.host}`,
      password: true,
      ignoreFocusOut: true,
    });

    if (!password) {
      throw new AuthenticationError('Password not provided');
    }

    return { password };
  }

  /**
   * Handle disconnect event
   */
  private handleDisconnect(): void {
    // Close SFTP session properly
    if (this._sftp) {
      try {
        this._sftp.end();
      } catch {
        // Ignore cleanup errors
      }
      this._sftp = null;
    }
    this._client = null;
    // Close all port forwards with error handling
    for (const [, server] of this._portForwards) {
      try {
        server.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this._portForwards.clear();
    this.setState(ConnectionState.Disconnected);
  }

  /**
   * Set connection state and emit event
   */
  private setState(state: ConnectionState): void {
    this.state = state;
    this._onStateChange.fire(state);
  }

  /**
   * Disconnect from the SSH host
   */
  async disconnect(): Promise<void> {
    // Close SFTP session first
    if (this._sftp) {
      try {
        this._sftp.end();
      } catch {
        // Ignore cleanup errors
      }
      this._sftp = null;
    }

    // Close all port forwards
    for (const [, server] of this._portForwards) {
      try {
        server.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this._portForwards.clear();

    // Close client connection
    if (this._client) {
      this._client.end();
      this._client = null;
    }
    this.setState(ConnectionState.Disconnected);
  }

  /**
   * Get or create SFTP session
   */
  private async getSFTP(): Promise<SFTPWrapper> {
    if (this._sftp) {
      return this._sftp;
    }

    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    return new Promise((resolve, reject) => {
      this._client!.sftp((err, sftp) => {
        if (err) {
          reject(new SFTPError(`Failed to create SFTP session: ${err.message}`, err));
          return;
        }
        this._sftp = sftp;
        resolve(sftp);
      });
    });
  }

  /**
   * Execute a command on the remote host
   */
  async exec(command: string): Promise<string> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    return new Promise((resolve, reject) => {
      this._client!.exec(command, (err, stream) => {
        if (err) {
          reject(new SFTPError(`Failed to execute command: ${err.message}`, err));
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code !== 0 && stderr) {
            reject(new SFTPError(`Command failed (exit code ${code}): ${stderr}`));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  /**
   * Create an interactive shell
   */
  async shell(): Promise<ClientChannel> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    return new Promise((resolve, reject) => {
      this._client!.shell((err, stream) => {
        if (err) {
          reject(new SFTPError(`Failed to create shell: ${err.message}`, err));
          return;
        }
        resolve(stream);
      });
    });
  }

  /**
   * List files in a remote directory
   */
  async listFiles(remotePath: string): Promise<IRemoteFile[]> {
    const sftp = await this.getSFTP();
    const expandedPath = remotePath === '~' ? '.' : remotePath;

    return new Promise((resolve, reject) => {
      sftp.readdir(expandedPath, (err, list) => {
        if (err) {
          reject(new SFTPError(`Failed to list directory: ${err.message}`, err));
          return;
        }

        // Get the absolute path for home directory
        if (remotePath === '~') {
          sftp.realpath('.', (err2, absPath) => {
            if (err2) {
              // Fallback to relative path if realpath fails
              resolve(this.mapFileList(list, '.'));
            } else {
              resolve(this.mapFileList(list, absPath));
            }
          });
        } else {
          resolve(this.mapFileList(list, remotePath));
        }
      });
    });
  }

  /**
   * Map SFTP file list to IRemoteFile array
   */
  private mapFileList(
    list: Array<{ filename: string; longname: string; attrs: { size: number; mtime: number; mode: number } }>,
    basePath: string
  ): IRemoteFile[] {
    return list
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => ({
        name: item.filename,
        path: basePath === '.' ? item.filename : `${basePath}/${item.filename}`,
        isDirectory: (item.attrs.mode & 0o40000) !== 0,
        size: item.attrs.size,
        modifiedTime: item.attrs.mtime * 1000,
        connectionId: this.id,
      }))
      .sort((a, b) => {
        // Directories first, then alphabetically
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
  }

  /**
   * Read a remote file
   */
  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.getSFTP();

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      stream.on('error', (err: Error) => {
        stream.destroy();
        reject(new SFTPError(`Failed to read file: ${err.message}`, err));
      });
    });
  }

  /**
   * Write content to a remote file
   */
  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    const sftp = await this.getSFTP();

    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);

      stream.on('finish', () => {
        resolve();
      });

      stream.on('error', (err: Error) => {
        stream.destroy();
        reject(new SFTPError(`Failed to write file: ${err.message}`, err));
      });

      stream.end(content);
    });
  }

  /**
   * Delete a remote file or directory
   */
  async deleteFile(remotePath: string): Promise<void> {
    const sftp = await this.getSFTP();
    const stats = await this.stat(remotePath);

    return new Promise((resolve, reject) => {
      if (stats.isDirectory) {
        sftp.rmdir(remotePath, (err) => {
          if (err) {
            reject(new SFTPError(`Failed to delete directory: ${err.message}`, err));
            return;
          }
          resolve();
        });
      } else {
        sftp.unlink(remotePath, (err) => {
          if (err) {
            reject(new SFTPError(`Failed to delete file: ${err.message}`, err));
            return;
          }
          resolve();
        });
      }
    });
  }

  /**
   * Create a remote directory
   */
  async mkdir(remotePath: string): Promise<void> {
    const sftp = await this.getSFTP();

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) {
          reject(new SFTPError(`Failed to create directory: ${err.message}`, err));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Get file stats
   */
  async stat(remotePath: string): Promise<IRemoteFile> {
    const sftp = await this.getSFTP();

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          reject(new SFTPError(`Failed to stat file: ${err.message}`, err));
          return;
        }

        const name = remotePath.split('/').pop() || remotePath;
        resolve({
          name,
          path: remotePath,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modifiedTime: stats.mtime * 1000,
          connectionId: this.id,
        });
      });
    });
  }

  /**
   * Forward a local port to a remote port
   */
  async forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<void> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    if (this._portForwards.has(localPort)) {
      throw new SFTPError(`Port ${localPort} is already forwarded`);
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._client!.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              socket.end();
              return;
            }
            socket.pipe(stream).pipe(socket);
          }
        );
      });

      server.on('error', (err) => {
        reject(new SFTPError(`Failed to start port forward: ${err.message}`, err));
      });

      server.listen(localPort, '127.0.0.1', () => {
        this._portForwards.set(localPort, server);
        resolve();
      });
    });
  }

  /**
   * Stop a port forward
   */
  async stopForward(localPort: number): Promise<void> {
    const server = this._portForwards.get(localPort);
    if (server) {
      server.close();
      this._portForwards.delete(localPort);
    }
  }

  /**
   * Get active port forwards
   */
  getActiveForwards(): number[] {
    return Array.from(this._portForwards.keys());
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.disconnect();
    this._onStateChange.dispose();
  }
}
