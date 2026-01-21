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
import { CredentialService, SavedCredential } from '../services/CredentialService';

/**
 * Server capabilities detected on connection
 */
export interface ServerCapabilities {
  os: 'linux' | 'darwin' | 'windows' | 'unknown';
  hasInotifywait: boolean;  // Linux file watcher
  hasFswatch: boolean;      // macOS/BSD file watcher
  watchMethod: 'inotifywait' | 'fswatch' | 'poll';
}

/**
 * SSH Connection implementation using ssh2 library
 */
export class SSHConnection implements ISSHConnection {
  public readonly id: string;
  public state: ConnectionState = ConnectionState.Disconnected;
  private _client: Client | null = null;
  private _sftp: SFTPWrapper | null = null;
  private _portForwards: Map<number, net.Server> = new Map();
  private _credential: SavedCredential | undefined;
  private _capabilities: ServerCapabilities | null = null;
  private _activeWatchers: Map<string, ClientChannel> = new Map(); // remotePath -> watcher channel

  private readonly _onStateChange = new vscode.EventEmitter<ConnectionState>();
  public readonly onStateChange = this._onStateChange.event;

  // Event emitter for file changes detected by watchers
  private readonly _onFileChange = new vscode.EventEmitter<{ remotePath: string; event: 'modify' | 'delete' | 'create' }>();
  public readonly onFileChange = this._onFileChange.event;

  constructor(public readonly host: IHostConfig, credential?: SavedCredential) {
    this.id = `${host.host}:${host.port}:${host.username}`;
    this._credential = credential;
  }

