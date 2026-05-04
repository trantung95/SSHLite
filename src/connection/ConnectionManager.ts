import * as vscode from 'vscode';
import { SSHConnection } from './SSHConnection';
import { IHostConfig, ConnectionState, AuthenticationError, ILastConnectionAttempt, SSHError } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { ActivityService } from '../services/ActivityService';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * Info about a disconnected connection that we should try to reconnect
 */
interface DisconnectedConnectionInfo {
  host: IHostConfig;
  credential?: SavedCredential;
  lastPath?: string;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
  isManualDisconnect: boolean;
}

/**
 * Manages multiple SSH connections
 */
export class ConnectionManager {
  private static _instance: ConnectionManager;
  private _connections: Map<string, SSHConnection> = new Map();
  private _context: vscode.ExtensionContext | null = null;
  private static readonly LAST_CONNECTION_KEY = 'sshLite.lastConnectionAttempts';

  // Track disconnected connections for auto-reconnect
  private _disconnectedConnections: Map<string, DisconnectedConnectionInfo> = new Map();

  // Track connections currently in the middle of a reconnect attempt (to prevent duplicate reconnects)
  private _activeReconnectAttempts: Set<string> = new Set();

  // Reconnect interval in milliseconds
  private readonly RECONNECT_INTERVAL_MS = 3000;
  private readonly MAX_RECONNECT_ATTEMPTS = 0; // 0 = unlimited

  private readonly _onDidChangeConnections = new vscode.EventEmitter<void>();
  public readonly onDidChangeConnections = this._onDidChangeConnections.event;

  private readonly _onConnectionStateChange = new vscode.EventEmitter<{
    connection: SSHConnection;
    state: ConnectionState;
  }>();
  public readonly onConnectionStateChange = this._onConnectionStateChange.event;

