import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IPortForward } from '../types';

/**
 * Tree item representing a port forward
 */
export class PortForwardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly forward: IPortForward,
    public readonly connection: SSHConnection
  ) {
    // Format: remoteHost:remotePort <-> localhost:localPort
    // Shows the actual remote target clearly (not just "localhost" which is relative to SSH server)
    const remoteDisplay = forward.remoteHost === 'localhost'
      ? `${connection.host.host}:${forward.remotePort}`
      : `${forward.remoteHost}:${forward.remotePort}`;

    super(
      `${remoteDisplay} <-> localhost:${forward.localPort}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = connection.host.name;
    this.contextValue = 'forward';
    this.iconPath = new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor('charts.blue'));

    this.tooltip = new vscode.MarkdownString(
      `**Port Forward**\n\n` +
        `- Local: \`localhost:${forward.localPort}\`\n` +
        `- Remote: \`${forward.remoteHost}:${forward.remotePort}\` (on ${connection.host.host})\n` +
        `- Connection: ${connection.host.name}\n` +
        `- Status: ${forward.active ? 'Active' : 'Stopped'}\n\n` +
        `*Connect to localhost:${forward.localPort} to reach ${remoteDisplay}*`
    );
  }
}

/**
 * Tree data provider for port forwards
 */
export class PortForwardTreeProvider implements vscode.TreeDataProvider<PortForwardTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PortForwardTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connectionManager: ConnectionManager;
  private forwards: Map<string, IPortForward> = new Map(); // localPort:connectionId -> forward

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();

    // Refresh when connections change
    this.connectionManager.onDidChangeConnections(() => {
      this.cleanupDisconnectedForwards();
      this.refresh();
    });
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Add a port forward
   */
  addForward(connectionId: string, localPort: number, remoteHost: string, remotePort: number): void {
    const forward: IPortForward = {
      id: `${localPort}:${connectionId}`,
      connectionId,
      localPort,
      remoteHost,
      remotePort,
      active: true,
    };
    this.forwards.set(forward.id, forward);
    this.refresh();
  }

  /**
   * Remove a port forward
   */
  removeForward(localPort: number, connectionId: string): void {
    const id = `${localPort}:${connectionId}`;
    this.forwards.delete(id);
    this.refresh();
  }

  /**
   * Get all forwards for a connection
   */
  getForwardsForConnection(connectionId: string): IPortForward[] {
    return Array.from(this.forwards.values()).filter((f) => f.connectionId === connectionId);
  }

  /**
   * Clean up forwards for disconnected connections
   */
  private cleanupDisconnectedForwards(): void {
    const connections = this.connectionManager.getAllConnections();
    const connectedIds = new Set(connections.map((c) => c.id));

    for (const [id, forward] of this.forwards) {
      if (!connectedIds.has(forward.connectionId)) {
        this.forwards.delete(id);
      }
    }
  }

  /**
   * Get tree item representation
   */
  getTreeItem(element: PortForwardTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children (forwards)
   */
  async getChildren(element?: PortForwardTreeItem): Promise<PortForwardTreeItem[]> {
    if (element) {
      return []; // Forwards have no children
    }

    const items: PortForwardTreeItem[] = [];
    const connections = this.connectionManager.getAllConnections();
    const connectionMap = new Map(connections.map((c) => [c.id, c]));

    for (const forward of this.forwards.values()) {
      const connection = connectionMap.get(forward.connectionId);
      if (connection) {
        items.push(new PortForwardTreeItem(forward, connection));
      }
    }

    return items;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
