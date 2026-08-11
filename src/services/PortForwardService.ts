import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { PortForwardTreeProvider } from '../providers/PortForwardTreeProvider';
import { IPortForward, ISavedPortForwardRule } from '../types';
import { diagLog, infoLog } from '../utils/diagnosticLog';
import { assertCapability, hasCapability } from '../utils/capabilityGuard';
import { formatErrorMessage, portForwardStepTitle, validatePort } from '../ui/nativeFeedback';

/**
 * Saved port forward rules indexed by hostId
 */
interface SavedPortForwardIndex {
  [hostId: string]: ISavedPortForwardRule[];
}

interface SavedRulesWriteLifecycle {
  generation: number;
  context: vscode.ExtensionContext | null;
}

/**
 * Service for managing port forwards with persistence
 */
export class PortForwardService {
  private static _instance: PortForwardService;
  private treeProvider: PortForwardTreeProvider | null = null;
  private context: vscode.ExtensionContext | null = null;
  private savedRules: SavedPortForwardIndex = {};
  private savedRulesWriteQueue: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private readonly restoreFailures = new Map<string, Map<string, string>>();
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
    this.lifecycleGeneration++;
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
  private async saveSavedRules(
    rules: SavedPortForwardIndex,
    context: vscode.ExtensionContext | null
  ): Promise<void> {
    if (context) {
      await context.globalState.update(this.STORAGE_KEY, rules);
    }
  }

