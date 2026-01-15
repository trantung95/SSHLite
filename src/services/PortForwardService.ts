import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { PortForwardTreeProvider } from '../providers/PortForwardTreeProvider';
import { IPortForward } from '../types';

/**
 * Service for managing port forwards
 */
export class PortForwardService {
  private static _instance: PortForwardService;
  private treeProvider: PortForwardTreeProvider | null = null;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): PortForwardService {
    if (!PortForwardService._instance) {
      PortForwardService._instance = new PortForwardService();
    }
    return PortForwardService._instance;
  }

  /**
   * Set the tree provider for refreshing the UI
   */
  setTreeProvider(provider: PortForwardTreeProvider): void {
    this.treeProvider = provider;
  }

  /**
   * Prompt user to create a new port forward
   */
  async promptForwardPort(): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connections = connectionManager.getAllConnections();

    if (connections.length === 0) {
      vscode.window.showWarningMessage('No active SSH connections. Please connect first.');
      return;
    }

    // Select connection
    const connectionItems = connections.map((conn) => ({
      label: conn.host.name,
      description: `${conn.host.username}@${conn.host.host}`,
      connection: conn,
    }));

    const selectedConnection = await vscode.window.showQuickPick(connectionItems, {
      placeHolder: 'Select SSH connection',
      ignoreFocusOut: true,
    });

    if (!selectedConnection) {
      return;
    }

    // Get local port
    const localPortStr = await vscode.window.showInputBox({
      prompt: 'Enter local port',
      placeHolder: '8080',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const port = parseInt(value, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          return 'Please enter a valid port number (1-65535)';
        }
        // Check if port is already in use locally
        const existingForwards = selectedConnection.connection.getActiveForwards();
        if (existingForwards.includes(port)) {
          return 'This local port is already forwarded';
        }
        return null;
      },
    });

    if (!localPortStr) {
      return;
    }

    const localPort = parseInt(localPortStr, 10);

    // Get remote host
    const remoteHost = await vscode.window.showInputBox({
      prompt: 'Enter remote host (on the SSH server)',
      value: 'localhost',
      ignoreFocusOut: true,
    });

    if (!remoteHost) {
      return;
    }

    // Get remote port
    const remotePortStr = await vscode.window.showInputBox({
      prompt: 'Enter remote port',
      value: localPortStr, // Default to same as local
      ignoreFocusOut: true,
      validateInput: (value) => {
        const port = parseInt(value, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          return 'Please enter a valid port number (1-65535)';
        }
        return null;
      },
    });

    if (!remotePortStr) {
      return;
    }

    const remotePort = parseInt(remotePortStr, 10);

    // Create the forward
    await this.forwardPort(selectedConnection.connection, localPort, remoteHost, remotePort);
  }

  /**
   * Create a port forward
   */
  async forwardPort(
    connection: SSHConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number
  ): Promise<void> {
    try {
      await connection.forwardPort(localPort, remoteHost, remotePort);

      // Update tree provider
      if (this.treeProvider) {
        this.treeProvider.addForward(connection.id, localPort, remoteHost, remotePort);
      }

      vscode.window.showInformationMessage(
        `Port forward created: localhost:${localPort} → ${remoteHost}:${remotePort}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create port forward: ${(error as Error).message}`);
    }
  }

  /**
   * Stop a port forward
   */
  async stopForward(forward: IPortForward): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(forward.connectionId);

    if (!connection) {
      vscode.window.showWarningMessage('Connection no longer active');
      return;
    }

    try {
      await connection.stopForward(forward.localPort);

      // Update tree provider
      if (this.treeProvider) {
        this.treeProvider.removeForward(forward.localPort, forward.connectionId);
      }

      vscode.window.showInformationMessage(`Port forward stopped: localhost:${forward.localPort}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop port forward: ${(error as Error).message}`);
    }
  }

  /**
   * Stop all port forwards for a connection
   */
  async stopAllForwardsForConnection(connectionId: string): Promise<void> {
    if (!this.treeProvider) {
      return;
    }

    const forwards = this.treeProvider.getForwardsForConnection(connectionId);
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(connectionId);

    if (!connection) {
      return;
    }

    for (const forward of forwards) {
      await connection.stopForward(forward.localPort);
      this.treeProvider.removeForward(forward.localPort, connectionId);
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    // Port forwards are cleaned up when connections are disconnected
  }
}
