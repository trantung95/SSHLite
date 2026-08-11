import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IPortForward, ISavedPortForwardRule } from '../types';
import { PortForwardService } from '../services/PortForwardService';
import { HostService } from '../services/HostService';
import { parseHostId } from '../utils/hostId';
import { hasCapability } from '../utils/capabilityGuard';

type PortForwardRuleTreeItem = PortForwardTreeItem | SavedForwardTreeItem;
type PortForwardTreeElement = PortForwardServerGroupTreeItem | PortForwardRuleTreeItem | NoPortForwardsTreeItem;

interface PortForwardHostSnapshot {
  group: PortForwardServerGroupTreeItem;
  children: PortForwardRuleTreeItem[];
}

/**
 * Tree item representing a server that owns active or saved port forwards.
 */
export class PortForwardServerGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = 'portForwardServerGroup';

  constructor(
    public readonly hostId: string,
    public readonly hostName: string,
    description: string
  ) {
    super(hostName, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `port-forward-server:${hostId}`;
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = description;
    this.tooltip = new vscode.MarkdownString(`**${hostName}**\n\n${description}`);
  }
}

/**
 * Tree item representing an active port forward.
 */
export class PortForwardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly forward: IPortForward,
    public readonly connection: SSHConnection
  ) {
    const remoteTarget = forward.remoteHost === 'localhost'
      ? connection.host.name
      : forward.remoteHost;
    const remoteDisplay = `${remoteTarget}:${forward.remotePort}`;

    super(
      `localhost:${forward.localPort} → ${remoteDisplay}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.id = `active:${forward.id}`;
    this.description = 'Active';
    this.contextValue = 'forward';
    this.iconPath = new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor('charts.blue'));
    this.tooltip = new vscode.MarkdownString(
      `**Active Port Forward**\n\n` +
        `- Local: \`localhost:${forward.localPort}\`\n` +
        `- Remote: \`${forward.remoteHost}:${forward.remotePort}\` on ${connection.host.host}\n` +
        `- Server: ${connection.host.name}\n\n` +
        `Connect to \`localhost:${forward.localPort}\` to reach \`${remoteDisplay}\`.`
    );
  }
}

/** Explicit empty state for the Port Forwards view. */
export class NoPortForwardsTreeItem extends vscode.TreeItem {
  readonly contextValue = 'noPortForwards';

  constructor() {
    super('No port forwards', vscode.TreeItemCollapsibleState.None);
    this.id = 'port-forwards-empty';
    this.description = 'Create one from the toolbar';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

/**
 * Tree item representing a saved but inactive port forward rule.
 */
export class SavedForwardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly rule: ISavedPortForwardRule,
    public readonly hostId: string,
    public readonly hostName: string,
    public readonly hostAddress: string,
    hostConnected = false,
    restoreFailure?: string,
    portForwardAvailable = hostConnected
  ) {
    const remoteTarget = rule.remoteHost === 'localhost' ? hostName : rule.remoteHost;
    const remoteDisplay = `${remoteTarget}:${rule.remotePort}`;

    super(
      `localhost:${rule.localPort} → ${remoteDisplay}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.id = `saved:${JSON.stringify([hostId, rule.id])}`;
    this.description = restoreFailure
      ? `Restore failed · ${restoreFailure}`
      : hostConnected
        ? portForwardAvailable
          ? 'Saved · stopped'
          : 'Port forwarding unavailable'
        : 'Host disconnected';
    this.contextValue = 'savedForward';
    this.iconPath = new vscode.ThemeIcon(
      'arrow-swap',
      new vscode.ThemeColor(restoreFailure ? 'charts.red' : 'disabledForeground')
    );

    const status = restoreFailure
      ? `Restore failed: ${restoreFailure}`
      : hostConnected
        ? portForwardAvailable
          ? 'Saved and stopped'
          : 'Port forwarding unavailable for this connection'
        : 'Host disconnected';
    this.tooltip = new vscode.MarkdownString(
      `**Saved Port Forward**\n\n` +
        `- Local: \`localhost:${rule.localPort}\`\n` +
        `- Remote: \`${rule.remoteHost}:${rule.remotePort}\` on ${hostAddress}\n` +
        `- Server: ${hostName}\n` +
        `- Status: ${status}\n\n` +
        `Start the saved rule or delete it permanently.`
    );
  }
}

/**
 * Tree data provider for port forwards grouped by server.
 */
