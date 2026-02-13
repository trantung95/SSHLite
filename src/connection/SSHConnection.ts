import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
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

// Shared output channel for SSH command logging
let sshOutputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
  if (!sshOutputChannel) {
    sshOutputChannel = vscode.window.createOutputChannel('SSH Lite Commands');
  }
  return sshOutputChannel;
}

function logSSHCommand(host: string, command: string): void {
  const timestamp = new Date().toISOString();
  // Log the FULL command for debugging - no truncation
  getOutputChannel().appendLine(`[${timestamp}] [SSH ${host}] $ ${command}`);
}

function logSFTPOperation(host: string, operation: string, path: string, detail?: string): void {
  const timestamp = new Date().toISOString();
  const detailStr = detail ? ` (${detail})` : '';
  getOutputChannel().appendLine(`[${timestamp}] [SFTP ${host}] ${operation}: ${path}${detailStr}`);
}

// Known hosts storage key
const KNOWN_HOSTS_KEY = 'sshLite.knownHosts';

// Global state for known hosts (set by extension on activation)
let globalState: vscode.Memento | null = null;

/**
 * Set the global state for known hosts storage
 * Called by extension.ts on activation
 */
export function setGlobalState(state: vscode.Memento): void {
  globalState = state;
}

/**
 * Get known hosts from storage
 */
function getKnownHosts(): Record<string, string> {
  if (!globalState) return {};
  return globalState.get<Record<string, string>>(KNOWN_HOSTS_KEY, {});
}

/**
 * Save known host to storage
 */
async function saveKnownHost(hostKey: string, fingerprint: string): Promise<void> {
  if (!globalState) return;
  const knownHosts = getKnownHosts();
  knownHosts[hostKey] = fingerprint;
  await globalState.update(KNOWN_HOSTS_KEY, knownHosts);
}

/**
 * Generate host key fingerprint (SHA256)
 */
function getHostKeyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64');
}

/**
 * Verify host key and prompt user if needed
 * Returns true if connection should proceed, false otherwise
 */