  private enqueueSavedRulesWrite<T>(
    write: (lifecycle: SavedRulesWriteLifecycle) => Promise<T>
  ): Promise<T> {
    const lifecycle = {
      generation: this.lifecycleGeneration,
      context: this.context,
    };
    const run = () => write(lifecycle);
    const result = this.savedRulesWriteQueue.then(run, run);
    this.savedRulesWriteQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private isCurrentLifecycle(lifecycle: SavedRulesWriteLifecycle): boolean {
    return lifecycle.generation === this.lifecycleGeneration && lifecycle.context === this.context;
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

  /** Get the current-session restore failure for a saved rule. */
  getRestoreFailure(hostId: string, ruleId: string): string | undefined {
    return this.restoreFailures.get(hostId)?.get(ruleId);
  }

  /** Clear the current-session restore failure for a saved rule. */
  clearRestoreFailure(hostId: string, ruleId: string): void {
    const hostFailures = this.restoreFailures.get(hostId);
    if (!hostFailures) {
      return;
    }
    hostFailures.delete(ruleId);
    if (hostFailures.size === 0) {
      this.restoreFailures.delete(hostId);
    }
  }

  private setRestoreFailure(hostId: string, ruleId: string, message: string): void {
    let hostFailures = this.restoreFailures.get(hostId);
    if (!hostFailures) {
      hostFailures = new Map<string, string>();
      this.restoreFailures.set(hostId, hostFailures);
    }
    hostFailures.set(ruleId, message);
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
    return this.enqueueSavedRulesWrite(async (lifecycle) => {
      if (!this.isCurrentLifecycle(lifecycle)) {
        throw new Error('Saved port forward write cancelled because the extension lifecycle changed');
      }
      const hostRules = this.savedRules[hostId] ?? [];

      // Dedup: check if an identical rule already exists
      const existing = hostRules.find(
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

      const nextSavedRules: SavedPortForwardIndex = {
        ...this.savedRules,
        [hostId]: [...hostRules, rule],
      };
      await this.saveSavedRules(nextSavedRules, lifecycle.context);
      if (this.isCurrentLifecycle(lifecycle)) {
        this.savedRules = nextSavedRules;
      }
      return rule;
    });
  }

  /**
   * Delete a saved rule
   */
  async deleteSavedRule(hostId: string, ruleId: string): Promise<void> {
    return this.enqueueSavedRulesWrite(async (lifecycle) => {
      if (!this.isCurrentLifecycle(lifecycle)) {
        return;
      }
      if (!this.savedRules[hostId]) {
        return;
      }

      const nextHostRules = this.savedRules[hostId].filter((r) => r.id !== ruleId);
      const nextSavedRules: SavedPortForwardIndex = { ...this.savedRules };

      if (nextHostRules.length === 0) {
        delete nextSavedRules[hostId];
      } else {
        nextSavedRules[hostId] = nextHostRules;
      }

      await this.saveSavedRules(nextSavedRules, lifecycle.context);
      if (!this.isCurrentLifecycle(lifecycle)) {
        return;
      }
      this.savedRules = nextSavedRules;
      this.clearRestoreFailure(hostId, ruleId);

      if (this.treeProvider) {
        this.treeProvider.refresh();
      }
    });
  }

  // ==================== FORWARD MANAGEMENT ====================

  /**
   * Prompt user to create a new port forward
   */
  async promptForwardPort(): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    // Port forwarding is SSH-only; never offer an FTP connection in the picker.
    // getAllConnections() guarantees that every returned connection is active,
    // so connected hosts are the complete picker population rather than a sort tier.
    const connections = connectionManager
      .getAllConnections()
      .filter((connection) => hasCapability(connection, 'supportsPortForward'));

    if (connections.length === 0) {
      vscode.window.showWarningMessage('No active SSH connections. Please connect first.');
      return;
    }

    // Select connection
    const connectionItems = connections.map((connection) => ({
      label: connection.host.name,
      description: `${connection.host.username}@${connection.host.host} · port ${connection.host.port}`,
      connection,
    }));

    const selectedConnection = await vscode.window.showQuickPick(connectionItems, {
      title: portForwardStepTitle(1),
      placeHolder: 'Select SSH connection',
      ignoreFocusOut: true,
    });

    if (!selectedConnection) {
      diagLog('port-forward', 'prompt-cancelled', { step: 1 });
      return;
    }
    diagLog('port-forward', 'prompt-server-selected', {
      connectionId: selectedConnection.connection.id,
      hostName: selectedConnection.connection.host.name,
    });

    // Get remote port first — this is the port the user wants to reach
    const remotePortStr = await vscode.window.showInputBox({
      title: portForwardStepTitle(2),
      prompt: 'Enter the service port on the destination host',
      placeHolder: '8080',
      ignoreFocusOut: true,
      validateInput: (value) => validatePort(value),
    });

    if (!remotePortStr) {
      diagLog('port-forward', 'prompt-cancelled', { step: 2, field: 'destination-port' });
      return;
    }

    const remotePort = Number(remotePortStr);

    // Get destination host — usually the SSH server itself (localhost)
    const remoteHost = await vscode.window.showInputBox({
      title: portForwardStepTitle(2),
      prompt: 'Enter the destination host. localhost means the SSH server itself',
      value: 'localhost',
      ignoreFocusOut: true,
    });

    if (!remoteHost) {
      diagLog('port-forward', 'prompt-cancelled', { step: 2, field: 'destination-host' });
      return;
    }

    // Get local port — the port on the user's machine
    const unavailableLocalPorts = new Set(
      connections.flatMap((connection) => connection.getActiveForwards())
    );

    const localPortStr = await vscode.window.showInputBox({
      title: portForwardStepTitle(3),
      prompt: 'Enter the listening port on this computer',
      value: remotePortStr, // Default to same as remote
      ignoreFocusOut: true,
      validateInput: (value) => validatePort(value, unavailableLocalPorts),
    });

    if (!localPortStr) {
      diagLog('port-forward', 'prompt-cancelled', { step: 3 });
      return;
    }

    const localPort = Number(localPortStr);

    // Create the forward
    await this.forwardPort(selectedConnection.connection, localPort, remoteHost, remotePort, {
      interactiveCreate: true,
    });
  }

  /**
   * Create a port forward and auto-save the rule
   */
  async forwardPort(
    connection: SSHConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    options: { interactiveCreate?: boolean } = {}
  ): Promise<void> {
    // Backstop: FTP has no port forwarding. Covers promptForwardPort,
    // activateSavedForward, and restoreSavedForwards (all route through here).
    assertCapability(connection, 'supportsPortForward');
    const t0 = Date.now();
    infoLog('port-forward', 'create/begin', {
      connectionId: connection.id,
      hostName: connection.host.name,
      localPort,
      remoteHost,
      remotePort,
    });
    let listenerStarted = false;
    let treeRowMutationAttempted = false;
    let persistenceCompleted = false;
    let failureStage: 'listener' | 'tree' | 'persistence' | 'feedback' = 'listener';
    try {
      await connection.forwardPort(localPort, remoteHost, remotePort);
      listenerStarted = true;
      failureStage = 'tree';

      // Update tree provider
      if (this.treeProvider) {
        treeRowMutationAttempted = true;
        this.treeProvider.addForward(connection.id, localPort, remoteHost, remotePort);
      }

      // Auto-save the rule for persistence
      failureStage = 'persistence';
      const savedRule = await this.saveRule(connection.id, localPort, remoteHost, remotePort);
      persistenceCompleted = true;
      failureStage = 'feedback';
      this.clearRestoreFailure(connection.id, savedRule.id);

      infoLog('port-forward', 'create/success', {
        connectionId: connection.id,
        localPort,
        remoteHost,
        remotePort,
        durationMs: Date.now() - t0,
      });
      const status = options.interactiveCreate
        ? `$(check) Port forward created and saved: localhost:${localPort} → ${remoteHost}:${remotePort}`
        : `$(check) Port forward: localhost:${localPort} → ${remoteHost}:${remotePort}`;
      vscode.window.setStatusBarMessage(status, 5000);
    } catch (error) {
      const e = error as Error;
      let retrySafe = !listenerStarted;
      if (listenerStarted && !persistenceCompleted) {
        try {
          await connection.stopForward(localPort);
          if (treeRowMutationAttempted && this.treeProvider) {
            this.treeProvider.removeForward(localPort, connection.id);
          }
          retrySafe = true;
          infoLog('port-forward', 'create-rollback-completed', {
            connectionId: connection.id,
            localPort,
          });
        } catch (rollbackError) {
          const rollbackReason = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
          retrySafe = false;
          infoLog('port-forward', 'create-rollback-failed', {
            connectionId: connection.id,
            localPort,
            rollbackReason,
          });
        }
      }
      infoLog('port-forward', 'create/failed', {
        connectionId: connection.id,
        localPort,
        remoteHost,
        remotePort,
        durationMs: Date.now() - t0,
        failureStage,
        errorName: e.name,
        errorMessage: e.message,
      });
      if (options.interactiveCreate) {
        let recovery: string;
        if (!retrySafe) {
          recovery = 'Stop the active port forward before trying again';
        } else if (failureStage === 'persistence') {
          recovery = 'Check storage access and try again';
        } else if (failureStage === 'tree') {
          recovery = 'Refresh the Port Forwards view and try again';
        } else if (/address|already forwarded|EADDRINUSE/i.test(e.message)) {
          recovery = 'Choose another local port and try again';
        } else {
          recovery = 'Check the connection and try again';
        }
        const message = formatErrorMessage(
          'Create port forward',
          e.message,
          recovery
        );
        const action = retrySafe
          ? await vscode.window.showErrorMessage(message, 'Retry')
          : await vscode.window.showErrorMessage(message);
        infoLog('port-forward', 'create-retry-decision', {
          connectionId: connection.id,
          offered: retrySafe,
          selected: action === 'Retry',
        });
        if (retrySafe && action === 'Retry') {
          await this.promptForwardPort();
        }
      } else {
        vscode.window.showErrorMessage(`Failed to create port forward: ${e.message}`);
      }
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

    infoLog('port-forward', 'stop/begin', {
      connectionId: forward.connectionId,
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
    });
    try {
      await connection.stopForward(forward.localPort);

      // Remove active forward from tree (saved rule remains visible as dimmed)
      if (this.treeProvider) {
        this.treeProvider.removeForward(forward.localPort, forward.connectionId);
      }

      infoLog('port-forward', 'stop/success', { connectionId: forward.connectionId, localPort: forward.localPort });
      vscode.window.setStatusBarMessage(`$(check) Port forward stopped: localhost:${forward.localPort}`, 3000);
    } catch (error) {
      const e = error as Error;
      infoLog('port-forward', 'stop/failed', { connectionId: forward.connectionId, localPort: forward.localPort, errorName: e.name, errorMessage: e.message });
      vscode.window.showErrorMessage(`Failed to stop port forward: ${e.message}`);
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

    if (connection && hasCapability(connection, 'supportsPortForward')) {
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
    // Fires on every Connected event (incl. FTP). FTP cannot forward ports and
    // never has saved rules, but guard so a reused host:port:user id can't crash.
    if (!hasCapability(connection, 'supportsPortForward')) {
      return;
    }
    const rules = this.getSavedRules(connection.id);
    if (rules.length === 0) {
      return;
    }

    const t0 = Date.now();
    let restored = 0;
    let failed = 0;
    const failures: Array<{ ruleId: string; localPort: number; errorMessage: string }> = [];
    infoLog('port-forward', 'restore/begin', {
      connectionId: connection.id,
      hostName: connection.host.name,
      ruleCount: rules.length,
    });

    for (const rule of rules) {
      try {
        await connection.forwardPort(rule.localPort, rule.remoteHost, rule.remotePort);
        this.clearRestoreFailure(connection.id, rule.id);

        if (this.treeProvider) {
          this.treeProvider.addForward(connection.id, rule.localPort, rule.remoteHost, rule.remotePort);
        }

        restored++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.setRestoreFailure(connection.id, rule.id, errorMessage);
        failures.push({ ruleId: rule.id, localPort: rule.localPort, errorMessage });
        failed++;
      }
    }

    if (failed > 0 && this.treeProvider) {
      this.treeProvider.refresh();
    }

    infoLog('port-forward', 'restore/complete', {
      connectionId: connection.id,
      restored,
      failed,
      durationMs: Date.now() - t0,
      failures,
    });

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

    if (!hasCapability(connection, 'supportsPortForward')) {
      vscode.window.showWarningMessage(
        'Port forwarding is unavailable for this connection. Connect using Secure Shell (SSH) to start this saved rule.'
      );
      return;
    }

    await this.forwardPort(connection, rule.localPort, rule.remoteHost, rule.remotePort);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.lifecycleGeneration++;
    const restoreFailureCount = Array.from(this.restoreFailures.values())
      .reduce((total, failures) => total + failures.size, 0);
    infoLog('port-forward', 'dispose', {
      restoreFailureCount,
      savedHostCount: Object.keys(this.savedRules).length,
    });
    this.restoreFailures.clear();
    this.savedRules = {};
    this.treeProvider = null;
    this.context = null;
  }
}
