import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IPortForward, ISavedPortForwardRule } from '../types';
import { PortForwardService } from '../services/PortForwardService';
import { HostService } from '../services/HostService';

type PortForwardTreeElement = PortForwardTreeItem | SavedForwardTreeItem;

/**
 * Tree item representing an active port forward
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
 * Tree item representing a saved-but-inactive port forward rule
 */
export class SavedForwardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly rule: ISavedPortForwardRule,
    public readonly hostId: string,
    public readonly hostName: string,
    public readonly hostAddress: string
  ) {
    const remoteDisplay = rule.remoteHost === 'localhost'
      ? `${hostAddress}:${rule.remotePort}`
      : `${rule.remoteHost}:${rule.remotePort}`;

    super(
      `${remoteDisplay} <-> localhost:${rule.localPort}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.id = `saved:${hostId}:${rule.id}`;
    this.description = `${hostName} (saved)`;
    this.contextValue = 'savedForward';
    this.iconPath = new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor('disabledForeground'));

    this.tooltip = new vscode.MarkdownString(
      `**Saved Port Forward** (inactive)\n\n` +
        `- Local: \`localhost:${rule.localPort}\`\n` +
        `- Remote: \`${rule.remoteHost}:${rule.remotePort}\`\n` +
        `- Host: ${hostName}\n\n` +
        `*Click play to activate, or delete to remove saved rule*`
    );
  }
}

/**
 * Tree data provider for port forwards
 */
export class PortForwardTreeProvider implements vscode.TreeDataProvider<PortForwardTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PortForwardTreeElement | undefined | void>();
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
  getTreeItem(element: PortForwardTreeElement): vscode.TreeItem {
    return element;
  }

  /**
   * Get children (active forwards + saved-but-inactive rules)
   */
  async getChildren(element?: PortForwardTreeElement): Promise<PortForwardTreeElement[]> {
    if (element) {
      return []; // Forwards have no children
    }

    const items: PortForwardTreeElement[] = [];
    const connections = this.connectionManager.getAllConnections();
    const connectionMap = new Map(connections.map((c) => [c.id, c]));

    // Track active forward keys to avoid duplicating them as saved items
    const activeKeys = new Set<string>();

    // 1. Add active forwards
    for (const forward of this.forwards.values()) {
      const connection = connectionMap.get(forward.connectionId);
      if (connection) {
        items.push(new PortForwardTreeItem(forward, connection));
        activeKeys.add(`${forward.connectionId}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`);
      }
    }

    // 2. Add saved-but-inactive rules
    const portForwardService = PortForwardService.getInstance();
    const hostService = HostService.getInstance();
    const allHosts = hostService.getAllHosts();

    for (const host of allHosts) {
      const savedRules = portForwardService.getSavedRules(host.id);
      for (const rule of savedRules) {
        const key = `${host.id}:${rule.localPort}:${rule.remoteHost}:${rule.remotePort}`;
        if (!activeKeys.has(key)) {
          items.push(new SavedForwardTreeItem(rule, host.id, host.name, host.host));
        }
      }
    }

    // Also show saved rules for hosts not currently in hostService
    // (e.g., hosts removed from config but still have saved rules)
    const knownHostIds = new Set(allHosts.map((h) => h.id));
    for (const hostId of portForwardService.getHostIdsWithSavedRules()) {
      if (knownHostIds.has(hostId)) {
        continue;
      }
      const savedRules = portForwardService.getSavedRules(hostId);
      const [hostAddr] = hostId.split(':');
      for (const rule of savedRules) {
        const key = `${hostId}:${rule.localPort}:${rule.remoteHost}:${rule.remotePort}`;
        if (!activeKeys.has(key)) {
          items.push(new SavedForwardTreeItem(rule, hostId, hostId, hostAddr));
        }
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
