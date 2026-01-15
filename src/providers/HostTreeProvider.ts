import * as vscode from 'vscode';
import { HostService } from '../services/HostService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { IHostConfig, ConnectionState } from '../types';

/**
 * Tree item representing an SSH host
 */
export class HostTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hostConfig: IHostConfig,
    public readonly isConnected: boolean
  ) {
    super(hostConfig.name, vscode.TreeItemCollapsibleState.None);

    this.description = `${hostConfig.username}@${hostConfig.host}:${hostConfig.port}`;
    this.tooltip = new vscode.MarkdownString(
      `**${hostConfig.name}**\n\n` +
        `- Host: ${hostConfig.host}\n` +
        `- Port: ${hostConfig.port}\n` +
        `- Username: ${hostConfig.username}\n` +
        `- Source: ${hostConfig.source === 'ssh-config' ? '~/.ssh/config' : 'Saved'}\n` +
        `- Status: ${isConnected ? 'Connected' : 'Disconnected'}`
    );

    // Set context value for menu visibility
    if (isConnected) {
      this.contextValue = 'connectedHost';
      this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
    } else if (hostConfig.source === 'saved') {
      this.contextValue = 'savedHost';
      this.iconPath = new vscode.ThemeIcon('vm');
    } else {
      this.contextValue = 'host';
      this.iconPath = new vscode.ThemeIcon('vm-outline');
    }

    // Set command for double-click
    this.command = {
      command: isConnected ? 'sshLite.disconnect' : 'sshLite.connect',
      title: isConnected ? 'Disconnect' : 'Connect',
      arguments: [this],
    };
  }
}

/**
 * Tree data provider for SSH hosts
 */
export class HostTreeProvider implements vscode.TreeDataProvider<HostTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HostTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private hostService: HostService;
  private connectionManager: ConnectionManager;

  constructor() {
    this.hostService = HostService.getInstance();
    this.connectionManager = ConnectionManager.getInstance();

    // Refresh when connections change
    this.connectionManager.onDidChangeConnections(() => {
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
   * Get tree item representation
   */
  getTreeItem(element: HostTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children (hosts)
   */
  async getChildren(element?: HostTreeItem): Promise<HostTreeItem[]> {
    if (element) {
      return []; // Hosts have no children
    }

    const hosts = await this.hostService.getAllHosts();
    const connections = this.connectionManager.getAllConnections();
    const connectedIds = new Set(connections.map((c) => c.id));

    return hosts.map((host) => new HostTreeItem(host, connectedIds.has(host.id)));
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
