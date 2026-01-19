import * as vscode from 'vscode';
import { SSHConnection } from './SSHConnection';
import { IHostConfig, ConnectionState } from '../types';
import { SavedCredential } from '../services/CredentialService';

/**
 * Manages multiple SSH connections
 */
export class ConnectionManager {
  private static _instance: ConnectionManager;
  private _connections: Map<string, SSHConnection> = new Map();

  private readonly _onDidChangeConnections = new vscode.EventEmitter<void>();
  public readonly onDidChangeConnections = this._onDidChangeConnections.event;

  private readonly _onConnectionStateChange = new vscode.EventEmitter<{
    connection: SSHConnection;
    state: ConnectionState;
  }>();
  public readonly onConnectionStateChange = this._onConnectionStateChange.event;

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

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      return existing;
    }

    // Create new connection
    const connection = new SSHConnection(host);

    // Listen to state changes
    connection.onStateChange((state) => {
      this._onConnectionStateChange.fire({ connection, state });
      this._onDidChangeConnections.fire();

      // Remove connection on disconnect
      if (state === ConnectionState.Disconnected) {
        this._connections.delete(connectionId);
      }
    });

    // Store and connect
    this._connections.set(connectionId, connection);
    this._onDidChangeConnections.fire();

    try {
      await connection.connect();
      // Update context for VS Code when clauses
      await vscode.commands.executeCommand(
        'setContext',
        'sshLite.hasConnections',
        this._connections.size > 0
      );
      return connection;
    } catch (error) {
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

    // Return existing connection if already connected
    const existing = this._connections.get(connectionId);
    if (existing && existing.state === ConnectionState.Connected) {
      return existing;
    }

    // Create new connection with credential
    const connection = new SSHConnection(host, credential);

    // Listen to state changes
    connection.onStateChange((state) => {
      this._onConnectionStateChange.fire({ connection, state });
      this._onDidChangeConnections.fire();

      // Remove connection on disconnect
      if (state === ConnectionState.Disconnected) {
        this._connections.delete(connectionId);
      }
    });

    // Store and connect
    this._connections.set(connectionId, connection);
    this._onDidChangeConnections.fire();

    try {
      await connection.connect();
      // Update context for VS Code when clauses
      await vscode.commands.executeCommand(
        'setContext',
        'sshLite.hasConnections',
        this._connections.size > 0
      );
      return connection;
    } catch (error) {
      this._connections.delete(connectionId);
      this._onDidChangeConnections.fire();
      throw error;
    }
  }

  /**
   * Disconnect a specific connection
   */
  async disconnect(connectionId: string): Promise<void> {
    const connection = this._connections.get(connectionId);
    if (connection) {
      await connection.disconnect();
      this._connections.delete(connectionId);
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
    const disconnectPromises = Array.from(this._connections.values()).map((conn) =>
      conn.disconnect()
    );
    await Promise.all(disconnectPromises);
    this._connections.clear();
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
   * Check if there are any active connections
   */
  hasConnections(): boolean {
    return this.getAllConnections().length > 0;
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    for (const connection of this._connections.values()) {
      connection.dispose();
    }
    this._connections.clear();
    this._onDidChangeConnections.dispose();
    this._onConnectionStateChange.dispose();
  }
}