export class PortForwardTreeProvider implements vscode.TreeDataProvider<PortForwardTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PortForwardTreeElement | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly connectionManager: ConnectionManager;
  private readonly forwards: Map<string, IPortForward> = new Map();
  private readonly groupItems = new Map<string, PortForwardServerGroupTreeItem>();
  private readonly emptyItem = new NoPortForwardsTreeItem();
  private readonly connectionChangeDisposable: vscode.Disposable;
  private readonly hostChangeDisposable: vscode.Disposable;
  private hostSnapshots: Map<string, PortForwardHostSnapshot> | undefined;

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();

    this.connectionChangeDisposable = this.connectionManager.onDidChangeConnections(() => {
      this.cleanupDisconnectedForwards();
      this.refresh();
    });
    this.hostChangeDisposable = HostService.getInstance().onDidChangeHosts(() => this.refresh());
  }

  /** Refresh the tree view. */
  refresh(): void {
    this.hostSnapshots = undefined;
    this._onDidChangeTreeData.fire();
  }

  /** Add a port forward. */
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

  /** Remove a port forward. */
  removeForward(localPort: number, connectionId: string): void {
    this.forwards.delete(`${localPort}:${connectionId}`);
    this.refresh();
  }

  /** Get all forwards for a connection. */
  getForwardsForConnection(connectionId: string): IPortForward[] {
    return Array.from(this.forwards.values()).filter((forward) => forward.connectionId === connectionId);
  }

  /** Clean up forwards for disconnected connections. */
  private cleanupDisconnectedForwards(): void {
    const connectedIds = new Set(
      this.connectionManager.getAllConnections()
        .filter((connection) => hasCapability(connection, 'supportsPortForward'))
        .map((connection) => connection.id)
    );

    for (const [id, forward] of this.forwards) {
      if (!connectedIds.has(forward.connectionId)) {
        this.forwards.delete(id);
      }
    }
  }

  /** Get tree item representation. */
  getTreeItem(element: PortForwardTreeElement): vscode.TreeItem {
    return element;
  }

  /** Get server groups at root or active and saved rows below a server. */
  async getChildren(element?: PortForwardTreeElement): Promise<PortForwardTreeElement[]> {
    const snapshots = this.getHostSnapshots();

    if (!element) {
      const groups = Array.from(snapshots.values())
        .map((snapshot) => snapshot.group)
        .sort((left, right) => left.hostName.localeCompare(right.hostName));
      return groups.length > 0 ? groups : [this.emptyItem];
    }

    if (element instanceof PortForwardServerGroupTreeItem) {
      return snapshots.get(element.hostId)?.children ?? [];
    }

    return [];
  }

  /** Return the cached server group that owns a rule row. */
  getParent(element: PortForwardTreeElement): PortForwardServerGroupTreeItem | undefined {
    const hostId = element instanceof PortForwardTreeItem
      ? element.forward.connectionId
      : element instanceof SavedForwardTreeItem
        ? element.hostId
        : undefined;
    if (!hostId) {
      return undefined;
    }

    return this.groupItems.get(hostId) ?? this.getHostSnapshots().get(hostId)?.group;
  }

  private getHostSnapshots(): Map<string, PortForwardHostSnapshot> {
    if (!this.hostSnapshots) {
      this.hostSnapshots = this.buildHostSnapshots();
    }
    return this.hostSnapshots;
  }

  private buildHostSnapshots(): Map<string, PortForwardHostSnapshot> {
    const portForwardService = PortForwardService.getInstance();
    const connections = this.connectionManager.getAllConnections();
    const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
    const hostMap = new Map(HostService.getInstance().getAllHosts().map((host) => [host.id, host]));
    const activeByHost = new Map<string, IPortForward[]>();

    for (const forward of this.forwards.values()) {
      const connection = connectionMap.get(forward.connectionId);
      if (!connection || !hasCapability(connection, 'supportsPortForward')) {
        continue;
      }
      const active = activeByHost.get(forward.connectionId) ?? [];
      active.push(forward);
      activeByHost.set(forward.connectionId, active);
    }

    const hostIds = new Set([
      ...activeByHost.keys(),
      ...portForwardService.getHostIdsWithSavedRules(),
    ]);
    const snapshots = new Map<string, PortForwardHostSnapshot>();

    for (const hostId of hostIds) {
      const connection = connectionMap.get(hostId);
      const portForwardAvailable = Boolean(connection && hasCapability(connection, 'supportsPortForward'));
      const configuredHost = hostMap.get(hostId);
      const activeForwards = activeByHost.get(hostId) ?? [];
      const activeKeys = new Set(activeForwards.map((forward) => this.forwardKey(forward)));
      const savedRules = portForwardService.getSavedRules(hostId)
        .filter((rule) => !activeKeys.has(this.ruleKey(rule)));

      if (activeForwards.length === 0 && savedRules.length === 0) {
        continue;
      }

      const parsedHost = parseHostId(hostId);
      const hostName = connection?.host.name ?? configuredHost?.name ?? hostId;
      const hostAddress = connection?.host.host ?? configuredHost?.host ?? parsedHost.host;
      const children: PortForwardRuleTreeItem[] = [
        ...activeForwards.map((forward) => new PortForwardTreeItem(forward, connection!)),
        ...savedRules.map((rule) => new SavedForwardTreeItem(
          rule,
          hostId,
          hostName,
          hostAddress,
          Boolean(connection),
          portForwardService.getRestoreFailure(hostId, rule.id),
          portForwardAvailable
        )),
      ];
      const description = `${activeForwards.length} active · ${savedRules.length} saved`;
      let group = this.groupItems.get(hostId);
      if (!group || group.hostName !== hostName) {
        group = new PortForwardServerGroupTreeItem(hostId, hostName, description);
        this.groupItems.set(hostId, group);
      } else {
        group.description = description;
        group.tooltip = new vscode.MarkdownString(`**${hostName}**\n\n${description}`);
      }
      snapshots.set(hostId, { group, children });
    }

    for (const hostId of this.groupItems.keys()) {
      if (!snapshots.has(hostId)) {
        this.groupItems.delete(hostId);
      }
    }

    return snapshots;
  }

  private forwardKey(forward: IPortForward): string {
    return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`;
  }

  private ruleKey(rule: ISavedPortForwardRule): string {
    return `${rule.localPort}:${rule.remoteHost}:${rule.remotePort}`;
  }

  /** Dispose of resources. */
  dispose(): void {
    this.connectionChangeDisposable.dispose();
    this.hostChangeDisposable.dispose();
    this.hostSnapshots = undefined;
    this.groupItems.clear();
    this._onDidChangeTreeData.dispose();
  }
}
