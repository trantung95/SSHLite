import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
  ISSHConnection,
  IConnectionCapabilities,
  IHostConfig,
  IRemoteFile,
  ConnectionState,
  AuthenticationError,
  ConnectionError,
  SFTPError,
} from '../types';
import { expandPath } from '../utils/helpers';
import { buildHostId } from '../utils/hostId';
import { isPrivateKeyEncrypted } from './keyEncryption';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { diagLog, infoLog } from '../utils/diagnosticLog';
import {
  RemoteSearchTools,
  LEGACY_TOOLS,
  SearchTool,
  ContentSearchOpts,
  FilenameSearchOpts,
  BuiltSearchCommand,
  buildContentSearchCommand,
  buildFilenameSearchCommand,
  buildLocateCommand,
  buildToolProbeCommand,
  buildIndexStalenessCommand,
  parseToolProbeOutput,
  shouldFallbackToLegacy,
  describeStrategy,
  validateMaxResults,
} from './searchCommandBuilder';

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

/** One row of a search result (content match or filename hit), optionally stat-enriched. */
export interface SearchResultRow {
  path: string;
  line?: number;
  match?: string;
  size?: number;
  modified?: Date;
  permissions?: string;
}

/**
 * SSH Connection implementation using ssh2 library
 */
export class SSHConnection implements ISSHConnection {
  /**
   * Global counter of `readFile`-class operations across all SSHConnection
   * instances. Bumped at the start of `readFile`, `readFileChunked`, and
   * `readFileTail`. Used by the `backgroundIdle` chaos invariant to detect
   * runaway background reads (e.g. a poll-based file watcher re-downloading
   * an unchanged file every 1 s — the click-during-search regression).
   * Reading is cheap and the bump is a single integer add — production-safe.
   */
  public static chaosReadFileCount = 0;

  public readonly id: string;
  public state: ConnectionState = ConnectionState.Disconnected;
  private _client: Client | null = null;
  private _sftp: SFTPWrapper | null = null;
  private _portForwards: Map<number, net.Server> = new Map();
  private _credential: SavedCredential | undefined;
  private _capabilities: ServerCapabilities | null = null;
  private _activeWatchers: Map<string, ClientChannel> = new Map(); // remotePath -> watcher channel

  // Sudo mode state — scoped to this connection only, cleared on disconnect
  private _sudoMode: boolean = false;
  private _sudoPassword: string | null = null;

  private readonly _onStateChange = new vscode.EventEmitter<ConnectionState>();
  public readonly onStateChange = this._onStateChange.event;

  // Event emitter for file changes detected by watchers
  private readonly _onFileChange = new vscode.EventEmitter<{ remotePath: string; event: 'modify' | 'delete' | 'create' }>();
  public readonly onFileChange = this._onFileChange.event;

  constructor(public readonly host: IHostConfig, credential?: SavedCredential) {
    this.id = buildHostId(host);
    this._credential = credential;
  }

  /** Server OS / watch-method capabilities (SSH-specific, detected after connect). */
  get serverCapabilities(): ServerCapabilities | null {
    return this._capabilities;
  }

  /** Protocol capabilities — an SSH connection supports the full feature set. */
  get capabilities(): IConnectionCapabilities {
    return {
      type: 'ssh',
      supportsExec: true,
      supportsShell: true,
      supportsPortForward: true,
      supportsNativeWatch: true,
      supportsSearch: true,
      supportsServerBackup: true,
      supportsSudo: true,
    };
  }

  get client(): Client | null {
    return this._client;
  }

  /**
   * Resolve the connection's home directory as an absolute path.
   * Protocol-agnostic entry point (IConnection) — replaces scattered `echo ~` calls.
   */
  async resolveHomePath(): Promise<string> {
    const home = (await this.exec('echo ~')).trim();
    if (home) return home;
    // Fallback only when the shell could not expand ~. Never build `/home/`
    // (the shared parent of all home dirs) from an empty username.
    return this.host.username ? `/home/${this.host.username}` : '/';
  }

  /** Whether sudo mode is active for this connection */
  get sudoMode(): boolean {
    return this._sudoMode;
  }

  /** The cached sudo password (only accessible internally for sudo operations) */
  get sudoPassword(): string | null {
    return this._sudoPassword;
  }

  /** Enable sudo mode — all CommandGuard operations will route through sudo */
  enableSudoMode(password: string): void {
    this._sudoMode = true;
    this._sudoPassword = password;
  }

  /** Disable sudo mode — operations revert to normal SFTP */
  disableSudoMode(): void {
    this._sudoMode = false;
    this._sudoPassword = null;
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
    const connectStart = Date.now();

    infoLog('ssh-connect', 'begin', {
      connectionId: this.id,
      host: this.host.host,
      port: this.host.port,
      username: this.host.username,
      hostName: this.host.name,
      source: this.host.source,
      readyTimeoutMs: timeout,
      keepaliveIntervalMs: keepaliveInterval,
      hasCredential: !!this._credential,
      credentialType: this._credential?.type,
    });

    try {
      const authConfig = await this.buildAuthConfig();
      const advertisedAuth = Object.keys(authConfig).filter(k => k !== 'passphrase');
      infoLog('ssh-connect', 'auth-methods', {
        connectionId: this.id,
        methods: advertisedAuth,
        privateKeyBytes: typeof authConfig.privateKey === 'object' && authConfig.privateKey instanceof Buffer ? authConfig.privateKey.length : undefined,
        agent: !!authConfig.agent,
        tryKeyboard: !!authConfig.tryKeyboard,
      });

      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          infoLog('ssh-connect', 'ready-timeout', {
            connectionId: this.id,
            timeoutMs: timeout,
            elapsedMs: Date.now() - connectStart,
          });
          reject(new ConnectionError(`Connection timeout after ${timeout}ms`));
        }, timeout);

        this._client!.on('ready', () => {
          clearTimeout(timeoutId);
          infoLog('ssh-connect', 'ready', {
            connectionId: this.id,
            elapsedMs: Date.now() - connectStart,
          });
          resolve();
        });