  get capabilities(): ServerCapabilities | null {
    return this._capabilities;
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
          const msg = err.message.toLowerCase();
          if (msg.includes('authentication') || msg.includes('auth') || msg.includes('permission denied') || msg.includes('publickey')) {
            // Clear saved credentials on auth failure so user can retry
            CredentialService.getInstance().deleteAll(this.id);
            reject(new AuthenticationError(`Authentication failed: ${err.message}. Saved credentials cleared - please try again.`, err));
          } else {
            reject(new ConnectionError(`Connection error: ${err.message}`, err));
          }
        });

        this._client!.on('close', () => {
          this.handleDisconnect();
        });

        // Handle keyboard-interactive authentication
        this._client!.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
          // Use saved password for keyboard-interactive prompts
          const responses = prompts.map(() => authConfig.password as string || '');
          finish(responses);
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

      // Detect server capabilities in background (don't block connection)
      this.detectCapabilities().catch(() => {
        // Silently ignore capability detection errors - will fall back to poll
      });
    } catch (error) {
      this.setState(ConnectionState.Error);
      this._client?.end();
      this._client = null;
      throw error;
    }
  }

  /**
   * Detect server capabilities (OS, file watcher availability)
   */
  private async detectCapabilities(): Promise<void> {
    try {
      // Detect OS
      const unameResult = await this.exec('uname -s 2>/dev/null || echo unknown');
      const osName = unameResult.trim().toLowerCase();

      let os: ServerCapabilities['os'] = 'unknown';
      if (osName === 'linux') os = 'linux';
      else if (osName === 'darwin') os = 'darwin';
      else if (osName.includes('mingw') || osName.includes('cygwin') || osName.includes('msys')) os = 'windows';

      // Check for inotifywait (Linux)
      const hasInotifywait = os === 'linux' &&
        (await this.exec('which inotifywait 2>/dev/null')).trim().length > 0;

      // Check for fswatch (macOS/BSD)
      const hasFswatch = (os === 'darwin' || os === 'unknown') &&
        (await this.exec('which fswatch 2>/dev/null')).trim().length > 0;

      // Determine best watch method
      let watchMethod: ServerCapabilities['watchMethod'] = 'poll';
      if (hasInotifywait) watchMethod = 'inotifywait';
      else if (hasFswatch) watchMethod = 'fswatch';

      this._capabilities = { os, hasInotifywait, hasFswatch, watchMethod };
    } catch {
      // Default to poll if detection fails
      this._capabilities = {
        os: 'unknown',
        hasInotifywait: false,
        hasFswatch: false,
        watchMethod: 'poll',
      };
    }
  }

  /**
   * Build authentication configuration
   * Uses specific credential if provided, otherwise tries multiple methods
   */
  private async buildAuthConfig(): Promise<Record<string, unknown>> {
    const creds = CredentialService.getInstance();
    const authMethods: Record<string, unknown> = {};

    // If a specific credential was provided, use only that
    if (this._credential) {
      if (this._credential.type === 'password') {
        // Get password from credential storage
        const password = await creds.getCredentialSecret(this.id, this._credential.id);
        if (password) {
          authMethods.password = password;
        } else {
          throw new AuthenticationError('Credential password not found');
        }
      } else if (this._credential.type === 'privateKey' && this._credential.privateKeyPath) {
        // Use private key from credential
        const keyPath = expandPath(this._credential.privateKeyPath);
        if (fs.existsSync(keyPath)) {
          authMethods.privateKey = fs.readFileSync(keyPath);
          // Get passphrase if stored
          const passphrase = await creds.getCredentialSecret(this.id, this._credential.id);
          if (passphrase) {
            authMethods.passphrase = passphrase;
          }
        } else {
          throw new AuthenticationError(`Private key not found: ${keyPath}`);
        }
      }

      // Enable keyboard-interactive as fallback
      authMethods.tryKeyboard = true;
      return authMethods;
    }

    // No specific credential - try multiple auth methods (legacy behavior)
    // Collect all available private keys
    const privateKeys: Buffer[] = [];
    const passphrases: string[] = [];

    // Check configured private key
    if (this.host.privateKeyPath) {
      const keyPath = expandPath(this.host.privateKeyPath);
      if (fs.existsSync(keyPath)) {
        const privateKey = fs.readFileSync(keyPath);
        privateKeys.push(privateKey);
        if (privateKey.toString().includes('ENCRYPTED')) {
          const passphrase = await creds.getOrPrompt(this.id, 'passphrase', `Passphrase for ${this.host.privateKeyPath}`);
          if (passphrase) passphrases.push(passphrase);
        }
      }
    }

    // Check default key locations
    for (const keyPath of ['~/.ssh/id_rsa', '~/.ssh/id_ed25519', '~/.ssh/id_ecdsa']) {
      const expanded = expandPath(keyPath);
      if (fs.existsSync(expanded)) {
        const privateKey = fs.readFileSync(expanded);
        privateKeys.push(privateKey);
        if (privateKey.toString().includes('ENCRYPTED')) {
          const passphrase = await creds.getOrPrompt(this.id, 'passphrase', `Passphrase for ${keyPath}`);
          if (passphrase) passphrases.push(passphrase);
        }
      }
    }

    // Add keys if found
    if (privateKeys.length > 0) {
      authMethods.privateKey = privateKeys[0]; // ssh2 uses first key
      if (passphrases.length > 0) {
        authMethods.passphrase = passphrases[0];
      }
    }

    // Add SSH agent if available
    if (process.env.SSH_AUTH_SOCK) {
      authMethods.agent = process.env.SSH_AUTH_SOCK;
    }

    // Get password (saved or prompt) - always include for fallback
    const password = await creds.getOrPrompt(this.id, 'password', `Password for ${this.host.username}@${this.host.host}`);
    if (password) {
      authMethods.password = password;
    }

    // If no auth methods available, throw error
    if (Object.keys(authMethods).length === 0) {
      throw new AuthenticationError('No authentication method available');
    }

    // Enable trying all auth methods
    authMethods.tryKeyboard = true;

    return authMethods;
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

    // Close all file watchers
    for (const [, stream] of this._activeWatchers) {
      try {
        stream.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this._activeWatchers.clear();

    this._client = null;
    this._capabilities = null;

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
   * Parse owner and group from longname (ls -l format)
   * Example: "-rw-r--r--  1 user group  1234 Jan 20 10:30 filename"
   */
  private parseOwnerGroup(longname: string): { owner: string; group: string } {
    // Split by whitespace, handling multiple spaces
    const parts = longname.split(/\s+/);
    // Format: permissions, links, owner, group, size, month, day, time/year, filename
    // Minimum 8 parts for a valid longname
    if (parts.length >= 8) {
      return {
        owner: parts[2] || 'unknown',
        group: parts[3] || 'unknown',
      };
    }
    return { owner: 'unknown', group: 'unknown' };
  }

  /**
   * Convert Unix mode to permission string (e.g., "rwxr-xr-x")
   */
  private formatPermissions(mode: number): string {
    const perms = mode & 0o777; // Get only permission bits
    let result = '';

    // Owner permissions
    result += (perms & 0o400) ? 'r' : '-';
    result += (perms & 0o200) ? 'w' : '-';
    result += (perms & 0o100) ? 'x' : '-';

    // Group permissions
    result += (perms & 0o040) ? 'r' : '-';
    result += (perms & 0o020) ? 'w' : '-';
    result += (perms & 0o010) ? 'x' : '-';

    // Other permissions
    result += (perms & 0o004) ? 'r' : '-';
    result += (perms & 0o002) ? 'w' : '-';
    result += (perms & 0o001) ? 'x' : '-';

    return result;
  }

  /**
   * Map SFTP file list to IRemoteFile array
   */
  private mapFileList(
    list: Array<{ filename: string; longname: string; attrs: { size: number; mtime: number; atime: number; mode: number } }>,
    basePath: string
  ): IRemoteFile[] {
    return list
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => {
        // Build path, avoiding double slashes when basePath is '/'
        let itemPath: string;
        if (basePath === '.') {
          itemPath = item.filename;
        } else if (basePath === '/') {
          itemPath = `/${item.filename}`;
        } else {
          itemPath = `${basePath}/${item.filename}`;
        }

        // Parse owner and group from longname
        const { owner, group } = this.parseOwnerGroup(item.longname);

        return {
          name: item.filename,
          path: itemPath,
          isDirectory: (item.attrs.mode & 0o40000) !== 0,
          size: item.attrs.size,
          modifiedTime: item.attrs.mtime * 1000,
          accessTime: item.attrs.atime * 1000,
          owner,
          group,
          permissions: this.formatPermissions(item.attrs.mode),
          connectionId: this.id,
        };
      })
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
   * Read a remote file in chunks with progress reporting
   * Enables real progress tracking for large file downloads
   * @param remotePath - Path to remote file
   * @param onProgress - Callback for progress updates (bytesTransferred, totalBytes)
   * @param abortSignal - Optional abort signal to cancel download
   * @param chunkSize - Size of each chunk in bytes (default: 64KB)
   * @returns Buffer containing file contents
   */
  async readFileChunked(
    remotePath: string,
    onProgress: (transferred: number, total: number) => void,
    abortSignal?: { aborted: boolean },
    chunkSize: number = 64 * 1024
  ): Promise<Buffer> {
    const sftp = await this.getSFTP();

    // Get file size first for progress calculation
    const stats = await this.stat(remotePath);
    const totalSize = stats.size;

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let transferred = 0;

      // Create read stream with configurable high water mark for chunked reads
      const stream = sftp.createReadStream(remotePath, {
        highWaterMark: chunkSize,
      });

      stream.on('data', (chunk: Buffer) => {
        // Check for cancellation
        if (abortSignal?.aborted) {
          stream.destroy();
          reject(new SFTPError('Download cancelled by user'));
          return;
        }

        chunks.push(chunk);
        transferred += chunk.length;

        // Report progress
        onProgress(transferred, totalSize);
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
   * Read the last N lines of a remote file using tail command
   * Much faster than downloading entire file for preview
   * @param remotePath - Path to remote file
   * @param lineCount - Number of lines to read from end
   * @returns String containing the last N lines
   */
  async readFileLastLines(remotePath: string, lineCount: number): Promise<string> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    // Escape special shell characters in path to prevent command injection
    const escapedPath = remotePath.replace(/'/g, "'\\''");
    const command = `tail -n ${lineCount} '${escapedPath}'`;

    return this.exec(command);
  }

  /**
   * Read the first N lines of a remote file using head command
   * Useful for file type detection and header preview
   * @param remotePath - Path to remote file
   * @param lineCount - Number of lines to read from start
   * @returns String containing the first N lines
   */
  async readFileFirstLines(remotePath: string, lineCount: number): Promise<string> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    // Escape special shell characters in path to prevent command injection
    const escapedPath = remotePath.replace(/'/g, "'\\''");
    const command = `head -n ${lineCount} '${escapedPath}'`;

    return this.exec(command);
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
   * Read tail portion of a remote file starting from a specific byte offset
   * Used for efficient incremental file updates (e.g., growing log files)
   * @param remotePath - Path to remote file
   * @param offset - Byte offset to start reading from (0-based)
   * @returns Buffer containing data from offset to end of file
   */
  async readFileTail(remotePath: string, offset: number): Promise<Buffer> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    // Use tail with byte offset for efficient partial read
    // tail -c +N reads from byte N to end (1-based offset in tail)
    const tailOffset = offset + 1;
    // Escape special shell characters in path to prevent command injection
    const escapedPath = remotePath.replace(/'/g, "'\\''");
    const command = `tail -c +${tailOffset} '${escapedPath}'`;

    return new Promise((resolve, reject) => {
      this._client!.exec(command, (err, stream) => {
        if (err) {
          reject(new SFTPError(`Failed to read file tail: ${err.message}`, err));
          return;
        }

        const chunks: Buffer[] = [];

        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on('close', (code: number) => {
          if (code !== 0 && chunks.length === 0) {
            reject(new SFTPError(`Failed to read file tail (exit code ${code})`));
          } else {
            resolve(Buffer.concat(chunks));
          }
        });

        stream.stderr.on('data', () => {
          // Ignore stderr - tail may output warnings that don't affect result
        });
      });
    });
  }

  /**
   * Start watching a file for changes using inotifywait or fswatch
   * Emits 'onFileChange' events when file is modified
   * @param remotePath - Path to the file to watch
   * @returns true if watcher started successfully, false if not supported
   */
  async watchFile(remotePath: string): Promise<boolean> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      return false;
    }

    // Stop any existing watcher for this file
    await this.unwatchFile(remotePath);

    // Wait for capabilities to be detected (with timeout)
    let waitCount = 0;
    while (!this._capabilities && waitCount < 20) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }

    const caps = this._capabilities;
    if (!caps || caps.watchMethod === 'poll') {
      return false; // No native watch support, caller should use polling
    }

    // Escape path for shell
    const escapedPath = remotePath.replace(/'/g, "'\\''");

    // Build watch command based on available tool
    let command: string;
    if (caps.watchMethod === 'inotifywait') {
      // inotifywait: -m = monitor mode, -e = events to watch
      // Output format: WATCHED_FILENAME EVENT
      command = `inotifywait -m -e modify,delete_self,move_self '${escapedPath}' 2>/dev/null`;
    } else if (caps.watchMethod === 'fswatch') {
      // fswatch: -o = one event per line, --event = event types
      command = `fswatch -o --event Updated --event Removed '${escapedPath}' 2>/dev/null`;
    } else {
      return false;
    }

    return new Promise((resolve) => {
      this._client!.exec(command, (err, stream) => {
        if (err) {
          resolve(false);
          return;
        }

        this._activeWatchers.set(remotePath, stream);

        stream.on('data', (data: Buffer) => {
          const output = data.toString().trim();
          if (!output) return;

          // Parse event type based on watcher
          let event: 'modify' | 'delete' | 'create' = 'modify';

          if (caps.watchMethod === 'inotifywait') {
            // inotifywait output: "/path/file MODIFY" or "MODIFY"
            if (output.includes('DELETE') || output.includes('MOVE_SELF')) {
              event = 'delete';
            } else if (output.includes('CREATE')) {
              event = 'create';
            }
          } else if (caps.watchMethod === 'fswatch') {
            // fswatch with -o outputs a number (count of changes)
            // With --event, it outputs the path
            if (output.includes('Removed')) {
              event = 'delete';
            }
          }

          this._onFileChange.fire({ remotePath, event });
        });

        stream.on('close', () => {
          this._activeWatchers.delete(remotePath);
        });

        stream.stderr.on('data', () => {
          // Ignore stderr
        });

        // Watcher started successfully
        resolve(true);
      });
    });
  }

  /**
   * Stop watching a file
   * @param remotePath - Path to stop watching
   */
  async unwatchFile(remotePath: string): Promise<void> {
    const stream = this._activeWatchers.get(remotePath);
    if (stream) {
      try {
        stream.close();
      } catch {
        // Ignore close errors
      }
      this._activeWatchers.delete(remotePath);
    }
  }

  /**
   * Stop all active file watchers
   */
  async unwatchAll(): Promise<void> {
    for (const [path] of this._activeWatchers) {
      await this.unwatchFile(path);
    }
  }

  /**
   * Check if a file is currently being watched
   */
  isWatching(remotePath: string): boolean {
    return this._activeWatchers.has(remotePath);
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
          accessTime: stats.atime * 1000,
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
   * Search for files/content in a remote directory using grep/find
   * @param searchPath - Directory to search in
   * @param pattern - Search pattern (for content search)
   * @param options - Search options
   * @returns Array of search results
   */
  async searchFiles(
    searchPath: string,
    pattern: string,
    options: {
      searchContent?: boolean; // Search file contents (grep) vs filenames (find)
      caseSensitive?: boolean;
      filePattern?: string; // File glob pattern (e.g., *.ts)
      excludePattern?: string; // Exclude pattern (e.g., node_modules, *.test.ts)
      maxResults?: number;
    } = {}
  ): Promise<Array<{ path: string; line?: number; match?: string; size?: number; modified?: Date; permissions?: string }>> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }

    const {
      searchContent = true,
      caseSensitive = false,
      filePattern = '*',
      excludePattern = '',
      maxResults = 500,
    } = options;

    // Escape special characters in pattern for shell
    const escapedPattern = pattern.replace(/['"\\$`!]/g, '\\$&');
    const caseFlag = caseSensitive ? '' : '-i';

    // Build exclude flags for grep/find
    let excludeFlags = '';
    if (excludePattern) {
      const excludePatterns = excludePattern.split(',').map((p) => p.trim()).filter(Boolean);
      for (const ep of excludePatterns) {
        if (searchContent) {
          // For grep: --exclude for files, --exclude-dir for directories
          if (ep.includes('/') || !ep.includes('.')) {
            excludeFlags += ` --exclude-dir="${ep}"`;
          } else {
            excludeFlags += ` --exclude="${ep}"`;
          }
        }
      }
    }

    let command: string;
    if (searchContent) {
      // Use grep for content search
      // -r: recursive, -n: line numbers, -H: show filename
      // --include: file pattern filter, --exclude/--exclude-dir: exclude patterns
      command = `grep -rnH ${caseFlag} --include="${filePattern}"${excludeFlags} -m ${maxResults} "${escapedPattern}" "${searchPath}" 2>/dev/null | head -${maxResults}`;
    } else {
      // Use find for filename search
      const findCaseFlag = caseSensitive ? '-name' : '-iname';
      // Build find exclude patterns
      let findExcludes = '';
      if (excludePattern) {
        const excludePatterns = excludePattern.split(',').map((p) => p.trim()).filter(Boolean);
        for (const ep of excludePatterns) {
          findExcludes += ` ! -path "*/${ep}/*" ! -name "${ep}"`;
        }
      }
      command = `find "${searchPath}" -type f ${findCaseFlag} "*${escapedPattern}*"${findExcludes} 2>/dev/null | head -${maxResults}`;
    }

    return new Promise((resolve, reject) => {
      this._client!.exec(command, (err, stream) => {
        if (err) {
          reject(new SFTPError(`Search failed: ${err.message}`, err));
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('data', (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        stream.on('close', async () => {
          const results: Array<{ path: string; line?: number; match?: string; size?: number; modified?: Date; permissions?: string }> = [];
          const uniquePaths = new Set<string>();

          if (searchContent) {
            // Parse grep output: filename:line:match
            const lines = output.trim().split('\n').filter(Boolean);
            for (const line of lines) {
              const colonIndex = line.indexOf(':');
              if (colonIndex === -1) continue;

              const filePath = line.substring(0, colonIndex);
              uniquePaths.add(filePath);
              const rest = line.substring(colonIndex + 1);
              const secondColonIndex = rest.indexOf(':');

              if (secondColonIndex !== -1) {
                const lineNum = parseInt(rest.substring(0, secondColonIndex), 10);
                const match = rest.substring(secondColonIndex + 1);
                results.push({
                  path: filePath,
                  line: isNaN(lineNum) ? undefined : lineNum,
                  match: match.trim(),
                });
              } else {
                results.push({ path: filePath, match: rest.trim() });
              }
            }
          } else {
            // Parse find output: just file paths
            const lines = output.trim().split('\n').filter(Boolean);
            for (const filePath of lines) {
              const trimmedPath = filePath.trim();
              uniquePaths.add(trimmedPath);
              results.push({ path: trimmedPath });
            }
          }

          // Fetch file stats for unique paths (limit to avoid slowdown)
          const pathsToStat = Array.from(uniquePaths).slice(0, 100);
          const statsMap = new Map<string, { size: number; modified: Date; permissions: string }>();

          try {
            const sftp = await this.getSFTP();
            await Promise.all(
              pathsToStat.map(async (filePath) => {
                try {
                  const stats = await new Promise<{ size: number; mtime: number; mode: number }>((res, rej) => {
                    sftp.stat(filePath, (err: Error | undefined, s: { size: number; mtime: number; mode: number }) => {
                      if (err) rej(err);
                      else res(s);
                    });
                  });
                  const permissions = ((stats.mode & 0o400) ? 'r' : '-') +
                    ((stats.mode & 0o200) ? 'w' : '-') +
                    ((stats.mode & 0o100) ? 'x' : '-') +
                    ((stats.mode & 0o040) ? 'r' : '-') +
                    ((stats.mode & 0o020) ? 'w' : '-') +
                    ((stats.mode & 0o010) ? 'x' : '-') +
                    ((stats.mode & 0o004) ? 'r' : '-') +
                    ((stats.mode & 0o002) ? 'w' : '-') +
                    ((stats.mode & 0o001) ? 'x' : '-');
                  statsMap.set(filePath, {
                    size: stats.size,
                    modified: new Date(stats.mtime * 1000),
                    permissions,
                  });
                } catch {
                  // Ignore stat errors for individual files
                }
              })
            );
          } catch {
            // Ignore if SFTP fails - stats are optional
          }

          // Enrich results with stats
          for (const result of results) {
            const stats = statsMap.get(result.path);
            if (stats) {
              result.size = stats.size;
              result.modified = stats.modified;
              result.permissions = stats.permissions;
            }
          }

          resolve(results);
        });
      });
    });
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.disconnect();
    this._onStateChange.dispose();
  }
}
