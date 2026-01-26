import * as vscode from 'vscode';
import { SSHConnection } from './SSHConnection';
import { IHostConfig, ConnectionState } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { ActivityService } from '../services/ActivityService';

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

  // Track disconnected connections for auto-reconnect
  private _disconnectedConnections: Map<string, DisconnectedConnectionInfo> = new Map();

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
   * Create and connect to a host
   */
  async connect(host: IHostConfig): Promise<SSHConnection> {
    const connectionId = `${host.host}:${host.port}:${host.username}`;

    // Clear any pending reconnect for this host
    this.stopReconnect(connectionId);

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      return existing;
    }

    // Create new connection
    const connection = new SSHConnection(host);

    // Listen to state changes
    connection.onStateChange((state) => {
      console.log(`[SSH Lite] State change for ${connectionId}: ${state}`);
      this._onConnectionStateChange.fire({ connection, state });

      // Handle unexpected disconnect - start auto-reconnect
      if (state === ConnectionState.Disconnected) {
        const disconnectInfo = this._disconnectedConnections.get(connectionId);
        console.log(`[SSH Lite] Disconnect handler - connectionId: ${connectionId}, isManualDisconnect: ${disconnectInfo?.isManualDisconnect}`);
        if (!disconnectInfo?.isManualDisconnect) {
          // Unexpected disconnect - start auto-reconnect
          console.log(`[SSH Lite] Starting auto-reconnect for: ${connectionId}`);
          this.startReconnect(connectionId, host);
        } else {
          // Manual disconnect - remove from maps
          console.log(`[SSH Lite] Manual disconnect, cleaning up: ${connectionId}`);
          this._connections.delete(connectionId);
          this._disconnectedConnections.delete(connectionId);
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

    // Clear any pending reconnect for this host
    this.stopReconnect(connectionId);

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      return existing;
    }

    // Create new connection with credential
    const connection = new SSHConnection(host, credential);

    // Listen to state changes
    connection.onStateChange((state) => {
      console.log(`[SSH Lite] State change (withCred) for ${connectionId}: ${state}`);
      this._onConnectionStateChange.fire({ connection, state });

      // Handle unexpected disconnect - start auto-reconnect
      if (state === ConnectionState.Disconnected) {
        const disconnectInfo = this._disconnectedConnections.get(connectionId);
        console.log(`[SSH Lite] Disconnect handler (withCred) - connectionId: ${connectionId}, isManualDisconnect: ${disconnectInfo?.isManualDisconnect}`);
        if (!disconnectInfo?.isManualDisconnect) {
          // Unexpected disconnect - start auto-reconnect with credential
          console.log(`[SSH Lite] Starting auto-reconnect (withCred) for: ${connectionId}`);
          this.startReconnect(connectionId, host, credential);
        } else {
          // Manual disconnect - remove from maps
          console.log(`[SSH Lite] Manual disconnect (withCred), cleaning up: ${connectionId}`);
          this._connections.delete(connectionId);
          this._disconnectedConnections.delete(connectionId);
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
      this._connections.delete(connectionId);
      this._onDidChangeConnections.fire();
      throw error;
    }
  }

  /**
   * Start auto-reconnect for a disconnected connection
   */
  private startReconnect(connectionId: string, host: IHostConfig, credential?: SavedCredential): void {
    // Don't start if already reconnecting
    if (this._disconnectedConnections.has(connectionId) &&
        this._disconnectedConnections.get(connectionId)?.reconnectTimer) {
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
      return;
    }

    info.reconnectAttempts++;

    // Check max attempts (0 = unlimited)
    if (this.MAX_RECONNECT_ATTEMPTS > 0 && info.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
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
      // Failed - schedule another attempt
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
    console.log(`[SSH Lite] disconnect() called for: ${connectionId}`);

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
    console.log(`[SSH Lite] Set isManualDisconnect=true for: ${connectionId}`);

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

      console.log(`[SSH Lite] Calling connection.disconnect() for: ${connectionId}`);
      await connection.disconnect();
      console.log(`[SSH Lite] connection.disconnect() returned for: ${connectionId}`);

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