        // ssh2 fires 'handshake' with negotiated cipher/kex/server algorithms — gold for diagnosing protocol mismatches
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._client as any).on('handshake', (negotiated: Record<string, unknown>) => {
          diagLog('ssh-connect', 'handshake', {
            connectionId: this.id,
            elapsedMs: Date.now() - connectStart,
            kex: (negotiated as { kex?: string }).kex,
            serverHostKey: (negotiated as { serverHostKey?: string }).serverHostKey,
            cs: (negotiated as { cs?: unknown }).cs,
            sc: (negotiated as { sc?: unknown }).sc,
          });
        });

        // ssh2 emits the SSH server's banner string on the 'banner' event
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._client as any).on('banner', (banner: string) => {
          infoLog('ssh-connect', 'server-banner', {
            connectionId: this.id,
            banner: banner?.replace(/\s+/g, ' ').trim(),
          });
        });

        this._client!.on('error', (err) => {
          clearTimeout(timeoutId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = err as Error & { level?: string; code?: string };
          infoLog('ssh-connect', 'error', {
            connectionId: this.id,
            elapsedMs: Date.now() - connectStart,
            level: e.level,
            code: e.code,
            errorName: e.name,
            errorMessage: e.message,
          });
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
          infoLog('ssh-connect', 'close', {
            connectionId: this.id,
            connectedFor: Date.now() - connectStart,
          });
          this.handleDisconnect();
        });

        // ssh2 'end' fires when remote sends SSH_MSG_DISCONNECT
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._client as any).on('end', () => {
          diagLog('ssh-connect', 'end', { connectionId: this.id });
        });

        // Handle keyboard-interactive authentication
        this._client!.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
          diagLog('ssh-connect', 'keyboard-interactive-prompt', {
            connectionId: this.id,
            promptCount: prompts.length,
            prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
          });
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
            diagLog('ssh-connect', 'host-key-verify', {
              connectionId: this.id,
              keyBytes: key.length,
            });
            verifyHostKey(this.host.host, this.host.port, key)
              .then((accepted) => {
                infoLog('ssh-connect', 'host-key-decision', {
                  connectionId: this.id,
                  accepted,
                });
                if (accepted) {
                  verify(true);
                } else {
                  verify(false);
                  reject(new ConnectionError('Host key verification failed - connection rejected by user'));
                }
              })
              .catch((err) => {
                infoLog('ssh-connect', 'host-key-error', {
                  connectionId: this.id,
                  errorMessage: (err as Error).message,
                });
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
        if (isPrivateKeyEncrypted(privateKey)) {
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
        if (isPrivateKeyEncrypted(privateKey)) {
          const passphrase = await creds.getOrPrompt(this.id, 'passphrase', `Passphrase for ${keyPath}`);
          if (passphrase) passphrases.push(passphrase);
        }
      }
    }

    // Add keys if found
    const haveKey = privateKeys.length > 0;
    if (haveKey) {
      authMethods.privateKey = privateKeys[0]; // ssh2 uses first key
      if (passphrases.length > 0) {
        authMethods.passphrase = passphrases[0];
      }
    }

    // Add SSH agent if available
    if (process.env.SSH_AUTH_SOCK) {
      authMethods.agent = process.env.SSH_AUTH_SOCK;
    }

    // Password handling. Only PROMPT for a password when there is no other way
    // to authenticate (no private key and no agent). When a key/agent IS
    // present we must NOT prompt — otherwise key-based auth gets hijacked by an
    // unnecessary password box on every first connect (the original UX bug).
    // We still attach a *previously saved* password silently so it can serve as
    // a genuine fallback if the key/agent is rejected, without bugging the user.
    const haveAgent = !!authMethods.agent;
    const password = haveKey || haveAgent
      ? await creds.get(this.id, 'password')
      : await creds.getOrPrompt(this.id, 'password', `Password for ${this.host.username}@${this.host.host}`);
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
    infoLog('ssh-connect', 'handleDisconnect', {
      connectionId: this.id,
      hadSftp: !!this._sftp,
      activeWatcherCount: this._activeWatchers.size,
      portForwardCount: this._portForwards.size,
      hadCapabilities: !!this._capabilities,
      previousState: this.state,
    });
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

    // Clear sudo state on disconnect
    this.disableSudoMode();

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
    infoLog('ssh-connect', 'disconnect/begin', {
      connectionId: this.id,
      hasSftp: !!this._sftp,
      portForwardCount: this._portForwards.size,
      activeWatcherCount: this._activeWatchers.size,
      hasClient: !!this._client,
      currentState: this.state,
    });
    // Close SFTP session first
    if (this._sftp) {
      try {
        this._sftp.end();
      } catch (err) {
        diagLog('ssh-connect', 'disconnect/sftp-end-error', { connectionId: this.id, errorMessage: (err as Error).message });
      }
      this._sftp = null;
    }

    // Close all port forwards
    for (const [, server] of this._portForwards) {
      try {
        server.close();
      } catch (err) {
        diagLog('ssh-connect', 'disconnect/forward-close-error', { connectionId: this.id, errorMessage: (err as Error).message });
      }
    }
    this._portForwards.clear();

    // Clear cached search-tool profile so a reconnect re-probes (the server may
    // have changed). A fresh SSHConnection is created per connect anyway; this
    // is belt-and-suspenders for any reuse path.
    this._remoteTools = null;
    this._remoteToolsPromise = null;

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

  /** Serialization promise for SFTP session creation — prevents duplicate sessions from concurrent calls */
  private _sftpPromise: Promise<SFTPWrapper> | null = null;

  /**
   * Memoized remote search-tool profile (rg/fd/locate/mdfind + grep flavor + OS +
   * nproc). Probed lazily on the first 'auto' search and cached for the
   * connection lifetime. A fresh SSHConnection is created on every (re)connect,
   * so this naturally resets; disconnect() also clears it defensively.
   */
  private _remoteToolsPromise: Promise<RemoteSearchTools> | null = null;
  private _remoteTools: RemoteSearchTools | null = null;

  /**
   * Probe the server's search tooling once per connection. Never throws: a probe
   * failure resolves to LEGACY_TOOLS so search proceeds on the universal path.
   */
  async getRemoteSearchTools(): Promise<RemoteSearchTools> {
    if (this._remoteTools) return this._remoteTools;
    if (this._remoteToolsPromise) return this._remoteToolsPromise;

    const t0 = Date.now();
    infoLog('search-tools', 'probe-start', { connectionId: this.id });
    this._remoteToolsPromise = (async (): Promise<RemoteSearchTools> => {
      try {
        const out = await this.exec(buildToolProbeCommand());
        const tools = parseToolProbeOutput(out);
        tools.detectedAt = Date.now();
        tools.degraded = [];
        this._remoteTools = tools;
        infoLog('search-tools', 'probe-result', {
          connectionId: this.id,
          durationMs: Date.now() - t0,
          os: tools.os,
          nproc: tools.nproc,
          grepFlavor: tools.grepFlavor,
          xargsFlavor: tools.xargsFlavor,
          rg: !!tools.rg,
          fd: !!tools.fd,
          plocate: !!tools.plocate,
          locate: !!tools.locate,
          mdfind: !!tools.mdfind,
        });
        return tools;
      } catch (err) {
        const fallback: RemoteSearchTools = { ...LEGACY_TOOLS, grepFlavor: 'unknown', detectedAt: Date.now(), degraded: [] };
        this._remoteTools = fallback;
        infoLog('search-tools', 'probe-error', { connectionId: this.id, durationMs: Date.now() - t0, errorMessage: (err as Error).message });
        return fallback;
      } finally {
        this._remoteToolsPromise = null;
      }
    })();
    return this._remoteToolsPromise;
  }

  /**
   * Disable a native tool after a runtime failure so subsequent searches on this
   * connection skip it (no wasted failing-then-retrying round trip).
   */
  private _markToolDegraded(tool: SearchTool): void {
    const t = this._remoteTools;
    if (!t) return;
    if (!t.degraded) t.degraded = [];
    if (!t.degraded.includes(tool)) t.degraded.push(tool);
    if (tool === 'rg') t.rg = undefined;
    else if (tool === 'fd') t.fd = undefined;
    else if (tool === 'locate') { t.plocate = undefined; t.locate = undefined; }
    else if (tool === 'mdfind') t.mdfind = undefined;
    else if (tool === 'xargs-grep') { t.grepFlavor = 'gnu'; t.xargsFlavor = 'other'; } // force plain legacy grep next time
    infoLog('search-fallback', 'tool-degraded', { connectionId: this.id, tool, degraded: t.degraded });
  }

  /**
   * Get or create SFTP session.
   * Serialized: concurrent calls wait on the same creation promise.
   */
  private async getSFTP(): Promise<SFTPWrapper> {
    if (this._sftp) {
      return this._sftp;
    }

    // If another call is already creating the SFTP session, wait for it
    if (this._sftpPromise) {
      diagLog('ssh-connect', 'sftp/wait-pending', { connectionId: this.id });
      return this._sftpPromise;
    }

    if (!this._client || this.state !== ConnectionState.Connected) {
      infoLog('ssh-connect', 'sftp/not-connected', {
        connectionId: this.id,
        hasClient: !!this._client,
        state: this.state,
      });
      throw new ConnectionError('Not connected');
    }

    diagLog('ssh-connect', 'sftp/create-begin', { connectionId: this.id });
    const t0 = Date.now();
    this._sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this._client!.sftp((err, sftp) => {
        this._sftpPromise = null;
        if (err) {
          infoLog('ssh-connect', 'sftp/create-failed', {
            connectionId: this.id,
            durationMs: Date.now() - t0,
            errorMessage: err.message,
          });
          reject(new SFTPError(`Failed to create SFTP session: ${err.message}`, err));
          return;
        }
        diagLog('ssh-connect', 'sftp/create-success', { connectionId: this.id, durationMs: Date.now() - t0 });
        this._sftp = sftp;
        resolve(sftp);
      });
    });

    return this._sftpPromise;
  }

  /**
   * Open an SSH exec channel with retry on "Channel open failure".
   * SSH servers limit concurrent channels (MaxSessions, often 10).
   * When many workers open channels simultaneously, excess ones get rejected.
   * Retry with exponential backoff ensures no work is lost.
   */
  private _execChannel(command: string, maxRetries = 5): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryExec = () => {
        if (!this._client) {
          reject(new ConnectionError('Not connected'));
          return;
        }
        this._client.exec(command, (err, stream) => {
          if (err) {
            if (err.message?.includes('open failure') && attempt < maxRetries) {
              attempt++;
              const delay = 200 * Math.pow(2, attempt - 1); // 200, 400, 800, 1600, 3200ms
              setTimeout(tryExec, delay);
              return;
            }
            reject(err);
            return;
          }
          resolve(stream);
        });
      };
      tryExec();
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

    let stream: ClientChannel;
    try {
      stream = await this._execChannel(command);
    } catch (err) {
      throw new SFTPError(`Failed to execute command: ${(err as Error).message}`, err as Error);
    }

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      stream.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data);
      });

      stream.on('close', (code: number) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0 && stderr) {
          reject(new SFTPError(`Command failed (exit code ${code}): ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Create an interactive shell.
   *
   * When called bare (`shell()`) it keeps ssh2's default PTY (TERM=vt100) for
   * backward compatibility. Pass `pty`/`opts` to request a native-parity PTY —
   * e.g. `{ term: 'xterm-256color' }` plus forwarded locale `{ env: {...} }` —
   * so remote TUI apps and shell plugins (fzf-tab, powerlevel10k, vim, tmux)
   * render exactly as in a native `ssh user@host` session. These are sent once
   * when the channel opens (no polling, no extra server commands).
   */
  async shell(
    pty?: { term?: string; rows?: number; cols?: number },
    opts?: { env?: Record<string, string> }
  ): Promise<ClientChannel> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    return new Promise((resolve, reject) => {
      const cb = (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(new SFTPError(`Failed to create shell: ${err.message}`, err));
          return;
        }
        resolve(stream);
      };
      if (pty || opts) {
        // ssh2 overload: shell(window, options, cb). Passing {} for an absent
        // arg requests a default PTY — fine here because every real caller that
        // supplies opts also supplies pty (the terminal always sets `term`).
        this._client!.shell(pty ?? {}, opts ?? {}, cb);
      } else {
        // Bare call → ssh2's shell(cb): default PTY (TERM=vt100), unchanged for
        // non-terminal callers (e.g. the chaos suite).
        this._client!.shell(cb);
      }
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
    SSHConnection.chaosReadFileCount++;
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
    SSHConnection.chaosReadFileCount++;
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

  // ─── Sudo Operations ─────────────────────────────────────────────────
  // All sudo methods use SSH exec channels (not local shell).
  // Password is written to channel stdin, never in the command string.

  /** Escape a path for safe use in single-quoted shell strings */
  private escapePath(p: string): string {
    return p.replace(/'/g, "'\\''");
  }

  /**
   * Classify a sudo error from stderr. Returns null when the text is not a
   * recognized sudo failure (so caller can keep waiting / fall back to generic).
   */
  private categorizeSudoError(stderr: string): 'auth' | 'sudoers' | 'no-sudo' | null {
    const lower = stderr.toLowerCase();
    if (lower.includes('incorrect password') || lower.includes('sorry, try again')) {
      return 'auth';
    }
    if (lower.includes('not in the sudoers') || lower.includes('is not allowed to run sudo')) {
      return 'sudoers';
    }
    if (lower.includes('sudo: command not found') || lower.includes('sudo: not found')) {
      return 'no-sudo';
    }
    return null;
  }

  private sudoErrorMessage(category: 'auth' | 'sudoers' | 'no-sudo'): string {
    switch (category) {
      case 'auth': return 'Sudo authentication failed: incorrect password';
      case 'sudoers': return 'User is not in the sudoers file or not allowed to use sudo';
      case 'no-sudo': return 'sudo is not installed on the remote host';
    }
  }

  /**
   * Execute a sudo command using a stderr-sync state-machine protocol.
   *
   * Wire format we run on the remote:
   *   sudo [-u <runAsUser>] -S -p 'SSHLITE_SUDO_PASS:<nonce>:' -- \
   *     sh -c 'echo "SSHLITE_SUDO_READY:<nonce>:" >&2; <command>'
   *
   * Why two sentinel tokens?
   *  - PROMPT is what sudo itself emits BEFORE reading the password.
   *    We only write `password\n` when we observe PROMPT — never blindly.
   *    This prevents the catastrophic bug where a NOPASSWD- or cached-sudo
   *    invocation would write the password into the file payload via tee.
   *  - READY is emitted by our inner shell AFTER sudo has handed control over.
   *    Seeing READY guarantees auth succeeded AND the inner shell is blocking
   *    on stdin, so it is safe to stream the payload.
   *
   * The 8-byte random nonce binds both tokens to this single call: stderr
   * output from the inner command cannot accidentally match a sentinel
   * (collision probability ~ 2^-64 per call).
   */
  private async _sudoExecRaw(
    command: string,
    password: string,
    stdinPayload?: Buffer | string,
    options?: { runAsUser?: string }
  ): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    if (!this._client || this.state !== ConnectionState.Connected) {
      throw new ConnectionError('Not connected');
    }

    // Validate runAsUser if provided. Usernames cannot legally contain shell
    // metacharacters; enforcing the regex here removes any injection surface.
    let userFlag = '';
    if (options?.runAsUser !== undefined) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(options.runAsUser)) {
        throw new SFTPError(`Invalid runAsUser: ${options.runAsUser}`);
      }
      userFlag = `-u ${options.runAsUser} `;
    }

    const nonce = crypto.randomBytes(8).toString('hex');
    const PROMPT_TOKEN = `SSHLITE_SUDO_PASS:${nonce}:`;
    const READY_TOKEN = `SSHLITE_SUDO_READY:${nonce}:`;

    // Build the inner script and escape single quotes for embedding inside
    // the outer single-quoted `sh -c '...'` argument: ' becomes '\''
    const innerScript = `echo '${READY_TOKEN}' >&2; ${command}`;
    const escapedInner = innerScript.replace(/'/g, "'\\''");
    const sudoCmd = `sudo ${userFlag}-S -p '${PROMPT_TOKEN}' -- sh -c '${escapedInner}'`;

    logSSHCommand(
      this.host.name,
      `[sudo${options?.runAsUser ? ` -u ${options.runAsUser}` : ''}] ${command}`
    );
    infoLog('sudo', 'exec/begin', {
      host: this.host.name,
      runAsUser: options?.runAsUser ?? 'root',
      withPayload: stdinPayload !== undefined,
    });

    const stream = await this._execChannel(sudoCmd);
    const TIMEOUT_MS = 60_000;

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      let stderrBuf = '';   // stderr seen before READY (sudo prompt/banner/errors)
      let realStderr = '';  // stderr captured after READY (the inner command's own stderr)
      let state: 'WAIT_PROMPT_OR_READY' | 'WAIT_READY' | 'STREAMING' = 'WAIT_PROMPT_OR_READY';
      let passwordWritten = false;
      let settled = false;

      const settle = (action: () => void): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        action();
      };

      const earlyReject = (category: 'auth' | 'sudoers' | 'no-sudo'): void => {
        infoLog('sudo', 'auth/fail', { host: this.host.name, reason: category });
        settle(() => {
          stream.destroy();
          reject(new SFTPError(this.sudoErrorMessage(category)));
        });
      };

      const timer = setTimeout(() => {
        settle(() => {
          infoLog('sudo', 'exec/timeout', {
            host: this.host.name,
            lastState: state,
            stderrBufLen: stderrBuf.length,
            passwordWritten,
          });
          stream.destroy();
          reject(new SFTPError(
            'sudo did not respond within 60s — possible NOPASSWD misconfig, network stall, or sudo not present'
          ));
        });
      }, TIMEOUT_MS);

      stream.stderr.on('data', (chunk: Buffer) => {
        if (settled) { return; }
        const text = chunk.toString();

        if (state === 'STREAMING') {
          realStderr += text;
          return;
        }

        stderrBuf += text;

        // 1. Early-reject on known sudo error phrases (only meaningful before READY).
        const category = this.categorizeSudoError(stderrBuf);
        if (category) {
          earlyReject(category);
          return;
        }

        // 2. READY detected → auth passed (or was cached/NOPASSWD), inner shell
        //    is now blocking on stdin. Safe to stream the payload.
        const readyIdx = stderrBuf.indexOf(READY_TOKEN);
        if (readyIdx !== -1) {
          const mode = passwordWritten ? 'authed' : 'cached';
          diagLog('sudo', 'auth/ready-seen', { host: this.host.name, nonce, mode });
          // Anything after READY in this chunk is the start of real stderr.
          realStderr = stderrBuf.slice(readyIdx + READY_TOKEN.length);
          stderrBuf = '';
          state = 'STREAMING';
          if (stdinPayload !== undefined) {
            stream.write(stdinPayload);
          }
          stream.end();
          return;
        }

        // 3. PROMPT detected → sudo is asking for the password.
        if (stderrBuf.includes(PROMPT_TOKEN)) {
          if (passwordWritten) {
            // PROMPT seen again after we already wrote a password → sudo
            // rejected the first attempt. Treat as auth failure rather than
            // re-sending the same wrong password in a loop.
            earlyReject('auth');
            return;
          }
          diagLog('sudo', 'auth/prompt-seen', { host: this.host.name, nonce });
          stream.write(password + '\n');
          passwordWritten = true;
          // Strip the consumed prompt from buffer so it isn't matched again.
          stderrBuf = stderrBuf.replace(PROMPT_TOKEN, '');
          state = 'WAIT_READY';
        }
      });

      stream.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
      });

      stream.on('close', (code: number) => {
        if (settled) { return; }
        settle(() => {
          const finalCode = code ?? 0;
          const finalStderr = state === 'STREAMING' ? realStderr : stderrBuf;
          if (finalCode === 0) {
            infoLog('sudo', 'exec/ok', {
              host: this.host.name,
              code: finalCode,
              stdoutBytes: stdoutChunks.reduce((s, b) => s + b.length, 0),
            });
          } else {
            infoLog('sudo', 'exec/fail', {
              host: this.host.name,
              code: finalCode,
              state,
              stderrTail: finalStderr.slice(-200),
            });
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: finalStderr,
            code: finalCode,
          });
        });
      });

      stream.on('error', (err: Error) => {
        settle(() => {
          infoLog('sudo', 'exec/stream-error', {
            host: this.host.name,
            errorMessage: err.message,
          });
          reject(new SFTPError(`Sudo stream error: ${err.message}`));
        });
      });
    });
  }

  /** Check sudo exec result for common error patterns and throw appropriate errors */
  private checkSudoResult(result: { stderr: string; code: number }, operation: string): void {
    if (result.code === 0) { return; }
    const category = this.categorizeSudoError(result.stderr);
    if (category) {
      throw new SFTPError(this.sudoErrorMessage(category));
    }
    // Sanitize stderr to avoid leaking password-related info
    const safeStderr = result.stderr.replace(/\[sudo\].*password.*/gi, '').trim();
    throw new SFTPError(`${operation} failed (exit ${result.code}): ${safeStderr}`);
  }

  /**
   * Execute a command with sudo. General-purpose wrapper.
   * Password is piped via stdin only when sudo actually prompts.
   */
  async sudoExec(command: string, password: string, runAsUser?: string): Promise<string> {
    const result = await this._sudoExecRaw(command, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo command');
    return result.stdout.toString('utf8');
  }

  /**
   * Write a file using sudo tee via SSH exec channel.
   * Binary files use base64 encode/decode pipeline.
   */
  async sudoWriteFile(remotePath: string, content: Buffer, password: string, runAsUser?: string): Promise<void> {
    const escaped = this.escapePath(remotePath);
    const isBinary = content.includes(0);

    if (isBinary) {
      // Binary: pipe base64-encoded content through base64 -d.
      // No outer `sh -c` needed — the wrapper in _sudoExecRaw already provides one.
      const command = `base64 -d > '${escaped}'`;
      const result = await this._sudoExecRaw(command, password, Buffer.from(content.toString('base64')), { runAsUser });
      this.checkSudoResult(result, 'Sudo write');
    } else {
      const command = `tee '${escaped}' > /dev/null`;
      const result = await this._sudoExecRaw(command, password, content, { runAsUser });
      this.checkSudoResult(result, 'Sudo write');
    }
  }

  /**
   * Read a file using sudo cat.
   */
  async sudoReadFile(remotePath: string, password: string, runAsUser?: string): Promise<Buffer> {
    const escaped = this.escapePath(remotePath);
    const result = await this._sudoExecRaw(`cat '${escaped}'`, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo read');
    return result.stdout;
  }

  /**
   * Delete a file or directory using sudo rm.
   */
  async sudoDeleteFile(remotePath: string, password: string, isDirectory: boolean = false, runAsUser?: string): Promise<void> {
    const escaped = this.escapePath(remotePath);
    const command = isDirectory ? `rm -rf '${escaped}'` : `rm '${escaped}'`;
    const result = await this._sudoExecRaw(command, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo delete');
  }

  /**
   * Create a directory using sudo mkdir -p.
   */
  async sudoMkdir(remotePath: string, password: string, runAsUser?: string): Promise<void> {
    const escaped = this.escapePath(remotePath);
    const result = await this._sudoExecRaw(`mkdir -p '${escaped}'`, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo mkdir');
  }

  /**
   * Rename/move a file or directory using sudo mv.
   */
  async sudoRename(oldPath: string, newPath: string, password: string, runAsUser?: string): Promise<void> {
    const escapedOld = this.escapePath(oldPath);
    const escapedNew = this.escapePath(newPath);
    const result = await this._sudoExecRaw(`mv '${escapedOld}' '${escapedNew}'`, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo rename');
  }

  /**
   * List directory contents using sudo ls -la, parsed into IRemoteFile[].
   */
  async sudoListFiles(remotePath: string, password: string, runAsUser?: string): Promise<IRemoteFile[]> {
    const escaped = this.escapePath(remotePath);
    const result = await this._sudoExecRaw(`ls -la '${escaped}'`, password, undefined, { runAsUser });
    this.checkSudoResult(result, 'Sudo list');

    const output = result.stdout.toString('utf8');
    const files: IRemoteFile[] = [];

    for (const line of output.split('\n')) {
      // Skip total line and empty lines
      if (!line.trim() || line.startsWith('total ')) { continue; }

      // Parse ls -la output: drwxr-xr-x 2 user group 4096 Jan  1 12:00 filename
      const match = line.match(
        /^([d\-lbcps])([rwxsStT-]{9})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
      );
      if (!match) { continue; }

      const [, typeChar, perms, owner, group, sizeStr, dateStr, name] = match;
      if (name === '.' || name === '..') { continue; }

      const isDirectory = typeChar === 'd';
      const isSymlink = typeChar === 'l';
      // For symlinks, strip " -> target" from name
      const cleanName = isSymlink ? name.replace(/ -> .*$/, '') : name;
      const filePath = remotePath.endsWith('/')
        ? `${remotePath}${cleanName}`
        : `${remotePath}/${cleanName}`;

      files.push({
        name: cleanName,
        path: filePath,
        isDirectory,
        size: parseInt(sizeStr, 10),
        // getTime() already returns Unix ms — IRemoteFile.modifiedTime is ms.
        // The old `/ 1000` produced seconds, collapsing every sudo-listed file
        // to ~1970 in the tree (same "56 years ago" class of bug as issue #15).
        modifiedTime: new Date(dateStr).getTime(),
        accessTime: 0,
        owner: `${owner}:${group}`,
        permissions: perms,
        connectionId: this.id,
      });
    }

    return files;
  }

  /**
   * Read tail portion of a remote file starting from a specific byte offset
   * Used for efficient incremental file updates (e.g., growing log files)
   * @param remotePath - Path to remote file
   * @param offset - Byte offset to start reading from (0-based)
   * @returns Buffer containing data from offset to end of file
   */
  async readFileTail(remotePath: string, offset: number): Promise<Buffer> {
    SSHConnection.chaosReadFileCount++;
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

    // Use _execChannel for retry on "Channel open failure" under SSH session pressure
    let stream: ClientChannel;
    try {
      stream = await this._execChannel(command);
    } catch (err) {
      throw new SFTPError(`Failed to read file tail: ${(err as Error).message}`, err as Error);
    }

    return new Promise((resolve, reject) => {
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
      infoLog('ssh-connect', 'forwardPort/duplicate', { connectionId: this.id, localPort });
      throw new SFTPError(`Port ${localPort} is already forwarded`);
    }

    diagLog('ssh-connect', 'forwardPort/begin', { connectionId: this.id, localPort, remoteHost, remotePort });
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        diagLog('ssh-connect', 'forwardPort/incoming-connection', {
          connectionId: this.id,
          localPort,
          from: socket.remoteAddress + ':' + socket.remotePort,
        });
        this._client!.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              infoLog('ssh-connect', 'forwardPort/forwardOut-error', {
                connectionId: this.id,
                localPort,
                remoteHost,
                remotePort,
                errorMessage: err.message,
              });
              socket.end();
              return;
            }
            // Handle errors on both sides to prevent unhandled 'error' events crashing the process
            stream.on('error', () => socket.destroy());
            socket.on('error', () => stream.destroy());
            socket.pipe(stream).pipe(socket);
          }
        );
      });

      server.on('error', (err) => {
        infoLog('ssh-connect', 'forwardPort/server-error', {
          connectionId: this.id,
          localPort,
          errorMessage: err.message,
        });
        reject(new SFTPError(`Failed to start port forward: ${err.message}`, err));
      });

      server.listen(localPort, '127.0.0.1', () => {
        infoLog('ssh-connect', 'forwardPort/listening', { connectionId: this.id, localPort, remoteHost, remotePort });
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
      diagLog('ssh-connect', 'stopForward', { connectionId: this.id, localPort });
      server.close();
      this._portForwards.delete(localPort);
    } else {
      diagLog('ssh-connect', 'stopForward/not-found', { connectionId: this.id, localPort });
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
    // Support comma-separated file patterns via OR'ed -name filters (VS Code-style)
    let nameFilter = '';
    if (filePattern && filePattern !== '*') {
      const patterns = filePattern.split(',').map((p) => p.trim()).filter(Boolean);
      if (patterns.length === 1) {
        nameFilter = `-name '${patterns[0].replace(/'/g, "'\\''")}'`;
      } else if (patterns.length > 1) {
        const orClauses = patterns.map((p) => `-name '${p.replace(/'/g, "'\\''")}'`).join(' -o ');
        nameFilter = `\\( ${orClauses} \\)`;
      }
    }
    // Single SSH exec: list files (with optional pattern), then dirs, separated by marker
    // -L follows symlinks so symlinked dirs/files are discovered (safe with -maxdepth 1)
    const command =
      `find -L '${escaped}' -maxdepth 1 -mindepth 1 -type f ${nameFilter} 2>/dev/null; ` +
      `echo '<<DIR_MARKER>>'; ` +
      `find -L '${escaped}' -maxdepth 1 -mindepth 1 -type d 2>/dev/null`;

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
      wholeWord?: boolean; // Match whole words only (grep -w flag)
      filePattern?: string; // File glob pattern (e.g., *.ts) — comma-separated for multiple
      excludePattern?: string; // Exclude pattern (e.g., node_modules, *.test.ts)
      maxResults?: number;
      signal?: AbortSignal; // Abort signal to cancel the search
      findType?: 'f' | 'd' | 'both'; // For find: files, directories, or both (default: 'f')
      nativeTools?: 'auto' | 'off'; // Use rg/fd/etc when detected ('auto') or never ('off', default)
    } = {}
  ): Promise<SearchResultRow[]> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }

    const {
      searchContent = true,
      caseSensitive = false,
      regex = false,
      wholeWord = false,
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
    const validatedMaxResults = validateMaxResults(maxResults);
    const searchPaths = Array.isArray(searchPath) ? searchPath : [searchPath];

    // Resolve which tools to use. 'auto' lazily probes the server once per
    // connection (inside this user-triggered search → LITE-compliant); 'off'
    // (the default) keeps the universal grep/find path with no probe at all.
    const nativeMode = options.nativeTools ?? 'off';
    let tools: RemoteSearchTools = LEGACY_TOOLS;
    if (nativeMode === 'auto') {
      try {
        tools = await this.getRemoteSearchTools();
      } catch {
        tools = LEGACY_TOOLS;
      }
      if (signal?.aborted) return [];
    }

    const contentOpts: ContentSearchOpts = {
      pattern, searchPaths, caseSensitive, regex, wholeWord, filePattern, excludePattern,
      maxResults: validatedMaxResults,
    };
    const filenameOpts: FilenameSearchOpts = {
      pattern, searchPaths, caseSensitive, excludePattern,
      maxResults: validatedMaxResults, findType: options.findType || 'f',
    };

    const t0 = Date.now();
    let built = searchContent
      ? buildContentSearchCommand(contentOpts, tools)
      : buildFilenameSearchCommand(filenameOpts, tools);

    infoLog('search-exec', 'strategy-selected', {
      connectionId: this.id, tool: built.tool, strategy: describeStrategy(built.tool, tools),
      nativeMode, searchContent,
    });
    diagLog('search-exec', 'command-built', {
      connectionId: this.id, tool: built.tool, isNative: built.isNative,
      command: built.command, paths: searchPaths.length,
    });

    let outcome = await this._execSearch(built, { searchContent, signal });

    // Runtime fallback: a native tool that errored or silently produced nothing
    // (exit!=0 with stderr) gets exactly ONE legacy retry. Mark it degraded so
    // later searches on this connection skip it (no wasted failing round trip).
    if (built.isNative && shouldFallbackToLegacy({
      resultCount: outcome.results.length, stderrText: outcome.stderrText,
      aborted: outcome.aborted, execError: outcome.execError,
    })) {
      infoLog('search-fallback', 'native-tool-fallback', {
        connectionId: this.id, tool: built.tool,
        reason: outcome.execError ? 'exec-error' : 'zero-with-stderr',
        stderr: outcome.stderrText.slice(0, 200),
      });
      this._markToolDegraded(built.tool);
      const legacy = searchContent
        ? buildContentSearchCommand(contentOpts, tools, true)
        : buildFilenameSearchCommand(filenameOpts, tools, true);
      built = legacy;
      outcome = await this._execSearch(legacy, { searchContent, signal });
    }

    if (outcome.aborted) return [];
    if (outcome.execError) {
      // The legacy command itself failed — preserve the historical reject.
      infoLog('search-exec', 'exec-error', { connectionId: this.id, tool: built.tool, errorMessage: outcome.errorMessage });
      throw new SFTPError(`Search failed: ${outcome.errorMessage || 'unknown error'}`);
    }

    infoLog('search-exec', 'exec-done', {
      connectionId: this.id, tool: built.tool, durationMs: Date.now() - t0,
      bytesReceived: outcome.bytesReceived, lineCount: outcome.lineCount,
      resultCount: outcome.results.length, droppedNoLineNum: outcome.droppedNoLineNum,
      truncated: validatedMaxResults > 0 && outcome.results.length >= validatedMaxResults,
    });
    if (outcome.results.length === 0) {
      infoLog('search-exec', 'zero-results', {
        connectionId: this.id, tool: built.tool,
        stderrEmpty: outcome.stderrText.trim().length === 0,
        stderr: outcome.stderrText.slice(0, 200),
      });
    }

    return this._enrichAndSort(outcome.results, outcome.uniquePaths, () => signal?.aborted === true);
  }

  /**
   * Opt-in indexed filename search via plocate/locate. MUCH faster than a live
   * find (the OS keeps a trigram index) but STALE — it can miss files created
   * since the last `updatedb` and list deleted ones. The UI must surface that.
   *
   * Returns null when no index tool exists or the lookup fails (e.g. no DB) so
   * the caller can fall back to a live filename search. Results are anchored to
   * `basePath` AND filtered to basename matches, matching the live `find -iname`
   * semantics (locate itself matches the whole path as a substring).
   */
  async searchIndexed(
    basePath: string,
    pattern: string,
    options: { caseSensitive?: boolean; maxResults?: number; signal?: AbortSignal } = {},
  ): Promise<{ results: SearchResultRow[]; dbMTimeMs: number | null; tool: 'plocate' | 'locate' } | null> {
    if (this.state !== ConnectionState.Connected || !this._client) {
      throw new SFTPError('Not connected');
    }
    const { caseSensitive = false, maxResults = 2000, signal } = options;
    const tools = await this.getRemoteSearchTools();
    const toolName: 'plocate' | 'locate' = tools.plocate ? 'plocate' : 'locate';
    const built = buildLocateCommand(basePath, pattern, caseSensitive, maxResults, tools);
    if (!built) {
      infoLog('search-tools', 'indexed-search-unavailable', { connectionId: this.id, basePath });
      return null; // no locate/plocate → caller falls back to live find
    }
    if (signal?.aborted) return { results: [], dbMTimeMs: null, tool: toolName };

    infoLog('search-tools', 'indexed-search', { connectionId: this.id, tool: toolName, basePath });
    const outcome = await this._execSearch(built, { searchContent: false, signal });
    if (outcome.aborted) return { results: [], dbMTimeMs: null, tool: toolName };
    if (outcome.execError) {
      // Missing DB / locate error → tell the caller to use a live search instead.
      infoLog('search-fallback', 'indexed-search-failed', { connectionId: this.id, errorMessage: outcome.errorMessage });
      return null;
    }

    // Anchor to basePath (server-side grep -F only narrows transfer) and match
    // the basename (locate matches anywhere in the path), so the result set
    // equals what a live `find -iname '*pattern*'` under basePath would yield.
    const prefix = basePath.endsWith('/') ? basePath : basePath + '/';
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const before = outcome.results.length;
    const anchored = outcome.results.filter((r) => {
      if (!r.path.startsWith(prefix)) return false;
      const base = r.path.slice(r.path.lastIndexOf('/') + 1);
      return (caseSensitive ? base : base.toLowerCase()).includes(needle);
    });
    infoLog('search-exec', 'locate-anchor-filter', { connectionId: this.id, tool: toolName, before, after: anchored.length });

    const uniquePaths = new Set(anchored.map((r) => r.path));
    const results = await this._enrichAndSort(anchored, uniquePaths, () => signal?.aborted === true);
    const dbMTimeMs = await this._getIndexDbAge();
    return { results, dbMTimeMs, tool: toolName };
  }

  /** Best-effort locate-database mtime in epoch ms (for the staleness hint). */
  private async _getIndexDbAge(): Promise<number | null> {
    try {
      const out = (await this.exec(buildIndexStalenessCommand())).trim();
      // %Y prints integer epoch seconds; convert to ms.
      const secs = parseInt(out, 10);
      return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Run a single built search command and parse its output. Never rejects —
   * resolves with an outcome object so the caller can decide whether to fall
   * back to the legacy command. Honors the abort signal (SIGTERM + close).
   */
  private _execSearch(
    built: BuiltSearchCommand,
    opts: { searchContent: boolean; signal?: AbortSignal },
  ): Promise<{
    results: SearchResultRow[];
    uniquePaths: Set<string>;
    stderrText: string;
    execError: boolean;
    errorMessage?: string;
    aborted: boolean;
    lineCount: number;
    bytesReceived: number;
    droppedNoLineNum: number;
  }> {
    const { searchContent, signal } = opts;
    logSSHCommand(this.host.name, built.command);

    const empty = () => ({
      results: [] as SearchResultRow[], uniquePaths: new Set<string>(), stderrText: '',
      execError: false, aborted: false, lineCount: 0, bytesReceived: 0, droppedNoLineNum: 0,
    });

    return new Promise((resolve) => {
      this._execChannel(built.command).then((stream) => {
        if (signal?.aborted) {
          try { stream.signal('TERM'); } catch { /* signal not supported */ }
          stream.close();
          resolve({ ...empty(), aborted: true });
          return;
        }

        let aborted = false;
        const onAbort = () => {
          aborted = true;
          try { stream.signal('TERM'); } catch { /* signal not supported */ }
          stream.close();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        let settled = false;
        const settle = (val: Awaited<ReturnType<SSHConnection['_execSearch']>>) => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(val);
        };

        const outputChunks: Buffer[] = [];
        const errorChunks: Buffer[] = [];

        stream.on('error', (err: Error) => {
          infoLog('search-exec', 'stream-error', { connectionId: this.id, errorMessage: err.message });
          settle({ ...empty(), execError: true, errorMessage: err.message, stderrText: Buffer.concat(errorChunks).toString('utf8') });
        });
        stream.stderr.on('error', (err: Error) => {
          settle({ ...empty(), execError: true, errorMessage: err.message });
        });
        stream.on('data', (data: Buffer) => { outputChunks.push(data); });
        stream.stderr.on('data', (data: Buffer) => {
          errorChunks.push(data);
          diagLog('search-exec', 'stderr-chunk', { connectionId: this.id, tool: built.tool, stderr: data.toString('utf8').slice(0, 200) });
        });

        stream.on('close', async () => {
          if (aborted) { settle({ ...empty(), aborted: true }); return; }
          const outBuf = Buffer.concat(outputChunks);
          const bytesReceived = outBuf.length;
          const output = outBuf.toString('utf8');
          const stderrText = Buffer.concat(errorChunks).toString('utf8');
          const parsed = await this._parseSearchOutput(
            output, searchContent, built.requireLineNumber, built.tool === 'fd', () => aborted,
          );
          if (parsed.abortedDuringParse) { settle({ ...empty(), aborted: true }); return; }
          settle({
            results: parsed.results, uniquePaths: parsed.uniquePaths, stderrText,
            execError: false, aborted: false, lineCount: parsed.lineCount,
            bytesReceived, droppedNoLineNum: parsed.droppedNoLineNum,
          });
        });
      }).catch((err: Error) => {
        resolve({ ...empty(), execError: true, errorMessage: err.message });
      });
    });
  }

  /**
   * Parse raw search output into result rows, yielding to the event loop every
   * PARSE_CHUNK lines so a huge response cannot trip the extension-host watchdog.
   * `requireLineNumber` drops content lines lacking a numeric line field (rg
   * binary-match notes). `normalizeTrailingSlash` trims fd's directory slashes.
   */
  private async _parseSearchOutput(
    output: string,
    searchContent: boolean,
    requireLineNumber: boolean,
    normalizeTrailingSlash: boolean,
    isAborted: () => boolean,
  ): Promise<{ results: SearchResultRow[]; uniquePaths: Set<string>; droppedNoLineNum: number; lineCount: number; abortedDuringParse: boolean }> {
    const results: SearchResultRow[] = [];
    const uniquePaths = new Set<string>();
    let droppedNoLineNum = 0;
    const PARSE_CHUNK = 500;
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && i % PARSE_CHUNK === 0) {
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        if (isAborted()) return { results, uniquePaths, droppedNoLineNum, lineCount: lines.length, abortedDuringParse: true };
        diagLog('search-exec', 'parse-progress', { connectionId: this.id, parsedLines: i, resultCount: results.length });
      }
      const line = lines[i];
      if (!line) continue;

      if (searchContent) {
        // grep/rg output: filename:line:match
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;
        const filePath = line.substring(0, colonIndex);
        const rest = line.substring(colonIndex + 1);
        const secondColonIndex = rest.indexOf(':');
        if (secondColonIndex !== -1) {
          const lineNum = parseInt(rest.substring(0, secondColonIndex), 10);
          const match = rest.substring(secondColonIndex + 1);
          if (isNaN(lineNum)) {
            if (requireLineNumber) { droppedNoLineNum++; continue; }
            uniquePaths.add(filePath);
            results.push({ path: filePath, line: undefined, match: match.trim() });
          } else {
            uniquePaths.add(filePath);
            results.push({ path: filePath, line: lineNum, match: match.trim() });
          }
        } else {
          if (requireLineNumber) { droppedNoLineNum++; continue; }
          uniquePaths.add(filePath);
          results.push({ path: filePath, match: rest.trim() });
        }
      } else {
        // find/fd output: just paths
        let trimmedPath = line.trim();
        if (!trimmedPath) continue;
        if (normalizeTrailingSlash && trimmedPath.length > 1 && trimmedPath.endsWith('/')) {
          trimmedPath = trimmedPath.slice(0, -1);
        }
        uniquePaths.add(trimmedPath);
        results.push({ path: trimmedPath });
      }
    }
    return { results, uniquePaths, droppedNoLineNum, lineCount: lines.length, abortedDuringParse: false };
  }

  /**
   * Stat-enrich (size/mtime/permissions) up to 30 unique result paths in small
   * batches with event-loop yields, then sort by path then line. Stat errors per
   * file are ignored (deleted/inaccessible files just lack metadata).
   */
  private async _enrichAndSort(
    results: SearchResultRow[],
    uniquePaths: Set<string>,
    isAborted: () => boolean,
  ): Promise<SearchResultRow[]> {
    const pathsToStat = Array.from(uniquePaths).slice(0, 30);
    const statsMap = new Map<string, { size: number; modified: Date; permissions: string }>();
    const STAT_BATCH_SIZE = 5;

    try {
      const sftp = await this.getSFTP();
      for (let i = 0; i < pathsToStat.length; i += STAT_BATCH_SIZE) {
        if (isAborted()) break;
        const batch = pathsToStat.slice(i, i + STAT_BATCH_SIZE);
        await Promise.all(
          batch.map(async (filePath) => {
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
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch {
      // Ignore if SFTP fails - stats are optional
    }

    for (const result of results) {
      const stats = statsMap.get(result.path);
      if (stats) {
        result.size = stats.size;
        result.modified = stats.modified;
        result.permissions = stats.permissions;
      }
    }

    results.sort((a, b) => {
      const pathCompare = a.path.localeCompare(b.path);
      if (pathCompare !== 0) return pathCompare;
      if (a.line !== undefined && b.line !== undefined) {
        return a.line - b.line;
      }
      return 0;
    });

    return results;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    infoLog('ssh-connect', 'dispose', { connectionId: this.id });
    this.disconnect();
    this._onStateChange.dispose();
  }
}