  // Event for reconnecting status updates
  private readonly _onReconnecting = new vscode.EventEmitter<{
    connectionId: string;
    host: IHostConfig;
    attempt: number;
    isReconnecting: boolean;
  }>();
  public readonly onReconnecting = this._onReconnecting.event;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): ConnectionManager {
    if (!ConnectionManager._instance) {
      ConnectionManager._instance = new ConnectionManager();
    }
    return ConnectionManager._instance;
  }

  /**
   * Initialize with extension context for globalState persistence
   */
  initialize(context: vscode.ExtensionContext): void {
    this._context = context;
  }

  /**
   * Save the result of a connection attempt for failed connection indicator
   */
  private async saveLastConnectionAttempt(hostId: string, success: boolean, error?: Error): Promise<void> {
    if (!this._context) return;
    const stored = this._context.globalState.get<Record<string, ILastConnectionAttempt>>(
      ConnectionManager.LAST_CONNECTION_KEY, {}
    );
    stored[hostId] = {
      timestamp: Date.now(),
      success,
      errorMessage: error?.message,
      errorCode: error instanceof SSHError ? error.code : undefined,
    };
    await this._context.globalState.update(ConnectionManager.LAST_CONNECTION_KEY, stored);
  }

  /**
   * Get the last connection attempt for a host (for failed indicator display)
   */
  getLastConnectionAttempt(hostId: string): ILastConnectionAttempt | undefined {
    return this._context?.globalState.get<Record<string, ILastConnectionAttempt>>(
      ConnectionManager.LAST_CONNECTION_KEY, {}
    )?.[hostId];
  }

  /**
   * Create and connect to a host
   */
  async connect(host: IHostConfig): Promise<SSHConnection> {
    const connectionId = `${host.host}:${host.port}:${host.username}`;
    infoLog('connection-manager', 'connect/begin', {
      connectionId,
      hostName: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      source: host.source,
      withCredential: false,
      hasExisting: this._connections.has(connectionId),
      isReconnecting: this._activeReconnectAttempts.has(connectionId),
    });

    // Clear any pending reconnect for this host (but not during active attemptReconnect)
    if (!this._activeReconnectAttempts.has(connectionId)) {
      this.stopReconnect(connectionId);
    }

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      diagLog('connection-manager', 'connect/reuse-existing', { connectionId });
      return existing;
    }

    // Create new connection
    const connection = new SSHConnection(host);

    // Listen to state changes
    connection.onStateChange((state) => {
      diagLog('connection-manager', 'state-change', { connectionId, state });
      this._onConnectionStateChange.fire({ connection, state });

      // Handle unexpected disconnect - start auto-reconnect
      if (state === ConnectionState.Disconnected) {
        const disconnectInfo = this._disconnectedConnections.get(connectionId);
        const isActiveAttempt = this._activeReconnectAttempts.has(connectionId);
        diagLog('connection-manager', 'disconnect-handler', {
          connectionId,
          isManualDisconnect: disconnectInfo?.isManualDisconnect,
          isActiveAttempt,
          hasReconnectTimer: !!disconnectInfo?.reconnectTimer,
        });

        // If currently in the middle of a reconnect attempt, don't start another
        if (isActiveAttempt) {
          diagLog('connection-manager', 'skip-active-reconnect', { connectionId });
          return;
        }

        if (disconnectInfo?.isManualDisconnect) {
          // Manual disconnect - remove from maps
          infoLog('connection-manager', 'manual-disconnect-cleanup', { connectionId });
          this._connections.delete(connectionId);
          this._disconnectedConnections.delete(connectionId);
        } else if (!disconnectInfo?.reconnectTimer) {
          // Unexpected disconnect and no reconnect scheduled - start auto-reconnect
          infoLog('connection-manager', 'auto-reconnect-start', { connectionId });
          this.startReconnect(connectionId, host);
        }
      }

      this._onDidChangeConnections.fire();
    });

    // Store and connect
    this._connections.set(connectionId, connection);
    this._onDidChangeConnections.fire();

    // Track connection activity
    const activityService = ActivityService.getInstance();
    const activityId = activityService.startActivity(
      'connect',
      connectionId,
      host.name,
      `Connect: ${host.name}`,
      { detail: `${host.username}@${host.host}:${host.port}` }
    );

    try {
      await connection.connect();
      // Complete activity tracking
      activityService.completeActivity(activityId, 'Connected');
      // Clear failed connection indicator on success
      await this.saveLastConnectionAttempt(host.id, true);
      // Update context for VS Code when clauses
      await vscode.commands.executeCommand(
        'setContext',
        'sshLite.hasConnections',
        this._connections.size > 0
      );
      return connection;
    } catch (error) {
      // Fail activity tracking
      activityService.failActivity(activityId, (error as Error).message);
      // Save failed connection attempt for indicator
      await this.saveLastConnectionAttempt(host.id, false, error as Error);
      this._connections.delete(connectionId);
      this._onDidChangeConnections.fire();
      throw error;
    }
  }

  /**
   * Connect to a host with a specific credential
   */
  async connectWithCredential(host: IHostConfig, credential: SavedCredential): Promise<SSHConnection> {
    const connectionId = `${host.host}:${host.port}:${host.username}`;
    infoLog('connection-manager', 'connect/begin', {
      connectionId,
      hostName: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      source: host.source,
      withCredential: true,
      credentialId: credential.id,
      credentialLabel: credential.label,
      credentialType: credential.type,
      hasExisting: this._connections.has(connectionId),
      isReconnecting: this._activeReconnectAttempts.has(connectionId),
    });

    // Clear any pending reconnect for this host (but not during active attemptReconnect)
    if (!this._activeReconnectAttempts.has(connectionId)) {
      this.stopReconnect(connectionId);
    }

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      diagLog('connection-manager', 'connect/reuse-existing', { connectionId, withCredential: true });
      return existing;
    }

    // Create new connection with credential
    const connection = new SSHConnection(host, credential);

    // Listen to state changes
    connection.onStateChange((state) => {
      diagLog('connection-manager', 'state-change', { connectionId, state, withCredential: true });
      this._onConnectionStateChange.fire({ connection, state });

      // Handle unexpected disconnect - start auto-reconnect
      if (state === ConnectionState.Disconnected) {
        const disconnectInfo = this._disconnectedConnections.get(connectionId);
        const isActiveAttempt = this._activeReconnectAttempts.has(connectionId);
        diagLog('connection-manager', 'disconnect-handler', {
          connectionId,
          withCredential: true,
          isManualDisconnect: disconnectInfo?.isManualDisconnect,
          isActiveAttempt,
          hasReconnectTimer: !!disconnectInfo?.reconnectTimer,
        });

        // If currently in the middle of a reconnect attempt, don't start another
        if (isActiveAttempt) {
          diagLog('connection-manager', 'skip-active-reconnect', { connectionId, withCredential: true });
          return;
        }

        if (disconnectInfo?.isManualDisconnect) {
          // Manual disconnect - remove from maps
          infoLog('connection-manager', 'manual-disconnect-cleanup', { connectionId, withCredential: true });
          this._connections.delete(connectionId);
          this._disconnectedConnections.delete(connectionId);
        } else if (!disconnectInfo?.reconnectTimer) {
          // Unexpected disconnect and no reconnect scheduled - start auto-reconnect
          infoLog('connection-manager', 'auto-reconnect-start', { connectionId, withCredential: true });
          this.startReconnect(connectionId, host, credential);
        }
      }

      this._onDidChangeConnections.fire();
    });

    // Store and connect
    this._connections.set(connectionId, connection);
    this._onDidChangeConnections.fire();

    // Track connection activity
    const activityService = ActivityService.getInstance();
    const activityId = activityService.startActivity(
      'connect',
      connectionId,
      host.name,
      `Connect: ${host.name}`,
      { detail: `${host.username}@${host.host}:${host.port} (${credential.label})` }
    );

    try {
      await connection.connect();
      // Complete activity tracking
      activityService.completeActivity(activityId, 'Connected');
      // Clear failed connection indicator on success
      await this.saveLastConnectionAttempt(host.id, true);
      // Update context for VS Code when clauses
      await vscode.commands.executeCommand(
        'setContext',
        'sshLite.hasConnections',
        this._connections.size > 0
      );
      return connection;
    } catch (error) {
      // Fail activity tracking
      activityService.failActivity(activityId, (error as Error).message);
      // Save failed connection attempt for indicator
      await this.saveLastConnectionAttempt(host.id, false, error as Error);
      this._connections.delete(connectionId);
      this._onDidChangeConnections.fire();
      throw error;
    }
  }

  /**
   * Start auto-reconnect for a disconnected connection
   */
  private startReconnect(connectionId: string, host: IHostConfig, credential?: SavedCredential): void {
    infoLog('connection-manager', 'reconnect/start', {
      connectionId,
      hostName: host.name,
      host: host.host,
      withCredential: !!credential,
      intervalMs: this.RECONNECT_INTERVAL_MS,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    });
    // Don't start if already reconnecting
    if (this._disconnectedConnections.has(connectionId) &&
        this._disconnectedConnections.get(connectionId)?.reconnectTimer) {
      diagLog('connection-manager', 'reconnect/start-skipped-already-scheduled', { connectionId });
      return;
    }

    const info: DisconnectedConnectionInfo = {
      host,
      credential,
      reconnectAttempts: 0,
      isManualDisconnect: false,
    };

    this._disconnectedConnections.set(connectionId, info);

    // Fire reconnecting event
    this._onReconnecting.fire({
      connectionId,
      host,
      attempt: 0,
      isReconnecting: true,
    });

    // Show status bar message
    vscode.window.setStatusBarMessage(
      `$(sync~spin) Connection lost to ${host.name}. Reconnecting...`,
      this.RECONNECT_INTERVAL_MS
    );

    // Schedule reconnect attempt
    this.scheduleReconnect(connectionId);
  }

  /**
   * Schedule a reconnect attempt
   */
  private scheduleReconnect(connectionId: string): void {
    const info = this._disconnectedConnections.get(connectionId);
    if (!info || info.isManualDisconnect) {
      return;
    }

    // Clear existing timer if any
    if (info.reconnectTimer) {
      clearTimeout(info.reconnectTimer);
    }

    // Schedule reconnect
    info.reconnectTimer = setTimeout(async () => {
      await this.attemptReconnect(connectionId);
    }, this.RECONNECT_INTERVAL_MS);
  }

  /**
   * Attempt to reconnect a disconnected connection
   */
  private async attemptReconnect(connectionId: string): Promise<void> {
    const info = this._disconnectedConnections.get(connectionId);
    if (!info || info.isManualDisconnect) {
      diagLog('connection-manager', 'reconnect/attempt-aborted', {
        connectionId,
        reason: !info ? 'no-info' : 'manual-disconnect',
      });
      return;
    }

    // Mark as actively attempting (prevents state handler from starting duplicate reconnects)
    this._activeReconnectAttempts.add(connectionId);

    info.reconnectAttempts++;
    infoLog('connection-manager', 'reconnect/attempt', {
      connectionId,
      hostName: info.host.name,
      attempt: info.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
      withCredential: !!info.credential,
    });

    // Check max attempts (0 = unlimited)
    if (this.MAX_RECONNECT_ATTEMPTS > 0 && info.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
      this._activeReconnectAttempts.delete(connectionId);
      this.stopReconnect(connectionId);
      vscode.window.showWarningMessage(
        `Failed to reconnect to ${info.host.name} after ${this.MAX_RECONNECT_ATTEMPTS} attempts.`
      );
      return;
    }

    // Fire reconnecting event
    this._onReconnecting.fire({
      connectionId,
      host: info.host,
      attempt: info.reconnectAttempts,
      isReconnecting: true,
    });

    try {
      // Remove old connection from map before reconnecting
      this._connections.delete(connectionId);

      // Try to reconnect
      if (info.credential) {
        await this.connectWithCredential(info.host, info.credential);
      } else {
        // Try to find a saved credential
        const credService = CredentialService.getInstance();
        const credentials = credService.listCredentials(info.host.id);
        if (credentials.length === 1) {
          info.credential = credentials[0];
          await this.connectWithCredential(info.host, info.credential);
        } else {
          await this.connect(info.host);
        }
      }

      // Success! Clean up
      infoLog('connection-manager', 'reconnect/success', {
        connectionId,
        hostName: info.host.name,
        attempt: info.reconnectAttempts,
      });
      this._activeReconnectAttempts.delete(connectionId);
      this.stopReconnect(connectionId);
      vscode.window.setStatusBarMessage(
        `$(check) Reconnected to ${info.host.name}`,
        3000
      );

      // Fire success event
      this._onReconnecting.fire({
        connectionId,
        host: info.host,
        attempt: info.reconnectAttempts,
        isReconnecting: false,
      });

    } catch (error) {
      // Classify error: non-recoverable (stop) vs transient (retry)
      const errorMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

      // Authentication / credential errors — retrying won't help
      const isAuthError = error instanceof AuthenticationError ||
        errorMsg.includes('authentication') ||
        errorMsg.includes('auth failed') ||
        errorMsg.includes('permission denied') ||
        errorMsg.includes('publickey') ||
        errorMsg.includes('no supported') ||
        errorMsg.includes('all configured authentication methods failed') ||
        errorMsg.includes('invalid username') ||
        errorMsg.includes('invalid host configuration');

      // DNS / host resolution errors — hostname doesn't exist, retrying won't help
      const isDnsError =
        errorMsg.includes('enotfound') ||
        errorMsg.includes('getaddrinfo');

      const isNonRecoverable = isAuthError || isDnsError;

      infoLog('connection-manager', 'reconnect-failed', {
        connectionId,
        attempt: info.reconnectAttempts,
        errorMsg,
        isNonRecoverable,
        isAuthError,
        isDnsError,
        errorType: error?.constructor?.name,
        host: { name: info.host.name, host: info.host.host, port: info.host.port, username: info.host.username },
      });

      if (isNonRecoverable) {
        // Stop reconnecting. Keep _activeReconnectAttempts set briefly so the
        // async SSH2 'close' event (which fires after connect() rejects) sees
        // the guard and doesn't restart a new reconnect cycle.
        this.stopReconnect(connectionId);
        const reason = isAuthError
          ? 'Authentication failed. Please reconnect manually with correct credentials.'
          : `Host not found (${info.host.host}). Please check the hostname and try again.`;
        vscode.window.showErrorMessage(`Cannot reconnect to ${info.host.name}: ${reason}`);
        // Delay clearing the active flag to let async close event be ignored
        setTimeout(() => this._activeReconnectAttempts.delete(connectionId), 500);
        return;
      }

      // Clear active attempt flag for transient errors (safe: scheduleReconnect follows)
      this._activeReconnectAttempts.delete(connectionId);

      // Transient network error - schedule another attempt
      vscode.window.setStatusBarMessage(
        `$(sync~spin) Reconnecting to ${info.host.name} (attempt ${info.reconnectAttempts})...`,
        this.RECONNECT_INTERVAL_MS
      );
      this.scheduleReconnect(connectionId);
    }
  }

  /**
   * Stop auto-reconnect for a connection
   */
  stopReconnect(connectionId: string): void {
    const info = this._disconnectedConnections.get(connectionId);
    if (info) {
      if (info.reconnectTimer) {
        clearTimeout(info.reconnectTimer);
        info.reconnectTimer = undefined;
      }
      this._disconnectedConnections.delete(connectionId);

      // Fire event to update UI
      this._onReconnecting.fire({
        connectionId,
        host: info.host,
        attempt: info.reconnectAttempts,
        isReconnecting: false,
      });
    }
  }

  /**
   * Check if a connection is currently in reconnecting state
   */
  isReconnecting(connectionId: string): boolean {
    const info = this._disconnectedConnections.get(connectionId);
    return !!(info && info.reconnectTimer && !info.isManualDisconnect);
  }

  /**
   * Get reconnecting info for a connection
   */
  getReconnectingInfo(connectionId: string): { host: IHostConfig; attempts: number } | undefined {
    const info = this._disconnectedConnections.get(connectionId);
    if (info && !info.isManualDisconnect) {
      return { host: info.host, attempts: info.reconnectAttempts };
    }
    return undefined;
  }

  /**
   * Get all connections that are currently reconnecting
   */
  getReconnectingConnections(): Array<{ connectionId: string; host: IHostConfig; attempts: number }> {
    const result: Array<{ connectionId: string; host: IHostConfig; attempts: number }> = [];
    for (const [connectionId, info] of this._disconnectedConnections) {
      if (!info.isManualDisconnect) {
        result.push({
          connectionId,
          host: info.host,
          attempts: info.reconnectAttempts,
        });
      }
    }
    return result;
  }

  /**
   * Disconnect a specific connection
   */
  async disconnect(connectionId: string): Promise<void> {
    infoLog('connection-manager', 'disconnect-requested', { connectionId });

    // Mark as manual disconnect to prevent auto-reconnect
    // IMPORTANT: Set this BEFORE calling connection.disconnect() so the state change
    // handler can see it. Do NOT call stopReconnect() before disconnect() because
    // stopReconnect() deletes the entry from _disconnectedConnections.
    const disconnectInfo = this._disconnectedConnections.get(connectionId) || {
      host: this._connections.get(connectionId)?.host!,
      reconnectAttempts: 0,
      isManualDisconnect: true,
    };
    disconnectInfo.isManualDisconnect = true;

    // Clear any pending reconnect timer (but don't delete the entry yet)
    if (disconnectInfo.reconnectTimer) {
      clearTimeout(disconnectInfo.reconnectTimer);
      disconnectInfo.reconnectTimer = undefined;
    }

    this._disconnectedConnections.set(connectionId, disconnectInfo);
    diagLog('connection-manager', 'manual-flag-set', { connectionId });

    const connection = this._connections.get(connectionId);
    if (connection) {
      // Track disconnect activity
      const activityService = ActivityService.getInstance();
      const activityId = activityService.startActivity(
        'disconnect',
        connectionId,
        connection.host.name,
        `Disconnect: ${connection.host.name}`,
        { detail: `${connection.host.username}@${connection.host.host}:${connection.host.port}` }
      );

      diagLog('connection-manager', 'calling-connection-disconnect', { connectionId });
      await connection.disconnect();
      diagLog('connection-manager', 'connection-disconnect-returned', { connectionId });

      // Complete activity tracking
      activityService.completeActivity(activityId, 'Disconnected');

      // NOTE: Do NOT delete from _disconnectedConnections here!
      // The SSH2 'close' event fires asynchronously AFTER this method returns.
      // If we delete the entry now, the state handler won't see isManualDisconnect=true
      // and will trigger auto-reconnect. The state handler will clean up when
      // the 'close' event fires and it sees isManualDisconnect=true.

      // Only fire connection change event - state handler will clean up maps
      this._onDidChangeConnections.fire();
      // Update context for VS Code when clauses
      await vscode.commands.executeCommand(
        'setContext',
        'sshLite.hasConnections',
        this._connections.size > 0
      );
    }
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll(): Promise<void> {
    // Mark all as manual disconnect (but don't delete entries yet)
    for (const connectionId of this._connections.keys()) {
      const disconnectInfo = this._disconnectedConnections.get(connectionId) || {
        host: this._connections.get(connectionId)?.host!,
        reconnectAttempts: 0,
        isManualDisconnect: true,
      };
      disconnectInfo.isManualDisconnect = true;

      // Clear timer but don't delete entry
      if (disconnectInfo.reconnectTimer) {
        clearTimeout(disconnectInfo.reconnectTimer);
        disconnectInfo.reconnectTimer = undefined;
      }

      this._disconnectedConnections.set(connectionId, disconnectInfo);
    }

    const disconnectPromises = Array.from(this._connections.values()).map((conn) =>
      conn.disconnect()
    );
    await Promise.all(disconnectPromises);

    // NOTE: Do NOT clear _disconnectedConnections or _connections here!
    // The SSH2 'close' events fire asynchronously AFTER disconnect() returns.
    // Each state handler will clean up its own entry when it sees isManualDisconnect=true.

    this._onDidChangeConnections.fire();
    await vscode.commands.executeCommand('setContext', 'sshLite.hasConnections', false);
  }

  /**
   * Get a specific connection
   */
  getConnection(connectionId: string): SSHConnection | undefined {
    return this._connections.get(connectionId);
  }

  /**
   * Get all active connections
   */
  getAllConnections(): SSHConnection[] {
    return Array.from(this._connections.values()).filter(
      (conn) => conn.state === ConnectionState.Connected
    );
  }

  /**
   * Get all connections including reconnecting ones (for tree view)
   * Returns active connections plus info about reconnecting connections
   */
  getAllConnectionsWithReconnecting(): {
    active: SSHConnection[];
    reconnecting: Array<{ connectionId: string; host: IHostConfig; attempts: number }>;
  } {
    return {
      active: this.getAllConnections(),
      reconnecting: this.getReconnectingConnections(),
    };
  }

  /**
   * Check if there are any active connections
   */
  hasConnections(): boolean {
    return this.getAllConnections().length > 0;
  }

  /**
   * Check if there are any connections (active or reconnecting)
   */
  hasConnectionsOrReconnecting(): boolean {
    return this.getAllConnections().length > 0 || this._disconnectedConnections.size > 0;
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    infoLog('connection-manager', 'dispose', {
      activeConnections: this._connections.size,
      disconnectedTracked: this._disconnectedConnections.size,
      activeReconnectAttempts: this._activeReconnectAttempts.size,
    });
    // Stop all reconnect timers
    for (const connectionId of this._disconnectedConnections.keys()) {
      this.stopReconnect(connectionId);
    }
    this._disconnectedConnections.clear();

    for (const connection of this._connections.values()) {
      connection.dispose();
    }
    this._connections.clear();
    this._onDidChangeConnections.dispose();
    this._onConnectionStateChange.dispose();
    this._onReconnecting.dispose();

    // Reset singleton instance to ensure clean state on reload
    ConnectionManager._instance = undefined as unknown as ConnectionManager;
  }
}
