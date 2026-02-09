import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { PortForwardTreeProvider } from '../providers/PortForwardTreeProvider';
import { IPortForward, ISavedPortForwardRule } from '../types';

/**
 * Saved port forward rules indexed by hostId
 */
interface SavedPortForwardIndex {
  [hostId: string]: ISavedPortForwardRule[];
}

/**
 * Service for managing port forwards with persistence
 */
export class PortForwardService {
  private static _instance: PortForwardService;
  private treeProvider: PortForwardTreeProvider | null = null;
  private context: vscode.ExtensionContext | null = null;
  private savedRules: SavedPortForwardIndex = {};
  private readonly STORAGE_KEY = 'sshLite.savedPortForwards';

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
   * Initialize with extension context for persistence
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.loadSavedRules();
  }

  /**
   * Set the tree provider for refreshing the UI
   */
  setTreeProvider(provider: PortForwardTreeProvider): void {
    this.treeProvider = provider;
  }

  // ==================== PERSISTENCE ====================

  /**
   * Load saved rules from globalState
   */
  private loadSavedRules(): void {
    if (this.context) {
      const stored = this.context.globalState.get<SavedPortForwardIndex>(this.STORAGE_KEY);
      if (stored) {
        this.savedRules = stored;
      }
    }
  }

  /**
   * Save rules to globalState
   */
  private async saveSavedRules(): Promise<void> {
    if (this.context) {
      await this.context.globalState.update(this.STORAGE_KEY, this.savedRules);
    }
  }

  /**
   * Get saved rules for a host
   */
  getSavedRules(hostId: string): ISavedPortForwardRule[] {
    return this.savedRules[hostId] || [];
  }

  /**
   * Get all hostIds that have saved rules
   */
  getHostIdsWithSavedRules(): string[] {
    return Object.keys(this.savedRules);
  }

  /**
   * Save a port forward rule (dedup by localPort+remoteHost+remotePort)
   */
  async saveRule(
    hostId: string,
    localPort: number,
    remoteHost: string,
    remotePort: number
  ): Promise<ISavedPortForwardRule> {
    if (!this.savedRules[hostId]) {
      this.savedRules[hostId] = [];
    }

    // Dedup: check if an identical rule already exists
    const existing = this.savedRules[hostId].find(
      (r) => r.localPort === localPort && r.remoteHost === remoteHost && r.remotePort === remotePort
    );
    if (existing) {
      return existing;
    }

    const rule: ISavedPortForwardRule = {
      id: `pf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      localPort,
      remoteHost,
      remotePort,
    };

    this.savedRules[hostId].push(rule);
    await this.saveSavedRules();
    return rule;
  }

  /**
   * Delete a saved rule
   */
  async deleteSavedRule(hostId: string, ruleId: string): Promise<void> {
    if (!this.savedRules[hostId]) {
      return;
    }

    this.savedRules[hostId] = this.savedRules[hostId].filter((r) => r.id !== ruleId);

    if (this.savedRules[hostId].length === 0) {
      delete this.savedRules[hostId];
    }

    await this.saveSavedRules();

    if (this.treeProvider) {
      this.treeProvider.refresh();
    }
  }

  // ==================== FORWARD MANAGEMENT ====================

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
   * Create a port forward and auto-save the rule
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

      // Auto-save the rule for persistence
      await this.saveRule(connection.id, localPort, remoteHost, remotePort);

      vscode.window.setStatusBarMessage(
        `$(check) Port forward: localhost:${localPort} → ${remoteHost}:${remotePort}`, 5000
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create port forward: ${(error as Error).message}`);
    }
  }

  /**
   * Stop a port forward (keeps the saved rule for later reactivation)
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

      // Remove active forward from tree (saved rule remains visible as dimmed)
      if (this.treeProvider) {
        this.treeProvider.removeForward(forward.localPort, forward.connectionId);
      }

      vscode.window.setStatusBarMessage(`$(check) Port forward stopped: localhost:${forward.localPort}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop port forward: ${(error as Error).message}`);
    }
  }

  /**
   * Deactivate all port forwards for a connection (stops TCP servers, keeps saved rules)
   */
  async deactivateAllForwardsForConnection(connectionId: string): Promise<void> {
    if (!this.treeProvider) {
      return;
    }

    const forwards = this.treeProvider.getForwardsForConnection(connectionId);
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(connectionId);

    if (connection) {
      for (const forward of forwards) {
        try {
          await connection.stopForward(forward.localPort);
        } catch {
          // Connection may already be dead, ignore errors
        }
      }
    }

    // Remove active forwards from tree (saved rules will re-render as dimmed)
    for (const forward of forwards) {
      this.treeProvider.removeForward(forward.localPort, connectionId);
    }
  }

  /**
   * Restore saved port forwards when a connection is established
   */
  async restoreForwardsForConnection(connection: SSHConnection): Promise<void> {
    const rules = this.getSavedRules(connection.id);
    if (rules.length === 0) {
      return;
    }

    let restored = 0;
    let failed = 0;

    for (const rule of rules) {
      try {
        await connection.forwardPort(rule.localPort, rule.remoteHost, rule.remotePort);

        if (this.treeProvider) {
          this.treeProvider.addForward(connection.id, rule.localPort, rule.remoteHost, rule.remotePort);
        }

        restored++;
      } catch {
        failed++;
      }
    }

    if (restored > 0) {
      const failMsg = failed > 0 ? ` (${failed} failed)` : '';
      vscode.window.setStatusBarMessage(
        `$(check) Restored ${restored} port forward${restored > 1 ? 's' : ''} for ${connection.host.name}${failMsg}`,
        5000
      );
    }
  }

  /**
   * Activate a specific saved forward on the current connection
   */
  async activateSavedForward(hostId: string, ruleId: string): Promise<void> {
    const rules = this.getSavedRules(hostId);
    const rule = rules.find((r) => r.id === ruleId);

    if (!rule) {
      vscode.window.showWarningMessage('Saved forward rule not found');
      return;
    }

    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(hostId);

    if (!connection) {
      vscode.window.showWarningMessage('No active connection for this host. Please connect first.');
      return;
    }

    await this.forwardPort(connection, rule.localPort, rule.remoteHost, rule.remotePort);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    // Port forwards are cleaned up when connections are disconnected
  }
}