async function verifyHostKey(
  host: string,
  port: number,
  hostKey: Buffer
): Promise<boolean> {
  const hostIdentifier = `${host}:${port}`;
  const fingerprint = getHostKeyFingerprint(hostKey);
  const knownHosts = getKnownHosts();
  const storedFingerprint = knownHosts[hostIdentifier];

  if (storedFingerprint === fingerprint) {
    // Known host, fingerprint matches
    return true;
  }

  if (storedFingerprint) {
    // WARNING: Host key has changed!
    const choice = await vscode.window.showWarningMessage(
      `⚠️ WARNING: HOST KEY CHANGED for ${host}!\n\n` +
      `This could indicate a man-in-the-middle attack or server reconfiguration.\n\n` +
      `Old fingerprint: SHA256:${storedFingerprint.substring(0, 16)}...\n` +
      `New fingerprint: SHA256:${fingerprint.substring(0, 16)}...`,
      { modal: true },
      'Accept New Key',
      'Reject'
    );

    if (choice === 'Accept New Key') {
      await saveKnownHost(hostIdentifier, fingerprint);
      return true;
    }
    return false;
  }

  // New host - ask user to verify
  const choice = await vscode.window.showInformationMessage(
    `The authenticity of host '${host}' can't be established.\n\n` +
    `Fingerprint: SHA256:${fingerprint}\n\n` +
    `Are you sure you want to continue connecting?`,
    { modal: true },
    'Yes, Connect',
    'No'
  );

  if (choice === 'Yes, Connect') {
    await saveKnownHost(hostIdentifier, fingerprint);
    return true;
  }
  return false;
}

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
   * Get the credential used for this connection
   */
  get credential(): SavedCredential | undefined {
    return this._credential;
  }

  /**
   * Connect to the SSH host
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.Connected) {
      return;
    }

    // Validate host config before attempting connection
    const hostInfo = `host=${this.host.host}, port=${this.host.port}, username=${this.host.username}, name=${this.host.name}, source=${this.host.source}`;
    getOutputChannel().appendLine(`[${new Date().toISOString()}] [CONNECT] Attempting connection: ${hostInfo}`);

    if (!this.host.username || this.host.username.trim() === '') {
      const msg = `Invalid host configuration: username is missing or empty. Host config: ${hostInfo}`;
      getOutputChannel().appendLine(`[${new Date().toISOString()}] [CONNECT] FAILED: ${msg}`);
      throw new ConnectionError(msg);
    }
    if (!this.host.host || this.host.host.trim() === '') {
      const msg = `Invalid host configuration: hostname is missing or empty. Host config: ${hostInfo}`;
      getOutputChannel().appendLine(`[${new Date().toISOString()}] [CONNECT] FAILED: ${msg}`);
      throw new ConnectionError(msg);
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
          getOutputChannel().appendLine(`[${new Date().toISOString()}] [CONNECT] SSH2 error for ${this.host.host}:${this.host.port}: ${err.message}`);
          const msg = err.message.toLowerCase();
          if (msg.includes('authentication') || msg.includes('auth') || msg.includes('permission denied') || msg.includes('publickey') || msg.includes('invalid username')) {
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
          // Host key verification for MITM protection
          hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
            verifyHostKey(this.host.host, this.host.port, key)
              .then((accepted) => {
                if (accepted) {
                  verify(true);
                } else {
                  verify(false);
                  reject(new ConnectionError('Host key verification failed - connection rejected by user'));
                }
              })
              .catch(() => {
                verify(false);
                reject(new ConnectionError('Host key verification failed'));
              });
          },
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
        let password = await creds.getCredentialSecret(this.id, this._credential.id);
        if (!password) {
          // Password not found - prompt user to enter it
          password = await vscode.window.showInputBox({
            prompt: `Enter password for ${this._credential.label} (${this.host.username}@${this.host.host})`,
            password: true,
            ignoreFocusOut: true,
          });
          if (!password) {
            throw new AuthenticationError('Password is required');
          }
          // Ask if user wants to save the password
          const save = await vscode.window.showQuickPick(['Yes, remember this password', 'No, use only for this session'], {
            placeHolder: 'Save password?',
          });
          if (save === 'Yes, remember this password') {
            await creds.updateCredentialPassword(this.id, this._credential.id, password);
          } else {
            // Store in session only
            creds.setSessionCredential(this.id, this._credential.id, password);
          }
        }
        authMethods.password = password;
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

    // Close client connection - the 'close' event will call handleDisconnect()
    // which sets state to Disconnected. Don't call setState here to avoid
    // double state change events that could trigger unwanted auto-reconnect.
    if (this._client) {
      this._client.end();
      this._client = null;
    } else {
      // Client already null, manually set state
      this.setState(ConnectionState.Disconnected);
    }
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

    // Log the command being executed
    logSSHCommand(this.host.name, command);

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
    logSFTPOperation(this.host.name, 'LIST', remotePath);
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
    logSFTPOperation(this.host.name, 'READ', remotePath);
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

    // Validate lineCount to prevent command injection
    const validatedLineCount = Math.max(1, Math.min(Math.floor(Number(lineCount) || 1), 100000));

    // Escape special shell characters in path to prevent command injection
    const escapedPath = remotePath.replace(/'/g, "'\\''");
    const command = `tail -n ${validatedLineCount} '${escapedPath}'`;

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

    // Validate lineCount to prevent command injection
    const validatedLineCount = Math.max(1, Math.min(Math.floor(Number(lineCount) || 1), 100000));

    // Escape special shell characters in path to prevent command injection
    const escapedPath = remotePath.replace(/'/g, "'\\''");
    const command = `head -n ${validatedLineCount} '${escapedPath}'`;

    return this.exec(command);
  }

  /**
   * Write content to a remote file
   */
  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    logSFTPOperation(this.host.name, 'WRITE', remotePath, `${content.length} bytes`);
    const sftp = await this.getSFTP();

    const WRITE_TIMEOUT_MS = 60_000; // 60 second timeout for slow servers

    // Use sftp.writeFile() instead of createWriteStream — the callback fires only
    // after the file is fully written AND the SFTP handle is closed on the server.
    // createWriteStream's 'finish' event fires when data is flushed to the SSH socket,
    // which can be before the server confirms the close, causing false failures.
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new SFTPError('Write timed out after 60 seconds', new Error('SFTP write timeout')));
        }
      }, WRITE_TIMEOUT_MS);

      sftp.writeFile(remotePath, content, (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (err) {
            reject(new SFTPError(`Failed to write file: ${err.message}`, err));
          } else {
            resolve();
          }
        }
      });
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
   * Rename or move a remote file/directory.
   * SFTP rename works as both rename and move — changing the path moves the file.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSFTP();

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          reject(new SFTPError(`Failed to rename ${oldPath} to ${newPath}: ${err.message}`, err));
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

    // Validate offset to prevent command injection (must be non-negative integer)
    const validatedOffset = Math.max(0, Math.floor(Number(offset) || 0));

    // Use tail with byte offset for efficient partial read
    // tail -c +N reads from byte N to end (1-based offset in tail)
    const tailOffset = validatedOffset + 1;
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
   * Check if a file exists on the remote server
   */
  async fileExists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
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
   * List immediate subdirectories of a path.
   * Used by parallel search to split a large directory into sub-searches.
   */
  async listDirectories(dirPath: string): Promise<string[]> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }
    const escaped = dirPath.replace(/'/g, "'\\''");
    const output = await this.exec(
      `find '${escaped}' -maxdepth 1 -mindepth 1 -type d 2>/dev/null`
    );
    return output.trim().split('\n').filter(Boolean).sort();
  }

  /**
   * List files and subdirectories at one level of a directory (non-recursive).
   * Used by the search worker pool for file-level parallelism.
   * Returns both files (with optional name filter) and subdirectories in a single SSH call.
   */
  async listEntries(
    dirPath: string,
    filePattern?: string
  ): Promise<{ files: string[]; dirs: string[] }> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }
    const escaped = dirPath.replace(/'/g, "'\\''");
    const nameFilter =
      filePattern && filePattern !== '*'
        ? `-name '${filePattern.replace(/'/g, "'\\''")}'`
        : '';
    // Single SSH exec: list files (with optional pattern), then dirs, separated by marker
    const command =
      `find '${escaped}' -maxdepth 1 -mindepth 1 -type f ${nameFilter} 2>/dev/null; ` +
      `echo '<<DIR_MARKER>>'; ` +
      `find '${escaped}' -maxdepth 1 -mindepth 1 -type d 2>/dev/null`;

    const output = await this.exec(command);
    const parts = output.split('<<DIR_MARKER>>');
    const fileSection = parts[0] || '';
    const dirSection = parts[1] || '';

    return {
      files: fileSection.trim().split('\n').filter(Boolean).sort(),
      dirs: dirSection.trim().split('\n').filter(Boolean).sort(),
    };
  }

  /**
   * Search for files/content in a remote directory using grep/find
   * @param searchPath - Directory or directories to search in
   * @param pattern - Search pattern (for content search)
   * @param options - Search options
   * @returns Array of search results
   */
  async searchFiles(
    searchPath: string | string[],
    pattern: string,
    options: {
      searchContent?: boolean; // Search file contents (grep) vs filenames (find)
      caseSensitive?: boolean;
      regex?: boolean; // Use regex matching (default: false = literal string matching)
      filePattern?: string; // File glob pattern (e.g., *.ts)
      excludePattern?: string; // Exclude pattern (e.g., node_modules, *.test.ts)
      maxResults?: number;
      signal?: AbortSignal; // Abort signal to cancel the search
      findType?: 'f' | 'd' | 'both'; // For find: files, directories, or both (default: 'f')
    } = {}
  ): Promise<Array<{ path: string; line?: number; match?: string; size?: number; modified?: Date; permissions?: string }>> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }

    const {
      searchContent = true,
      caseSensitive = false,
      regex = false,
      filePattern = '*',
      excludePattern = '',
      maxResults = 2000,
      signal,
    } = options;

    // Check if already aborted before starting
    if (signal?.aborted) {
      return [];
    }

    // Validate maxResults to prevent command injection (must be positive integer, 0 = unlimited)
    const validatedMaxResults = maxResults === 0 ? 0 : Math.max(1, Math.floor(Number(maxResults) || 2000));

    // Escape for single quotes (most secure shell escaping)
    // Single quotes prevent ALL shell expansion except single quotes themselves
    // To include a single quote, we end the string, add escaped quote, and start new string: '\''
    const escapeForSingleQuotes = (str: string): string => str.replace(/'/g, "'\\''");

    const escapedPattern = escapeForSingleQuotes(pattern);
    // Support single path or multiple paths for parallel search
    const searchPaths = Array.isArray(searchPath) ? searchPath : [searchPath];
    const escapedSearchPaths = searchPaths.map((p) => `'${escapeForSingleQuotes(p)}'`).join(' ');
    const escapedFilePattern = escapeForSingleQuotes(filePattern);
    const caseFlag = caseSensitive ? '' : '-i';
    // Use -F for fixed string matching (literal text, not regex) unless user wants regex
    // This allows searching for text with special chars like "audio/ogg; codecs=opus"
    const fixedStringFlag = regex ? '' : '-F';

    // Build exclude flags for grep/find
    let excludeFlags = '';
    if (excludePattern) {
      const excludePatterns = excludePattern.split(',').map((p) => p.trim()).filter(Boolean);
      for (const ep of excludePatterns) {
        if (searchContent) {
          // Escape the exclude pattern for shell safety
          const escapedEp = escapeForSingleQuotes(ep);
          // Always apply both --exclude (files) and --exclude-dir (directories)
          // so patterns like *uat* exclude both files and directories matching the glob
          excludeFlags += ` --exclude='${escapedEp}' --exclude-dir='${escapedEp}'`;
        }
      }
    }

    let command: string;
    const headLimit = validatedMaxResults > 0 ? ` | head -${validatedMaxResults}` : '';
    if (searchContent) {
      // Use grep for content search
      // -r: recursive, -n: line numbers, -H: show filename, -F: fixed string (literal, not regex)
      // --include: file pattern filter, --exclude/--exclude-dir: exclude patterns
      // -- signals end of options, allowing patterns that start with dash (e.g., -lfsms-)
      const grepMaxFlag = validatedMaxResults > 0 ? `-m ${validatedMaxResults}` : '';
      command = `grep -rnH ${fixedStringFlag} ${caseFlag} --include='${escapedFilePattern}'${excludeFlags} ${grepMaxFlag} -- '${escapedPattern}' ${escapedSearchPaths} 2>/dev/null${headLimit}`;
    } else {
      // Use find for filename search
      const findCaseFlag = caseSensitive ? '-name' : '-iname';
      // Determine type flag based on findType option
      const ft = options.findType || 'f';
      const typeFlag = ft === 'f' ? '-type f' : ft === 'd' ? '-type d' : '\\( -type f -o -type d \\)';
      // Build find exclude patterns
      let findExcludes = '';
      if (excludePattern) {
        const excludePatterns = excludePattern.split(',').map((p) => p.trim()).filter(Boolean);
        for (const ep of excludePatterns) {
          const escapedEp = escapeForSingleQuotes(ep);
          findExcludes += ` ! -path '*/${escapedEp}/*' ! -name '${escapedEp}'`;
        }
      }
      command = `find ${escapedSearchPaths} ${typeFlag} ${findCaseFlag} '*${escapedPattern}*'${findExcludes} 2>/dev/null${headLimit}`;
    }

    // Log the search command
    logSSHCommand(this.host.name, command);

    return new Promise((resolve, reject) => {
      this._client!.exec(command, (err, stream) => {
        if (err) {
          reject(new SFTPError(`Search failed: ${err.message}`, err));
          return;
        }

        // Register abort handler to kill the remote process
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          // Send SIGTERM to explicitly kill the remote process before closing the channel.
          // stream.signal() may not be supported by all SSH servers; stream.close()
          // sends channel_close which usually causes SSHD to send SIGHUP as fallback.
          try { stream.signal('TERM'); } catch { /* signal not supported */ }
          stream.close();
        };
        if (signal) {
          if (signal.aborted) {
            try { stream.signal('TERM'); } catch { /* signal not supported */ }
            stream.close();
            resolve([]);
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
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
          // Clean up abort listener
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }

          // If aborted, return empty results
          if (aborted) {
            resolve([]);
            return;
          }
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

          // Sort results: by path alphabetically, then by line number
          results.sort((a, b) => {
            const pathCompare = a.path.localeCompare(b.path);
            if (pathCompare !== 0) return pathCompare;
            // Same file - sort by line number
            if (a.line !== undefined && b.line !== undefined) {
              return a.line - b.line;
            }
            return 0;
          });

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
