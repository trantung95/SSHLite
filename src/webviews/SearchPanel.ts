import * as vscode from 'vscode';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { IHostConfig } from '../types';
import { SavedCredential } from '../services/CredentialService';
import { formatFileSize, formatRelativeTime } from '../utils/helpers';
import { ActivityService } from '../services/ActivityService';

/**
 * Search scope - a folder or file to search in
 */
export interface SearchScope {
  id: string; // connection.id + ":" + path
  path: string;
  connection: SSHConnection;
  displayName: string; // connection.host.name + ": " + path
  isFile?: boolean; // true if searching within a single file
}

/**
 * Search result from server
 */
export interface WebviewSearchResult {
  path: string;
  line?: number;
  match?: string;
  size?: number;
  modified?: number; // timestamp
  permissions?: string;
  connectionId: string;
  connectionName: string;
}

/**
 * A search path within a server (folder or file)
 */
export interface SearchPath {
  path: string;
  isFile?: boolean;          // true for single-file scopes (from magnifying glass on a file)
  redundantOf?: string;      // set when path is child of another path on same server (grayed out)
  overlapWarning?: string;   // set when path overlaps with another user on same host
}

/**
 * A server entry in the cross-server search list
 */
export interface ServerSearchEntry {
  id: string;                          // hostConfig.id (host:port:username)
  hostConfig: IHostConfig;
  credential: SavedCredential | null;  // null = no saved credentials
  connected: boolean;
  checked: boolean;                    // user selection
  disabled: boolean;                   // true when no credentials (grayed out)
  searchPaths: SearchPath[];           // multiple paths per server
  status?: 'connecting' | 'failed';    // transient state during search
  error?: string;                      // error message if connection failed
  maxSearchProcesses?: number;         // per-server worker count override (null = use global default)
}

/** Per-server search settings stored in globalState */
interface ServerSearchSettings {
  [hostId: string]: { maxSearchProcesses?: number };
}

/**
 * Message types for webview communication
 */
type WebviewMessage =
  | { type: 'search'; query: string; include: string; exclude: string; caseSensitive: boolean; regex: boolean; findFiles?: boolean }
  | { type: 'removeScope'; index: number }
  | { type: 'clearScopes' }
  | { type: 'openResult'; result: WebviewSearchResult; line?: number }
  | { type: 'revealInTree'; result: WebviewSearchResult }
  | { type: 'increaseLimit' }
  | { type: 'cancelSearch' }
  | { type: 'ready' }
  | { type: 'toggleServer'; serverId: string; checked: boolean }
  | { type: 'removeServerPath'; serverId: string; pathIndex: number }
  | { type: 'addServerPath'; serverId: string; path: string }
  | { type: 'toggleSort' }
  | { type: 'searchIncludeSystemDirs' }
  | { type: 'setServerMaxProcesses'; serverId: string; value: number | null };

/**
 * SearchPanel - VS Code native-style search webview
 */
export class SearchPanel {
  private static instance: SearchPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  // State
  private searchScopes: SearchScope[] = [];
  private isSearching: boolean = false;
  private lastSearchQuery: string = '';
  private lastIncludePattern: string = '';
  private lastExcludePattern: string = '';
  private lastCaseSensitive: boolean = false;
  private lastRegex: boolean = false;
  private searchAbortController: AbortController | null = null;
  private includeSystemDirsOverride: boolean = false;
  private currentSearchId: number = 0;
  private currentSearchActivityIds: string[] = [];

  // Shared search state for progressive results (promoted from local for include-all merging)
  private currentGlobalSeen: Set<string> = new Set();
  private currentCompletedCount: number = 0;
  private currentTotalCount: number = 0;

  // State for include-all system dirs in-progress (Change 6)
  private lastExcludedSystemDirs: string[] = [];
  private lastSearchConnectionMap: Map<string, SSHConnection> = new Map();

  // Dynamic worker pool tracking (allows mid-search worker count adjustment)
  private activeWorkerPools: Map<string, {
    desiredWorkerCount: number;
    activeWorkerCount: number;
    addWorker: () => void;
  }> = new Map();

  // Server list state (cross-server search model)
  private serverList: ServerSearchEntry[] = [];
  private findFilesMode: boolean = false;
  private sortOrder: 'checked' | 'name' = 'checked';
  private extensionContext?: vscode.ExtensionContext;

  // Callbacks
  private openFileCallback?: (connectionId: string, remotePath: string, line?: number, searchQuery?: string) => Promise<void>;
  private connectionResolver?: (connectionId: string) => SSHConnection | undefined;
  private autoConnectCallback?: (hostConfig: IHostConfig, credential: SavedCredential) => Promise<SSHConnection | undefined>;
  private autoDisconnectCallback?: (connectionId: string) => Promise<void>;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): SearchPanel {
    if (!SearchPanel.instance) {
      SearchPanel.instance = new SearchPanel();
    }
    return SearchPanel.instance;
  }

  /**
   * Set callback for opening files
   */
  public setOpenFileCallback(callback: (connectionId: string, remotePath: string, line?: number, searchQuery?: string) => Promise<void>): void {
    this.openFileCallback = callback;
  }

  /**
   * Set callback to resolve a connection ID to a fresh SSHConnection.
   * Used to avoid stale connection references after auto-reconnect.
   */
  public setConnectionResolver(resolver: (connectionId: string) => SSHConnection | undefined): void {
    this.connectionResolver = resolver;
  }

  /**
   * Set callback for auto-connecting disconnected servers during search.
   * Returns SSHConnection on success, undefined on failure.
   */
  public setAutoConnectCallback(callback: (hostConfig: IHostConfig, credential: SavedCredential) => Promise<SSHConnection | undefined>): void {
    this.autoConnectCallback = callback;
  }

  /**
   * Set callback for auto-disconnecting servers that were connected during search but had no results.
   */
  public setAutoDisconnectCallback(callback: (connectionId: string) => Promise<void>): void {
    this.autoDisconnectCallback = callback;
  }

  /**
   * Set the server list for cross-server search.
   * Called by extension.ts to populate all available hosts.
   */
  public setServerList(entries: ServerSearchEntry[]): void {
    // Preserve existing searchPaths and checked state from old list
    const oldMap = new Map(this.serverList.map((s) => [s.id, s]));
    for (const entry of entries) {
      const old = oldMap.get(entry.id);
      if (old && (old.searchPaths.length > 0 || old.checked)) {
        entry.searchPaths = old.searchPaths;
        entry.checked = old.checked;
      }
      // Preserve per-server process override from old list
      if (old?.maxSearchProcesses !== undefined) {
        entry.maxSearchProcesses = old.maxSearchProcesses;
      }
    }

    // Apply persisted per-server search settings
    const savedSettings = this.loadServerSearchSettings();
    for (const entry of entries) {
      if (entry.maxSearchProcesses === undefined && savedSettings[entry.id]?.maxSearchProcesses) {
        entry.maxSearchProcesses = savedSettings[entry.id].maxSearchProcesses;
      }
    }

    this.serverList = entries;
    this.detectRedundancy();
    this.sendState();
  }

  /**
   * Update a server's connection state (called when connections change externally).
   */
  public updateServerConnection(connectionId: string, connected: boolean): void {
    const server = this.serverList.find((s) => s.id === connectionId);
    if (server) {
      server.connected = connected;
      if (connected) {
        server.status = undefined;
        server.error = undefined;
      }
      this.sendState();
    }
  }

  /**
   * Set sort order for server list and persist to globalState.
   */
  public setSortOrder(order: 'checked' | 'name', context?: vscode.ExtensionContext): void {
    this.sortOrder = order;
    if (context) {
      context.globalState.update('sshLite.searchSortOrder', order);
    }
    this.sendState();
  }

  /**
   * Load sort order from globalState.
   */
  public loadSortOrder(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
    this.sortOrder = context.globalState.get<'checked' | 'name'>('sshLite.searchSortOrder', 'checked');
  }

  /**
   * Load per-server search settings from globalState
   */
  private loadServerSearchSettings(): ServerSearchSettings {
    return this.extensionContext?.globalState.get<ServerSearchSettings>('sshLite.serverSearchSettings', {}) || {};
  }

  /**
   * Save per-server search settings to globalState
   */
  private async saveServerSearchSettings(settings: ServerSearchSettings): Promise<void> {
    await this.extensionContext?.globalState.update('sshLite.serverSearchSettings', settings);
  }

  /**
   * Show the search panel
   */
  public show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'sshLiteSearch',
      'Search',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('search');
    this.panel.webview.html = this.getWebviewContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
      },
      undefined,
      this.disposables
    );

    // Send initial state when webview is ready
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === 'ready') {
          this.sendState();
        }
      },
      undefined,
      this.disposables
    );
  }

  /**
   * Add a search scope (folder or file).
   * Routes to the correct server's searchPaths in the serverList model.
   * Also maintains legacy searchScopes for backward compat during migration.
   */
  public addScope(scopePath: string, connection: SSHConnection, isFile?: boolean): void {
    // Legacy searchScopes (kept during migration)
    const id = `${connection.id}:${scopePath}`;
    if (!this.searchScopes.some((s) => s.id === id)) {
      this.searchScopes.push({
        id,
        path: scopePath,
        connection,
        displayName: `${connection.host.name}: ${scopePath}`,
        isFile: isFile || false,
      });
    }

    // New serverList model: route path to correct server entry
    const server = this.serverList.find((s) => s.id === connection.id);
    if (server) {
      // If server was checked with no paths (implicit root /), make it explicit
      if (server.checked && server.searchPaths.length === 0 && scopePath !== '/') {
        server.searchPaths.push({ path: '/' });
      }
      // Check for duplicate path
      if (!server.searchPaths.some((p) => p.path === scopePath)) {
        server.searchPaths.push({ path: scopePath, isFile: isFile || false });
      }
      // Auto-check the server (additive — does NOT uncheck other servers)
      server.checked = true;
      this.detectRedundancy();
    }

    this.sendState();
  }

  /**
   * Remove a search scope by index
   */
  public removeScope(index: number): void {
    if (index >= 0 && index < this.searchScopes.length) {
      this.searchScopes.splice(index, 1);
      this.sendState();
    }
  }

  /**
   * Remove a specific path from a server's searchPaths.
   * If all paths are removed, the server is unchecked.
   */
  public removeServerPath(serverId: string, pathIndex: number): void {
    const server = this.serverList.find((s) => s.id === serverId);
    if (server && pathIndex >= 0 && pathIndex < server.searchPaths.length) {
      server.searchPaths.splice(pathIndex, 1);
      // Uncheck server if no paths remain
      if (server.searchPaths.length === 0) {
        server.checked = false;
      }
      this.detectRedundancy();
      this.sendState();
    }
  }

  /**
   * Toggle a server's checked state from webview
   */
  public toggleServer(serverId: string, checked: boolean): void {
    const server = this.serverList.find((s) => s.id === serverId);
    if (server && !server.disabled) {
      server.checked = checked;
      this.detectRedundancy();
      this.sendState();
    }
  }

  /**
   * Clear all scopes
   */
  public clearScopes(): void {
    this.searchScopes = [];
    // Also clear all server paths and uncheck all
    for (const server of this.serverList) {
      server.searchPaths = [];
      server.checked = false;
    }
    this.sendState();
  }

  /**
   * Cancel ongoing search
   */
  public cancelSearch(): void {
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }
    this.activeWorkerPools.clear();
    // Cancel all tracked search activities
    const activityService = ActivityService.getInstance();
    for (const id of this.currentSearchActivityIds) {
      activityService.cancelActivity(id);
    }
    this.currentSearchActivityIds = [];

    if (this.isSearching) {
      this.isSearching = false;
      this.sendState();
      this.postMessage({ type: 'searchCancelled' });
      vscode.window.setStatusBarMessage('$(x) Search cancelled', 2000);
    }
  }

  /**
   * Check if search is in progress
   */
  public isSearchInProgress(): boolean {
    return this.isSearching;
  }

  /**
   * Check if any scopes exist (checks both legacy scopes and serverList)
   */
  public hasScopes(): boolean {
    return this.searchScopes.length > 0 || this.serverList.some((s) => s.checked && !s.disabled);
  }

  /**
   * Focus search input in webview
   */
  public focusSearchInput(): void {
    this.postMessage({ type: 'focusInput' });
  }

  /**
   * Get the sorted server list based on current sort order
   */
  private getSortedServerList(): ServerSearchEntry[] {
    const list = [...this.serverList];
    if (this.sortOrder === 'checked') {
      // Checked first, then alphabetical
      list.sort((a, b) => {
        const aChecked = a.checked ? 0 : 1;
        const bChecked = b.checked ? 0 : 1;
        if (aChecked !== bChecked) return aChecked - bChecked;
        return a.hostConfig.name.localeCompare(b.hostConfig.name);
      });
    } else {
      // Alphabetical by display name
      list.sort((a, b) => a.hostConfig.name.localeCompare(b.hostConfig.name));
    }
    return list;
  }

  /**
   * Send current state to webview
   */
  private sendState(): void {
    this.postMessage({
      type: 'state',
      // Legacy scopes format (kept during migration)
      scopes: this.searchScopes.map((s) => ({
        id: s.id,
        path: s.path,
        displayName: s.displayName,
        connectionId: s.connection.id,
        isFile: s.isFile || false,
      })),
      // New server list format
      serverList: this.getSortedServerList().map((s) => ({
        id: s.id,
        name: s.hostConfig.name,
        host: s.hostConfig.host,
        port: s.hostConfig.port,
        username: s.hostConfig.username,
        connected: s.connected,
        checked: s.checked,
        disabled: s.disabled,
        searchPaths: s.searchPaths,
        status: s.status,
        error: s.error,
        hasCredential: s.credential !== null,
        maxSearchProcesses: s.maxSearchProcesses,
      })),
      isSearching: this.isSearching,
      findFilesMode: this.findFilesMode,
      sortOrder: this.sortOrder,
      globalMaxSearchProcesses: vscode.workspace.getConfiguration('sshLite').get<number>('searchParallelProcesses', 20),
    });
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'search':
        await this.performSearch(message.query, message.include, message.exclude, message.caseSensitive, message.regex, message.findFiles);
        break;

      case 'removeScope':
        this.removeScope(message.index);
        break;

      case 'clearScopes':
        this.clearScopes();
        break;

      case 'openResult':
        if (this.openFileCallback) {
          await this.openFileCallback(message.result.connectionId, message.result.path, message.line, this.lastSearchQuery);
        }
        break;

      case 'revealInTree':
        // Trigger the reveal command with the result
        vscode.commands.executeCommand('sshLite.revealSearchResultInTree', {
          path: message.result.path,
          connectionId: message.result.connectionId,
        });
        break;

      case 'increaseLimit':
        await this.increaseSearchLimit();
        break;

      case 'cancelSearch':
        this.cancelSearch();
        break;

      case 'ready':
        this.sendState();
        break;

      case 'toggleServer':
        this.toggleServer(message.serverId, message.checked);
        break;

      case 'removeServerPath':
        this.removeServerPath(message.serverId, message.pathIndex);
        break;

      case 'addServerPath': {
        const server = this.serverList.find((s) => s.id === message.serverId);
        if (server) {
          // If server was checked with no paths (implicit root /), make it explicit
          if (server.checked && server.searchPaths.length === 0 && message.path !== '/') {
            server.searchPaths.push({ path: '/' });
          }
          if (!server.searchPaths.some((p) => p.path === message.path)) {
            server.searchPaths.push({ path: message.path });
          }
          server.checked = true;
          this.detectRedundancy();
          this.sendState();
        }
        break;
      }

      case 'toggleSort':
        this.sortOrder = this.sortOrder === 'checked' ? 'name' : 'checked';
        if (this.extensionContext) {
          this.extensionContext.globalState.update('sshLite.searchSortOrder', this.sortOrder);
        }
        this.sendState();
        break;

      case 'searchIncludeSystemDirs':
        // Search only the excluded system dirs and merge results into the current search
        await this.searchExcludedSystemDirs();
        break;

      case 'setServerMaxProcesses': {
        const targetServer = this.serverList.find((s) => s.id === message.serverId);
        if (targetServer) {
          if (message.value === null) {
            // Clear override — use global default
            targetServer.maxSearchProcesses = undefined;
          } else {
            // Clamp to min 5, max 50
            targetServer.maxSearchProcesses = Math.max(5, Math.min(50, message.value));
          }
          // Persist to globalState
          const settings = this.loadServerSearchSettings();
          if (message.value === null) {
            delete settings[message.serverId];
          } else {
            settings[message.serverId] = { maxSearchProcesses: targetServer.maxSearchProcesses };
          }
          this.saveServerSearchSettings(settings);
          this.sendState();

          // Adjust active worker pools for this server (dynamic mid-search)
          const newCount = targetServer.maxSearchProcesses
            ?? vscode.workspace.getConfiguration('sshLite').get<number>('searchParallelProcesses', 20);
          const clampedCount = Math.max(1, newCount);
          for (const [poolKey, pool] of this.activeWorkerPools) {
            if (poolKey.startsWith(message.serverId + ':')) {
              pool.desiredWorkerCount = clampedCount;
              if (clampedCount > pool.activeWorkerCount) {
                for (let i = 0; i < clampedCount - pool.activeWorkerCount; i++) {
                  pool.addWorker();
                }
              }
              // If decreasing, workers self-terminate via the guard check
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Increase search limit setting
   */
  private async increaseSearchLimit(): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const currentLimit = config.get<number>('searchMaxResults', 2000);

    const newLimit = await vscode.window.showInputBox({
      prompt: `Enter new search result limit (current: ${currentLimit})`,
      value: String(currentLimit * 2),
      validateInput: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1) {
          return 'Please enter a positive number';
        }
        return null;
      },
    });

    if (newLimit) {
      const limit = parseInt(newLimit, 10);
      await config.update('searchMaxResults', limit, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Search limit increased to ${limit}. Re-run your search to see more results.`);
    }
  }

  /**
   * Perform search across all scopes (supports both legacy and serverList models).
   * For serverList: auto-connects disconnected servers, supports findFiles mode,
   * auto-disconnects no-result servers.
   */
  private async performSearch(
    query: string,
    includePattern: string,
    excludePattern: string,
    caseSensitive: boolean,
    regex: boolean,
    findFiles?: boolean
  ): Promise<void> {
    // Determine which model to use: serverList (new) or searchScopes (legacy)
    // Checked servers without explicit paths default to searching from /
    const checkedServers = this.serverList.filter((s) => s.checked && !s.disabled);
    const useServerList = checkedServers.length > 0;

    if (!query.trim() || (!useServerList && this.searchScopes.length === 0)) {
      this.postMessage({ type: 'results', results: [], query: '' });
      return;
    }

    // Cancel any existing search
    if (this.searchAbortController) {
      this.searchAbortController.abort();
    }
    this.searchAbortController = new AbortController();
    const abortController = this.searchAbortController;
    const signal = abortController.signal;

    const searchId = ++this.currentSearchId;
    this.currentSearchActivityIds = [];

    this.isSearching = true;
    this.lastSearchQuery = query;
    this.lastIncludePattern = includePattern;
    this.lastExcludePattern = excludePattern;
    this.lastCaseSensitive = caseSensitive;
    this.lastRegex = regex;
    this.findFilesMode = !!findFiles;

    // Build scope servers list for multi-server grouping (available before connections resolve)
    const scopeServers = checkedServers.map((s) => ({
      id: s.id,
      name: `${s.hostConfig.name} (${s.hostConfig.username})`,
    }));

    this.postMessage({ type: 'searching', query, scopeServers, searchId });

    const config = vscode.workspace.getConfiguration('sshLite');
    const maxResults = config.get<number>('searchMaxResults', 2000);
    const connectionTimeout = config.get<number>('connectionTimeout', 30000);

    const activityService = ActivityService.getInstance();
    const autoConnectedIds = new Set<string>();
    const serverResults = new Map<string, number>(); // connectionId -> result count

    try {
      if (useServerList) {
        // === New serverList-based search ===
        console.log(`[SSH Lite Search] Starting ${findFiles ? 'findFiles' : 'content'} search for "${query}" across ${checkedServers.length} server(s)`);

        const failedScopes: string[] = [];

        // Phase 1: Resolve connections (auto-connect if needed) using Promise.allSettled
        const connectionMap = new Map<string, SSHConnection>();
        const connectPromises = checkedServers.map(async (server) => {
          if (signal.aborted) return;

          // Try to resolve existing connection
          let connection = this.connectionResolver?.(server.id);

          if (connection) {
            connectionMap.set(server.id, connection);
            return;
          }

          // Auto-connect if disconnected and has credentials
          if (!server.connected && server.credential && this.autoConnectCallback) {
            server.status = 'connecting';
            this.sendState();

            try {
              connection = await this.autoConnectCallback(server.hostConfig, server.credential);
              if (signal.aborted) return; // cancelled during connect

              if (connection) {
                connectionMap.set(server.id, connection);
                autoConnectedIds.add(server.id);
                server.connected = true;
                server.status = undefined;
                server.error = undefined;
              } else {
                server.status = 'failed';
                server.error = 'Connection returned undefined';
                failedScopes.push(`${server.hostConfig.name} (${server.hostConfig.username}): Connection failed`);
              }
            } catch (error) {
              if (signal.aborted) return;
              server.status = 'failed';
              server.error = (error as Error).message;
              failedScopes.push(`${server.hostConfig.name} (${server.hostConfig.username}): ${(error as Error).message}`);
            }
            this.sendState();
          } else if (!server.connected) {
            server.status = 'failed';
            server.error = 'No credentials available';
            failedScopes.push(`${server.hostConfig.name} (${server.hostConfig.username}): No credentials`);
            this.sendState();
          }
        });

        await Promise.allSettled(connectPromises);
        if (signal.aborted) return;

        // Phase 2: Search each server's non-redundant paths in parallel with progressive results
        // Use instance variables so include-all can merge into ongoing search
        this.currentGlobalSeen = new Set<string>();
        this.currentCompletedCount = 0;
        this.currentTotalCount = 0;
        const globalSeen = this.currentGlobalSeen; // alias for readability
        // Store connection map for include-all system dirs
        this.lastSearchConnectionMap = connectionMap;
        this.lastExcludedSystemDirs = [];

        const globalParallelProcesses = config.get<number>('searchParallelProcesses', 20);
        const excludeSystemDirs = config.get<boolean>('searchExcludeSystemDirs', true);
        const SYSTEM_DIRS = ['/proc', '/sys', '/dev', '/run', '/snap', '/lost+found'];
        let systemDirsExcluded: string[] = []; // track for webview notification

        // Build search tasks with metadata
        interface SearchTask {
          serverId: string;
          displayName: string;
          activityId: string;
          promise: Promise<WebviewSearchResult[]>;
        }
        const searchTasks: SearchTask[] = [];
        const workerPoolPromises: Promise<void>[] = [];

        // Helper to create a search task
        const createSearchTask = (
          server: ServerSearchEntry,
          connection: SSHConnection,
          searchPathArg: string | string[],
          label: string,
        ): SearchTask => {
          const displayName = `${server.hostConfig.name} (${server.hostConfig.username}): ${label}`;
          const activityId = activityService.startActivity(
            'search',
            connection.id,
            connection.host.name,
            `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
            {
              detail: `in ${label}`,
              cancellable: true,
              onCancel: () => { abortController.abort(); },
            }
          );
          this.currentSearchActivityIds.push(activityId);

          const searchPromise = (async (): Promise<WebviewSearchResult[]> => {
            if (signal.aborted) return [];
            try {
              const results = await connection.searchFiles(searchPathArg, query, {
                searchContent: !findFiles,
                caseSensitive,
                regex,
                filePattern: includePattern || '*',
                excludePattern: excludePattern || undefined,
                maxResults,
                signal,
              });

              if (signal.aborted) {
                activityService.cancelActivity(activityId);
                return [];
              }

              const mapped = results.map((r) => ({
                ...r,
                modified: r.modified ? r.modified.getTime() : undefined,
                connectionId: connection.id,
                connectionName: connection.host.name,
              }));

              console.log(`[SSH Lite Search] "${displayName}" returned ${mapped.length} results`);
              activityService.completeActivity(activityId, `${mapped.length} results`);

              serverResults.set(server.id, (serverResults.get(server.id) || 0) + mapped.length);
              return mapped;
            } catch (error) {
              console.log(`[SSH Lite Search] "${displayName}" FAILED: ${(error as Error).message}`);
              activityService.failActivity(activityId, (error as Error).message);
              failedScopes.push(`${displayName}: ${(error as Error).message}`);
              return [];
            }
          })();

          return { serverId: server.id, displayName, activityId, promise: searchPromise };
        };

        for (const server of checkedServers) {
          const connection = connectionMap.get(server.id);
          if (!connection) continue; // failed to connect

          // Filter out redundant child paths (already covered by parent)
          // Default to / if no paths specified (user checked server without adding paths)
          const activePaths = server.searchPaths.length > 0
            ? server.searchPaths.filter((sp) => !sp.redundantOf)
            : [{ path: '/' }];

          // Per-server worker count (override or global default)
          const parallelProcesses = server.maxSearchProcesses ?? globalParallelProcesses;

          for (const sp of activePaths) {
            if (signal.aborted) break;

            // File-level worker pool: list entries per directory level, batch files to workers
            if (parallelProcesses > 1 && !sp.isFile) {
              // 32KB batch limit — safe across all server OS variants (Linux, macOS, FreeBSD, Solaris, AIX)
              const MAX_BATCH_BYTES = 32_000;
              // Only pass simple glob patterns to listEntries (find -name doesn't support brace expansion)
              const listEntriesPattern = (includePattern && !/[{,]/.test(includePattern))
                ? includePattern : undefined;

              const poolPromise = (async () => {
                const workQueue: Array<{ type: 'dir'; path: string } | { type: 'files'; filePaths: string[] }> = [];
                let workIndex = 0;

                // Seed work queue: filter system dirs at root, otherwise start with the search path
                if (excludeSystemDirs && !this.includeSystemDirsOverride && sp.path === '/') {
                  try {
                    const subdirs = await connection.listDirectories(sp.path);
                    if (signal.aborted) return;
                    const excluded = subdirs.filter((d) => SYSTEM_DIRS.includes(d));
                    const searchableDirs = subdirs.filter((d) => !SYSTEM_DIRS.includes(d));
                    if (excluded.length > 0) {
                      systemDirsExcluded = excluded;
                      this.lastExcludedSystemDirs = excluded;
                      this.postMessage({ type: 'systemDirsExcluded', dirs: excluded });
                    }
                    for (const dir of searchableDirs) {
                      workQueue.push({ type: 'dir', path: dir });
                    }
                  } catch {
                    workQueue.push({ type: 'dir', path: sp.path });
                  }
                } else {
                  workQueue.push({ type: 'dir', path: sp.path });
                }

                this.currentTotalCount += workQueue.length;
                console.log(`[SSH Lite Search] Worker pool for ${sp.path}: ${workQueue.length} initial items, ${parallelProcesses} workers`);

                // Dynamic worker tracking
                let desiredWorkerCount = Math.min(parallelProcesses, Math.max(workQueue.length, 2));
                let activeWorkerCount = 0;
                const allWorkerPromises: Promise<void>[] = [];
                const poolKey = `${server.id}:${sp.path}`;

                const runWorker = async (): Promise<void> => {
                  activeWorkerCount++;
                  try {
                  while (!signal.aborted && globalSeen.size < maxResults) {
                    // Graceful shrink: if more workers than desired, exit (keep at least 1)
                    if (activeWorkerCount > desiredWorkerCount && activeWorkerCount > 1) return;
                    if (workIndex >= workQueue.length) return; // queue exhausted
                    const item = workQueue[workIndex++];

                    if (item.type === 'dir') {
                      // LIST: discover files + subdirs at this level
                      try {
                        const entries = await connection.listEntries(item.path, listEntriesPattern);
                        if (signal.aborted) return;

                        // Batch files by byte size for cross-OS safety
                        const batches: string[][] = [];
                        let currentBatch: string[] = [];
                        let currentBytes = 0;
                        for (const file of entries.files) {
                          const fileBytes = file.length + 3; // +3 for quoting and space
                          if (currentBytes + fileBytes > MAX_BATCH_BYTES && currentBatch.length > 0) {
                            batches.push(currentBatch);
                            currentBatch = [];
                            currentBytes = 0;
                          }
                          currentBatch.push(file);
                          currentBytes += fileBytes;
                        }
                        if (currentBatch.length > 0) batches.push(currentBatch);

                        // Push file batches and subdirs to work queue
                        for (const batch of batches) {
                          workQueue.push({ type: 'files', filePaths: batch });
                        }
                        for (const dir of entries.dirs) {
                          workQueue.push({ type: 'dir', path: dir });
                        }

                        // Update totalCount: add new items (file batches + subdirs) discovered by this dir
                        const newItems = batches.length + entries.dirs.length;
                        this.currentTotalCount += newItems;

                        // Dir listing done — send progress-only batch
                        this.currentCompletedCount++;
                        if (searchId !== this.currentSearchId) return;
                        this.postMessage({
                          type: 'searchBatch', searchId, results: [],
                          totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                          hitLimit: false, limit: maxResults,
                          done: this.currentCompletedCount === this.currentTotalCount,
                        });
                      } catch {
                        // listEntries failed — fallback to recursive grep on this dir
                        const actId = activityService.startActivity(
                          'search', connection.id, connection.host.name,
                          `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
                          { detail: `in ${item.path} (fallback)`, cancellable: true, onCancel: () => { abortController.abort(); } }
                        );
                        this.currentSearchActivityIds.push(actId);
                        try {
                          const results = await connection.searchFiles(item.path, query, {
                            searchContent: !findFiles, caseSensitive, regex,
                            filePattern: includePattern || '*',
                            excludePattern: excludePattern || undefined,
                            maxResults, signal,
                          });
                          if (signal.aborted) { activityService.cancelActivity(actId); return; }
                          const mapped = results.map((r) => ({
                            ...r, modified: r.modified ? r.modified.getTime() : undefined,
                            connectionId: connection.id, connectionName: connection.host.name,
                          }));
                          activityService.completeActivity(actId, `${mapped.length} results`);
                          serverResults.set(server.id, (serverResults.get(server.id) || 0) + mapped.length);
                          const unique = mapped.filter((r) => {
                            const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
                            if (globalSeen.has(key)) return false;
                            globalSeen.add(key);
                            return true;
                          });
                          this.currentCompletedCount++;
                          if (searchId !== this.currentSearchId) return;
                          this.postMessage({
                            type: 'searchBatch', searchId, results: unique,
                            totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                            hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                            done: this.currentCompletedCount === this.currentTotalCount,
                          });
                        } catch (error) {
                          activityService.failActivity(actId, (error as Error).message);
                          failedScopes.push(`${server.hostConfig.name}: ${(error as Error).message}`);
                          this.currentCompletedCount++;
                          if (searchId !== this.currentSearchId) return;
                          this.postMessage({
                            type: 'searchBatch', searchId, results: [],
                            totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                            hitLimit: false, limit: maxResults,
                            done: this.currentCompletedCount === this.currentTotalCount,
                          });
                        }
                      }
                    } else if (item.type === 'files') {
                      // SEARCH: grep this batch of files
                      const actId = activityService.startActivity(
                        'search', connection.id, connection.host.name,
                        `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
                        { detail: `${item.filePaths.length} files`, cancellable: true,
                          onCancel: () => { abortController.abort(); } }
                      );
                      this.currentSearchActivityIds.push(actId);
                      try {
                        const results = await connection.searchFiles(item.filePaths, query, {
                          searchContent: !findFiles, caseSensitive, regex,
                          filePattern: includePattern || '*',
                          excludePattern: excludePattern || undefined,
                          maxResults, signal,
                        });
                        if (signal.aborted) { activityService.cancelActivity(actId); return; }
                        const mapped = results.map((r) => ({
                          ...r, modified: r.modified ? r.modified.getTime() : undefined,
                          connectionId: connection.id, connectionName: connection.host.name,
                        }));
                        activityService.completeActivity(actId, `${mapped.length} results`);
                        serverResults.set(server.id, (serverResults.get(server.id) || 0) + mapped.length);
                        const unique = mapped.filter((r) => {
                          const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
                          if (globalSeen.has(key)) return false;
                          globalSeen.add(key);
                          return true;
                        });
                        this.currentCompletedCount++;
                        if (searchId !== this.currentSearchId) return;
                        this.postMessage({
                          type: 'searchBatch', searchId, results: unique,
                          totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                          hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                          done: this.currentCompletedCount === this.currentTotalCount,
                        });
                      } catch (error) {
                        activityService.failActivity(actId, (error as Error).message);
                        failedScopes.push(`${server.hostConfig.name}: ${(error as Error).message}`);
                        this.currentCompletedCount++;
                        if (searchId !== this.currentSearchId) return;
                        this.postMessage({
                          type: 'searchBatch', searchId, results: [],
                          totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                          hitLimit: false, limit: maxResults,
                          done: this.currentCompletedCount === this.currentTotalCount,
                        });
                      }
                    }
                  }
                  } finally {
                    activeWorkerCount--;
                  }
                };

                // Register pool controller for dynamic worker adjustment
                const addWorker = () => {
                  const p = runWorker();
                  allWorkerPromises.push(p);
                };
                this.activeWorkerPools.set(poolKey, {
                  get desiredWorkerCount() { return desiredWorkerCount; },
                  set desiredWorkerCount(v: number) { desiredWorkerCount = v; },
                  get activeWorkerCount() { return activeWorkerCount; },
                  addWorker,
                });

                // Spawn initial workers
                for (let wi = 0; wi < desiredWorkerCount; wi++) {
                  allWorkerPromises.push(runWorker());
                }
                // Await all workers (including dynamically added ones)
                while (true) {
                  const len = allWorkerPromises.length;
                  await Promise.all(allWorkerPromises);
                  if (allWorkerPromises.length === len) break;
                }
                this.activeWorkerPools.delete(poolKey);
              })();

              workerPoolPromises.push(poolPromise);
              continue; // skip single-path fallthrough
            }

            // Single search (no parallel split or fallback)
            searchTasks.push(createSearchTask(server, connection, sp.path, sp.path));
          }
        }

        this.currentTotalCount += searchTasks.length;

        // Notify webview about excluded system directories
        if (systemDirsExcluded.length > 0) {
          this.postMessage({
            type: 'systemDirsExcluded',
            dirs: systemDirsExcluded,
          });
        }

        // Wrap each task with .then() that sends progressive searchBatch messages
        const wrappedPromises = searchTasks.map((task) =>
          task.promise.then((batchResults) => {
            if (signal.aborted || searchId !== this.currentSearchId) return [];
            // Deduplicate against global set
            const unique = batchResults.filter((r) => {
              const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
              if (globalSeen.has(key)) return false;
              globalSeen.add(key);
              return true;
            });
            this.currentCompletedCount++;
            this.postMessage({
              type: 'searchBatch',
              searchId,
              results: unique,
              totalResults: globalSeen.size,
              completedCount: this.currentCompletedCount,
              totalCount: this.currentTotalCount,
              hitLimit: globalSeen.size >= maxResults,
              limit: maxResults,
              done: this.currentCompletedCount === this.currentTotalCount,
            });
            return unique;
          }).catch(() => {
            if (signal.aborted || searchId !== this.currentSearchId) return [] as WebviewSearchResult[];
            this.currentCompletedCount++;
            this.postMessage({
              type: 'searchBatch',
              searchId,
              results: [],
              totalResults: globalSeen.size,
              completedCount: this.currentCompletedCount,
              totalCount: this.currentTotalCount,
              hitLimit: false,
              limit: maxResults,
              done: this.currentCompletedCount === this.currentTotalCount,
            });
            return [] as WebviewSearchResult[];
          })
        );

        await Promise.all([...wrappedPromises, ...workerPoolPromises]);

        console.log(`[SSH Lite Search] All servers complete. Total results: ${globalSeen.size}, Failed: ${failedScopes.length}`);

        if (failedScopes.length > 0) {
          vscode.window.showWarningMessage(
            `Search failed for ${failedScopes.length} scope(s): ${failedScopes.join('; ')}`
          );
        }
      } else {
        // === Legacy searchScopes-based search ===
        console.log(`[SSH Lite Search] Starting legacy search for "${query}" across ${this.searchScopes.length} scope(s)`);

        const uniqueScopes = new Map<string, SearchScope>();
        for (const scope of this.searchScopes) {
          if (!uniqueScopes.has(scope.id)) {
            uniqueScopes.set(scope.id, scope);
          }
        }

        const failedScopes: string[] = [];
        const searchPromises = Array.from(uniqueScopes.values()).map(async (scope) => {
          if (signal.aborted) return [];

          const connection = this.connectionResolver
            ? (this.connectionResolver(scope.connection.id) || scope.connection)
            : scope.connection;

          const activityId = activityService.startActivity(
            'search',
            connection.id,
            connection.host.name,
            `Search: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
            {
              detail: `in ${scope.path}`,
              cancellable: true,
              onCancel: () => { abortController.abort(); },
            }
          );
          this.currentSearchActivityIds.push(activityId);

          try {
            const results = await connection.searchFiles(scope.path, query, {
              searchContent: !findFiles,
              caseSensitive,
              regex,
              filePattern: includePattern || '*',
              excludePattern: excludePattern || undefined,
              maxResults,
              signal,
            });

            if (signal.aborted) {
              activityService.cancelActivity(activityId);
              return [];
            }

            const mappedResults = results.map((r) => ({
              ...r,
              modified: r.modified ? r.modified.getTime() : undefined,
              connectionId: connection.id,
              connectionName: connection.host.name,
            }));

            console.log(`[SSH Lite Search] Scope "${scope.displayName}" returned ${mappedResults.length} results`);
            activityService.completeActivity(activityId, `${mappedResults.length} results`);
            return mappedResults;
          } catch (error) {
            console.log(`[SSH Lite Search] Scope "${scope.displayName}" FAILED: ${(error as Error).message}`);
            activityService.failActivity(activityId, (error as Error).message);
            failedScopes.push(`${scope.displayName}: ${(error as Error).message}`);
            return [];
          }
        });

        const allResults = (await Promise.all(searchPromises)).flat();
        console.log(`[SSH Lite Search] All scopes complete. Total results: ${allResults.length}, Failed: ${failedScopes.length}`);

        if (signal.aborted) return;

        const seen = new Set<string>();
        const uniqueResults = allResults.filter((r) => {
          const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const hitLimit = uniqueResults.length >= maxResults;

        const scopeServerMap = new Map<string, string>();
        for (const scope of this.searchScopes) {
          scopeServerMap.set(scope.connection.id, scope.connection.host.name);
        }
        const scopeServers = Array.from(scopeServerMap.entries()).map(([id, name]) => ({ id, name }));

        this.postMessage({ type: 'results', results: uniqueResults, query, hitLimit, limit: maxResults, scopeServers, searchId });

        if (failedScopes.length > 0) {
          vscode.window.showWarningMessage(
            `Search failed for ${failedScopes.length} scope(s): ${failedScopes.join('; ')}`
          );
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.postMessage({ type: 'error', message: (error as Error).message });
      }
      for (const id of this.currentSearchActivityIds) {
        activityService.failActivity(id, 'Search error');
      }
    } finally {
      // Clean up auto-connected servers with no results
      for (const connId of autoConnectedIds) {
        const hadResults = (serverResults.get(connId) || 0) > 0;
        if (!hadResults) {
          try {
            console.log(`[SSH Lite Search] Auto-disconnect (no results): ${connId}`);
            await this.autoDisconnectCallback?.(connId);
            // Update server state
            const server = this.serverList.find((s) => s.id === connId);
            if (server) {
              server.connected = false;
              server.status = undefined;
            }
          } catch (e) {
            console.log(`[SSH Lite Search] Failed to auto-disconnect ${connId}: ${e}`);
          }
        }
      }

      this.activeWorkerPools.clear();
      if (searchId === this.currentSearchId) {
        this.isSearching = false;
        this.sendState();
      }
    }
  }

  /**
   * Search only the previously-excluded system dirs and merge results into the current/last search.
   * Uses the same parallel worker pool pattern as performSearch() for consistent concurrency.
   */
  private async searchExcludedSystemDirs(): Promise<void> {
    if (this.lastExcludedSystemDirs.length === 0) return;

    const dirsToSearch = [...this.lastExcludedSystemDirs];
    this.lastExcludedSystemDirs = [];
    this.includeSystemDirsOverride = true;

    const searchId = this.currentSearchId; // Use SAME searchId as ongoing/last search
    const globalSeen = this.currentGlobalSeen;

    const config = vscode.workspace.getConfiguration('sshLite');
    const maxResults = config.get<number>('searchMaxResults', 2000);
    const globalParallelProcesses = config.get<number>('searchParallelProcesses', 20);
    const includePattern = this.lastIncludePattern || '';
    const excludePattern = this.lastExcludePattern || '';
    const query = this.lastSearchQuery;
    const caseSensitive = this.lastCaseSensitive;
    const regex = this.lastRegex;
    const findFiles = this.findFilesMode;

    if (!query) return;

    const signal = this.searchAbortController?.signal;
    const abortController = this.searchAbortController;
    const activityService = ActivityService.getInstance();

    // Resume searching state if search had already completed
    const wasSearching = this.isSearching;
    if (!wasSearching) {
      this.isSearching = true;
      this.sendState();
    }

    // Only pass simple glob patterns to listEntries
    const listEntriesPattern = (includePattern && !/[{,]/.test(includePattern))
      ? includePattern : undefined;
    const MAX_BATCH_BYTES = 32_000;

    const workerPoolPromises: Promise<void>[] = [];

    for (const [serverId, connection] of this.lastSearchConnectionMap) {
      if (signal?.aborted) break;

      const server = this.serverList.find(s => s.id === serverId);
      if (!server || !connection) continue;

      // Per-server worker count (override or global default)
      const parallelProcesses = server.maxSearchProcesses ?? globalParallelProcesses;

      // Build work queue from excluded system dirs
      const workQueue: Array<{ type: 'dir'; path: string } | { type: 'files'; filePaths: string[] }> = [];
      let workIndex = 0;

      for (const dir of dirsToSearch) {
        workQueue.push({ type: 'dir', path: dir });
      }

      this.currentTotalCount += workQueue.length;
      console.log(`[SSH Lite Search] Include-all worker pool: ${workQueue.length} system dirs, ${parallelProcesses} workers`);

      // Send progress update immediately
      if (searchId === this.currentSearchId) {
        this.postMessage({
          type: 'searchBatch', searchId, results: [],
          totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
          hitLimit: false, limit: maxResults,
          done: false,
        });
      }

      const poolPromise = (async () => {
        // Dynamic worker tracking
        let sysDesiredWorkerCount = Math.min(parallelProcesses, Math.max(workQueue.length, 2));
        let sysActiveWorkerCount = 0;
        const sysAllWorkerPromises: Promise<void>[] = [];
        const sysPoolKey = `${serverId}:/sys`;

        const runWorker = async (): Promise<void> => {
          sysActiveWorkerCount++;
          try {
          while (!signal?.aborted && globalSeen.size < maxResults) {
            if (sysActiveWorkerCount > sysDesiredWorkerCount && sysActiveWorkerCount > 1) return;
            if (workIndex >= workQueue.length) return;
            const item = workQueue[workIndex++];

            if (item.type === 'dir') {
              try {
                const entries = await connection.listEntries(item.path, listEntriesPattern);
                if (signal?.aborted) return;

                const batches: string[][] = [];
                let currentBatch: string[] = [];
                let currentBytes = 0;
                for (const file of entries.files) {
                  const fileBytes = file.length + 3;
                  if (currentBytes + fileBytes > MAX_BATCH_BYTES && currentBatch.length > 0) {
                    batches.push(currentBatch);
                    currentBatch = [];
                    currentBytes = 0;
                  }
                  currentBatch.push(file);
                  currentBytes += fileBytes;
                }
                if (currentBatch.length > 0) batches.push(currentBatch);

                for (const batch of batches) {
                  workQueue.push({ type: 'files', filePaths: batch });
                }
                for (const dir of entries.dirs) {
                  workQueue.push({ type: 'dir', path: dir });
                }

                const newItems = batches.length + entries.dirs.length;
                this.currentTotalCount += newItems;

                this.currentCompletedCount++;
                if (searchId !== this.currentSearchId) return;
                this.postMessage({
                  type: 'searchBatch', searchId, results: [],
                  totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                  hitLimit: false, limit: maxResults,
                  done: this.currentCompletedCount === this.currentTotalCount,
                });
              } catch {
                // Fallback to recursive grep on this dir
                const actId = activityService.startActivity(
                  'search', connection.id, connection.host.name,
                  `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
                  { detail: `in ${item.path} (system dir)`, cancellable: true, onCancel: () => { abortController?.abort(); } }
                );
                this.currentSearchActivityIds.push(actId);
                try {
                  const results = await connection.searchFiles(item.path, query, {
                    searchContent: !findFiles, caseSensitive, regex,
                    filePattern: includePattern || '*',
                    excludePattern: excludePattern || undefined,
                    maxResults, signal: signal!,
                  });
                  if (signal?.aborted) { activityService.cancelActivity(actId); return; }
                  const mapped = results.map((r) => ({
                    ...r, modified: r.modified ? r.modified.getTime() : undefined,
                    connectionId: connection.id, connectionName: connection.host.name,
                  }));
                  activityService.completeActivity(actId, `${mapped.length} results`);
                  const unique = mapped.filter((r) => {
                    const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
                    if (globalSeen.has(key)) return false;
                    globalSeen.add(key);
                    return true;
                  });
                  this.currentCompletedCount++;
                  if (searchId !== this.currentSearchId) return;
                  this.postMessage({
                    type: 'searchBatch', searchId, results: unique,
                    totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                    hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                    done: this.currentCompletedCount === this.currentTotalCount,
                  });
                } catch (error) {
                  activityService.failActivity(actId, (error as Error).message);
                  this.currentCompletedCount++;
                  if (searchId !== this.currentSearchId) return;
                  this.postMessage({
                    type: 'searchBatch', searchId, results: [],
                    totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                    hitLimit: false, limit: maxResults,
                    done: this.currentCompletedCount === this.currentTotalCount,
                  });
                }
              }
            } else if (item.type === 'files') {
              const actId = activityService.startActivity(
                'search', connection.id, connection.host.name,
                `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
                { detail: `${item.filePaths.length} files (system dir)`, cancellable: true,
                  onCancel: () => { abortController?.abort(); } }
              );
              this.currentSearchActivityIds.push(actId);
              try {
                const results = await connection.searchFiles(item.filePaths, query, {
                  searchContent: !findFiles, caseSensitive, regex,
                  filePattern: includePattern || '*',
                  excludePattern: excludePattern || undefined,
                  maxResults, signal: signal!,
                });
                if (signal?.aborted) { activityService.cancelActivity(actId); return; }
                const mapped = results.map((r) => ({
                  ...r, modified: r.modified ? r.modified.getTime() : undefined,
                  connectionId: connection.id, connectionName: connection.host.name,
                }));
                activityService.completeActivity(actId, `${mapped.length} results`);
                const unique = mapped.filter((r) => {
                  const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
                  if (globalSeen.has(key)) return false;
                  globalSeen.add(key);
                  return true;
                });
                this.currentCompletedCount++;
                if (searchId !== this.currentSearchId) return;
                this.postMessage({
                  type: 'searchBatch', searchId, results: unique,
                  totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                  hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                  done: this.currentCompletedCount === this.currentTotalCount,
                });
              } catch (error) {
                activityService.failActivity(actId, (error as Error).message);
                this.currentCompletedCount++;
                if (searchId !== this.currentSearchId) return;
                this.postMessage({
                  type: 'searchBatch', searchId, results: [],
                  totalResults: globalSeen.size, completedCount: this.currentCompletedCount, totalCount: this.currentTotalCount,
                  hitLimit: false, limit: maxResults,
                  done: this.currentCompletedCount === this.currentTotalCount,
                });
              }
            }
          }
          } finally {
            sysActiveWorkerCount--;
          }
        };

        // Register pool controller
        const sysAddWorker = () => {
          const p = runWorker();
          sysAllWorkerPromises.push(p);
        };
        this.activeWorkerPools.set(sysPoolKey, {
          get desiredWorkerCount() { return sysDesiredWorkerCount; },
          set desiredWorkerCount(v: number) { sysDesiredWorkerCount = v; },
          get activeWorkerCount() { return sysActiveWorkerCount; },
          addWorker: sysAddWorker,
        });

        for (let wi = 0; wi < sysDesiredWorkerCount; wi++) {
          sysAllWorkerPromises.push(runWorker());
        }
        while (true) {
          const len = sysAllWorkerPromises.length;
          await Promise.all(sysAllWorkerPromises);
          if (sysAllWorkerPromises.length === len) break;
        }
        this.activeWorkerPools.delete(sysPoolKey);
      })();

      workerPoolPromises.push(poolPromise);
    }

    await Promise.all(workerPoolPromises);

    // If search was resumed and all work is now done, finalize
    if (searchId === this.currentSearchId) {
      this.isSearching = false;
      this.sendState();
    }
  }

  /**
   * Returns true if childPath is a strict child of parentPath.
   * Handles root "/" correctly: every absolute path is a child of "/".
   */
  private static isChildPath(childPath: string, parentPath: string): boolean {
    if (parentPath === '/') return childPath !== '/';
    return childPath.startsWith(parentPath + '/');
  }

  /**
   * Detect redundant child paths (same server) and cross-user overlapping paths (same host).
   * Same-user child paths: grayed out, NOT searched (saves resources).
   * Cross-user overlaps: warned but still searched (different permissions).
   */
  private detectRedundancy(): void {
    // Reset all flags first
    for (const server of this.serverList) {
      for (const sp of server.searchPaths) {
        sp.redundantOf = undefined;
        sp.overlapWarning = undefined;
      }
    }

    // Same-server, same-user: child-path redundancy
    for (const server of this.serverList) {
      if (!server.checked) continue;
      for (const sp of server.searchPaths) {
        for (const other of server.searchPaths) {
          if (other === sp) continue;
          if (sp.path === other.path || SearchPanel.isChildPath(sp.path, other.path)) {
            sp.redundantOf = other.path;
            break;
          }
        }
      }
    }

    // Cross-user overlap: same host, different user
    for (const server of this.serverList) {
      if (!server.checked) continue;
      const host = server.hostConfig.host;
      const port = server.hostConfig.port;

      for (const sp of server.searchPaths) {
        if (sp.redundantOf) continue; // already grayed, skip overlap check

        for (const other of this.serverList) {
          if (other === server || !other.checked) continue;
          if (other.hostConfig.host !== host || other.hostConfig.port !== port) continue;

          for (const otherPath of other.searchPaths) {
            if (sp.path === otherPath.path ||
                SearchPanel.isChildPath(sp.path, otherPath.path) ||
                SearchPanel.isChildPath(otherPath.path, sp.path)) {
              sp.overlapWarning = `Overlaps with ${other.hostConfig.username}@${other.hostConfig.name} ${otherPath.path}`;
              break;
            }
          }
          if (sp.overlapWarning) break;
        }
      }
    }
  }

  /**
   * Post message to webview
   */
  private postMessage(message: unknown): void {
    if (this.panel) {
      this.panel.webview.postMessage(message);
    }
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Search</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 0;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .main-container {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: row;
      margin: 0;
      min-height: 0;
      overflow: hidden;
    }

    .controls-section {
      width: 350px;
      min-width: 200px;
      max-width: 80vw;
      border-right: none;
      overflow-y: auto;
      flex-shrink: 0;
    }

    .resizer {
      width: 5px;
      background: var(--vscode-panel-border);
      cursor: ew-resize;
      flex-shrink: 0;
      position: relative;
    }

    .resizer::after {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 3px;
      height: 30px;
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 2px;
    }

    .resizer:hover,
    .resizer.dragging {
      background: var(--vscode-focusBorder);
    }

    .resizer:hover::after,
    .resizer.dragging::after {
      background: var(--vscode-button-background);
    }

    .search-container {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .search-row {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
    }

    .search-input-wrapper {
      flex: 1;
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }

    .search-input-wrapper:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .search-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--vscode-input-foreground);
      padding: 4px 8px;
      font-size: 13px;
      outline: none;
      min-width: 0;
    }

    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .toggle-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      padding: 4px 6px;
      cursor: pointer;
      font-size: 12px;
      border-radius: 2px;
      opacity: 0.6;
      flex-shrink: 0;
    }

    .toggle-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }

    .toggle-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      opacity: 1;
    }

    .pattern-section {
      margin-top: 4px;
    }

    .pattern-toggle {
      display: flex;
      align-items: center;
      cursor: pointer;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      user-select: none;
    }

    .pattern-toggle:hover {
      color: var(--vscode-foreground);
    }

    .pattern-toggle .chevron {
      margin-right: 4px;
      transition: transform 0.1s;
    }

    .pattern-toggle .chevron.collapsed {
      transform: rotate(-90deg);
    }

    .pattern-fields {
      display: none;
    }

    .pattern-fields.expanded {
      display: block;
    }

    .pattern-row {
      display: flex;
      align-items: center;
      margin-bottom: 4px;
    }

    .pattern-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      width: 90px;
      flex-shrink: 0;
    }

    .pattern-input {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      color: var(--vscode-input-foreground);
      padding: 3px 6px;
      font-size: 12px;
      outline: none;
    }

    .pattern-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .pattern-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .scopes-section {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .scopes-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .scopes-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }

    .clear-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
    }

    .clear-btn:hover {
      color: var(--vscode-foreground);
    }

    .scope-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .scope-item {
      display: flex;
      align-items: center;
      padding: 2px 4px;
      border-radius: 2px;
      background: var(--vscode-list-hoverBackground);
    }

    .scope-icon {
      margin-right: 6px;
      opacity: 0.8;
    }

    .scope-path {
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .scope-remove {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      line-height: 1;
      border-radius: 2px;
    }

    .scope-remove:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .no-scopes {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 4px 0;
    }

    /* Server list styles */
    .servers-section {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .servers-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .servers-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }

    .servers-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .servers-actions .action-link {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
    }

    .servers-actions .action-link:hover {
      color: var(--vscode-foreground);
    }

    .sort-toggle {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
    }

    .sort-toggle:hover {
      color: var(--vscode-foreground);
    }

    .server-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .server-group {
      margin-bottom: 2px;
    }

    .server-row {
      display: flex;
      align-items: center;
      padding: 3px 4px;
      border-radius: 2px;
      cursor: pointer;
      user-select: none;
    }

    .server-row:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .server-row:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .server-row.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .server-checkbox {
      margin-right: 6px;
      flex-shrink: 0;
      accent-color: var(--vscode-checkbox-background);
    }

    .server-name {
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .server-status {
      font-size: 10px;
      margin-left: 4px;
      flex-shrink: 0;
    }

    .server-paths {
      padding-left: 26px;
    }

    .server-paths.empty {
      padding-left: 26px;
    }

    .path-item {
      display: flex;
      align-items: center;
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 12px;
    }

    .path-item.redundant {
      opacity: 0.4;
    }

    .path-item.overlap .path-text {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .path-icon {
      margin-right: 4px;
      opacity: 0.8;
      font-size: 11px;
    }

    .path-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .path-remove {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 1px 4px;
      font-size: 13px;
      line-height: 1;
      border-radius: 2px;
      opacity: 0;
    }

    .path-item:hover .path-remove,
    .server-group:hover .path-remove {
      opacity: 1;
    }

    .path-remove:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .add-path-link {
      display: inline-block;
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 2px 4px;
      text-decoration: none;
    }

    .add-path-link:hover {
      text-decoration: underline;
    }

    .no-paths {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 2px 4px;
    }

    .path-input-row {
      display: flex;
      align-items: center;
      padding: 1px 4px;
    }

    .path-input {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      color: var(--vscode-input-foreground);
      padding: 2px 6px;
      font-size: 12px;
      outline: none;
    }

    .path-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .server-processes {
      display: flex;
      align-items: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 1px 4px;
      gap: 2px;
    }
    .processes-label {
      opacity: 0.7;
    }
    .processes-value {
      cursor: pointer;
      padding: 0 3px;
      border-radius: 2px;
    }
    .processes-value:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .processes-value.override {
      color: var(--vscode-textLink-foreground);
    }
    .processes-default {
      opacity: 0.6;
      font-size: 10px;
    }
    .processes-reset {
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 0 2px;
      border-radius: 2px;
      margin-left: 2px;
    }
    .processes-reset:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-errorForeground);
    }
    .processes-input {
      width: 48px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-input-foreground);
      font-size: 11px;
      padding: 1px 4px;
      border-radius: 2px;
      outline: none;
    }

    .no-servers {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 4px 0;
    }

    .results-section {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0;
      min-width: 0;
      min-height: 0;
      height: 100%;
    }

    .result-tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      overflow-x: auto;
      padding: 0 4px;
      flex-shrink: 0;
    }
    .result-tab {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      max-width: 150px;
      opacity: 0.7;
    }
    .result-tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .result-tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
    .result-tab.searching .tab-label { font-style: italic; }
    .tab-label { overflow: hidden; text-overflow: ellipsis; }
    .tab-close {
      background: transparent; border: none; cursor: pointer;
      color: var(--vscode-descriptionForeground); margin-left: 4px; font-size: 12px;
      padding: 0 2px; border-radius: 2px;
    }
    .tab-close:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }

    .results-header {
      padding: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-sideBar-background);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .results-count {
      flex: 1;
    }

    .view-toggle-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 8px;
    }

    .view-toggle-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .view-toggle-btn.active {
      color: var(--vscode-textLink-foreground);
    }

    /* Tree view styles */
    .tree-node {
      user-select: none;
    }

    .tree-folder {
      cursor: pointer;
    }

    .tree-folder-header {
      display: flex;
      align-items: center;
      padding: 2px 4px;
      padding-left: calc(var(--indent, 0) * 16px + 4px);
    }

    .tree-folder-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tree-folder-icon {
      margin-right: 4px;
      font-size: 12px;
    }

    .tree-folder-name {
      font-size: 12px;
    }

    .tree-folder-count {
      margin-left: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .tree-folder-children {
      display: none;
    }

    .tree-folder-children.expanded {
      display: block;
    }

    .tree-file {
      display: flex;
      align-items: center;
      padding: 2px 4px;
      padding-left: calc(var(--indent, 0) * 16px + 4px);
      cursor: pointer;
    }

    .tree-file:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tree-file-icon {
      margin-right: 4px;
      font-size: 12px;
    }

    .tree-file-name {
      font-size: 12px;
    }

    .tree-file-count {
      margin-left: 8px;
      font-size: 11px;
      color: var(--vscode-badge-background);
      background: var(--vscode-badge-foreground);
      border-radius: 8px;
      padding: 0 6px;
    }

    .tree-matches {
      display: none;
      padding-left: calc(var(--indent, 0) * 16px + 20px);
    }

    .tree-matches.expanded {
      display: block;
    }

    .tree-match-item {
      display: flex;
      padding: 1px 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .tree-match-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .searching {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .no-results {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .system-dirs-notice {
      padding: 6px 12px;
      background: var(--vscode-editorInfo-background, rgba(0, 120, 212, 0.1));
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .system-dirs-notice .include-all-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }

    .system-dirs-notice .include-all-link:hover {
      text-decoration: underline;
    }

    .system-dirs-notice .notice-dismiss {
      margin-left: auto;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.6;
      font-size: 14px;
    }

    .system-dirs-notice .notice-dismiss:hover {
      opacity: 1;
    }

    .file-group {
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .file-header {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      background: var(--vscode-list-hoverBackground);
    }

    .file-header:hover {
      background: var(--vscode-list-activeSelectionBackground);
    }

    .file-icon {
      margin-right: 6px;
      opacity: 0.8;
    }

    .file-name {
      font-size: 13px;
      font-weight: 500;
    }

    .server-tag {
      font-size: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 5px;
      border-radius: 3px;
      margin-right: 4px;
      white-space: nowrap;
    }

    .server-group {
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .server-header {
      display: flex;
      align-items: center;
      padding: 6px 4px;
      cursor: pointer;
      background: var(--vscode-sideBar-background);
      font-weight: 600;
      position: sticky;
      top: 33px;
      z-index: 1;
    }

    .server-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .server-icon {
      margin-right: 6px;
    }

    .server-name {
      font-size: 13px;
    }

    .server-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
    }

    .server-files {
      display: none;
      padding-left: 12px;
    }

    .server-files.expanded {
      display: block;
    }

    .file-path {
      flex: 1;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
    }

    .reveal-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 12px;
      padding: 0 4px;
      margin-left: 4px;
      opacity: 0;
      transition: opacity 0.1s;
    }

    .file-header:hover .reveal-btn,
    .tree-file:hover .reveal-btn {
      opacity: 1;
    }

    .reveal-btn:hover {
      color: var(--vscode-textLink-foreground);
    }

    .chevron {
      margin-right: 4px;
      transition: transform 0.1s;
    }

    .chevron.collapsed {
      transform: rotate(-90deg);
    }

    .match-list {
      display: none;
    }

    .match-list.expanded {
      display: block;
    }

    .match-item {
      display: flex;
      align-items: flex-start;
      padding: 2px 8px 2px 28px;
      cursor: pointer;
      font-size: 12px;
    }

    .match-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .match-line {
      color: var(--vscode-descriptionForeground);
      margin-right: 8px;
      min-width: 40px;
    }

    .match-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .match-highlight {
      background: var(--vscode-editor-findMatchHighlightBackground);
      border-radius: 2px;
    }

    .search-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      margin-left: 6px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 14px;
    }

    .search-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .search-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .cancel-btn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }

    .cancel-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    .limit-warning {
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 11px;
    }

    .limit-warning a {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      cursor: pointer;
    }

    .limit-warning a:hover {
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="main-container">
    <div class="controls-section">
      <div class="search-container">
        <div class="search-row">
          <div class="search-input-wrapper">
            <input type="text" id="searchInput" class="search-input" placeholder="Search" autofocus>
            <button id="caseSensitiveBtn" class="toggle-btn" title="Match Case">Aa</button>
            <button id="regexBtn" class="toggle-btn" title="Use Regular Expression">.*</button>
            <button id="findFilesBtn" class="toggle-btn" title="Find Files by Name — search for filenames instead of file content">&#128196;</button>
          </div>
          <button id="searchBtn" class="search-btn" title="Search (Enter)">&#128269;</button>
          <button id="cancelBtn" class="search-btn cancel-btn" title="Cancel Search" style="display: none;">&#x2715;</button>
        </div>
        <div class="pattern-section">
          <div class="pattern-toggle" id="patternToggle">
            <span class="chevron collapsed" id="patternChevron">▼</span>
            <span>files to include/exclude</span>
          </div>
          <div class="pattern-fields" id="patternFields">
            <div class="pattern-row">
              <span class="pattern-label">to include</span>
              <input type="text" id="includeInput" class="pattern-input" placeholder="e.g. *.ts, src/**">
            </div>
            <div class="pattern-row">
              <span class="pattern-label">to exclude</span>
              <input type="text" id="excludeInput" class="pattern-input" placeholder="e.g. node_modules, *.test.ts">
            </div>
          </div>
        </div>
      </div>

      <div class="servers-section">
        <div class="servers-header">
          <span class="servers-title">Servers</span>
          <div class="servers-actions">
            <button id="sortToggleBtn" class="sort-toggle" title="Sort: servers with search paths first">&#8593;checked</button>
            <button id="selectAllBtn" class="action-link" title="Select all available servers">All</button>
            <button id="selectNoneBtn" class="action-link" title="Deselect all servers">None</button>
          </div>
        </div>
        <div id="serverList" class="server-list">
          <div class="no-servers">No servers configured.</div>
        </div>
      </div>
    </div>

    <div class="resizer" id="resizer"></div>

    <div class="results-section">
      <div id="resultTabBar" class="result-tab-bar" style="display:none"></div>
      <div id="resultsHeader" class="results-header" style="display: none;"></div>
      <div id="resultsContainer"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // State
    let scopes = [];
    let serverList = [];       // New cross-server search model
    let globalMaxSearchProcesses = 20; // Updated from state messages
    // --- Tab state management ---
    // Each tab (kept or Current) owns its own isolated state.
    function createTabState(overrides) {
      return Object.assign({
        id: Date.now().toString(),
        query: '',
        include: '',
        exclude: '',
        caseSensitive: false,
        useRegex: false,
        findFilesMode: false,
        results: [],
        scopeServers: [],
        hitLimit: false,
        limit: 2000,
        searchId: null,
        searching: false,
        timestamp: Date.now(),
        expandedFiles: new Set(),
        expandedTreeNodes: new Set(),
        treeViewFirstExpand: true,
        searchExpandState: 2,
        viewMode: 'list',
      }, overrides || {});
    }

    let resultTabs = [];              // Array of kept tab state objects
    let activeTabId = null;           // null = Current tab
    let currentTab = createTabState(); // The "Current" tab's state (always exists)
    let tabSearchIdMap = {};          // { searchId: tabId } — routes searchBatch to kept tabs

    // Per-tab state aliases (updated by save/restore on tab switch)
    let caseSensitive = false;
    let useRegex = false;
    let findFilesMode = false;
    let expandedFiles = new Set();
    let viewMode = 'list';
    let expandedTreeNodes = new Set();
    let treeViewFirstExpand = true;
    let searchExpandState = 2;

    // Global state (shared across all tabs)
    let sortOrder = 'checked';
    let currentDisplayScopeServers = [];
    let lastClickedServerIndex = -1;
    let currentSearchId = 0;

    function getActiveTabState() {
      if (activeTabId) return resultTabs.find(function(t) { return t.id === activeTabId; });
      return currentTab;
    }

    function saveCurrentInputState() {
      var tab = getActiveTabState();
      if (!tab) return;
      tab.query = searchInput.value;
      tab.include = includeInput.value;
      tab.exclude = excludeInput.value;
      tab.caseSensitive = caseSensitive;
      tab.useRegex = useRegex;
      tab.findFilesMode = findFilesMode;
      tab.viewMode = viewMode;
      tab.searchExpandState = searchExpandState;
      tab.expandedFiles = new Set(expandedFiles);
      tab.expandedTreeNodes = new Set(expandedTreeNodes);
      tab.treeViewFirstExpand = treeViewFirstExpand;
    }

    function restoreTabState(tab) {
      searchInput.value = tab.query || '';
      includeInput.value = tab.include || '';
      excludeInput.value = tab.exclude || '';
      caseSensitive = tab.caseSensitive || false;
      useRegex = tab.useRegex || false;
      findFilesMode = tab.findFilesMode || false;
      viewMode = tab.viewMode || 'list';
      searchExpandState = tab.searchExpandState != null ? tab.searchExpandState : 2;
      expandedFiles = new Set(tab.expandedFiles || []);
      expandedTreeNodes = new Set(tab.expandedTreeNodes || []);
      treeViewFirstExpand = tab.treeViewFirstExpand != null ? tab.treeViewFirstExpand : true;
      // Update toggle button UI
      caseSensitiveBtn.classList.toggle('active', caseSensitive);
      regexBtn.classList.toggle('active', useRegex);
      findFilesBtn.classList.toggle('active', findFilesMode);
      searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
      // Update search/cancel button visibility
      if (tab.searching) {
        searchBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-block';
      } else {
        searchBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'none';
      }
    }

    function cleanupTab(tab) {
      // LITE: free memory
      if (tab) {
        tab.results = [];
        tab.scopeServers = [];
        tab.expandedFiles = null;
        tab.expandedTreeNodes = null;
      }
    }

    // Elements
    const searchInput = document.getElementById('searchInput');
    const includeInput = document.getElementById('includeInput');
    const excludeInput = document.getElementById('excludeInput');
    const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
    const regexBtn = document.getElementById('regexBtn');
    const findFilesBtn = document.getElementById('findFilesBtn');
    const searchBtn = document.getElementById('searchBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const sortToggleBtn = document.getElementById('sortToggleBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectNoneBtn = document.getElementById('selectNoneBtn');
    const serverListEl = document.getElementById('serverList');
    const resultTabBar = document.getElementById('resultTabBar');
    const resultsHeader = document.getElementById('resultsHeader');
    const resultsContainer = document.getElementById('resultsContainer');
    const patternToggle = document.getElementById('patternToggle');
    const patternChevron = document.getElementById('patternChevron');
    const patternFields = document.getElementById('patternFields');
    const resizer = document.getElementById('resizer');
    const controlsSection = document.querySelector('.controls-section');

    // Initialize
    function init() {
      // Search only on Enter key press
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });

      // Search button click
      searchBtn.addEventListener('click', () => {
        performSearch();
      });

      // Cancel button click
      cancelBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancelSearch' });
      });

      // Pattern toggle (collapsible)
      patternToggle.addEventListener('click', () => {
        const isExpanded = patternFields.classList.contains('expanded');
        patternFields.classList.toggle('expanded', !isExpanded);
        patternChevron.classList.toggle('collapsed', isExpanded);
      });

      // Pattern inputs - trigger search on Enter only
      includeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });
      excludeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });

      // Toggle buttons
      caseSensitiveBtn.addEventListener('click', () => {
        caseSensitive = !caseSensitive;
        caseSensitiveBtn.classList.toggle('active', caseSensitive);
        performSearch();
      });

      regexBtn.addEventListener('click', () => {
        useRegex = !useRegex;
        regexBtn.classList.toggle('active', useRegex);
        performSearch();
      });

      // Find files mode toggle
      findFilesBtn.addEventListener('click', () => {
        findFilesMode = !findFilesMode;
        findFilesBtn.classList.toggle('active', findFilesMode);
        searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
        findFilesBtn.title = findFilesMode
          ? 'Search File Content \\u2014 search for text inside files'
          : 'Find Files by Name \\u2014 search for filenames instead of file content';
      });

      // Server list actions
      sortToggleBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'toggleSort' });
      });

      selectAllBtn.addEventListener('click', () => {
        serverList.forEach(s => {
          if (!s.disabled) {
            vscode.postMessage({ type: 'toggleServer', serverId: s.id, checked: true });
          }
        });
      });

      selectNoneBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearScopes' });
      });

      // Resizer drag functionality (horizontal - width resize)
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = controlsSection.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + deltaX));
        controlsSection.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });

      // Notify extension we're ready
      vscode.postMessage({ type: 'ready' });
    }

    // Perform search
    function performSearch() {
      const query = searchInput.value.trim();
      // Check if any server is checked (new model) or legacy scopes exist
      const hasServerScopes = serverList.some(s => s.checked && !s.disabled);
      if (!query || (!hasServerScopes && scopes.length === 0)) {
        showNoResults();
        return;
      }

      vscode.postMessage({
        type: 'search',
        query,
        include: includeInput.value.trim(),
        exclude: excludeInput.value.trim(),
        caseSensitive,
        regex: useRegex,
        findFiles: findFilesMode
      });
    }

    // Render server list (replaces old renderScopes)
    function renderServers() {
      if (serverList.length === 0) {
        serverListEl.innerHTML = '<div class="no-servers">No servers configured.</div>';
        return;
      }

      let html = '';
      serverList.forEach((server, idx) => {
        const statusIcon = server.status === 'connecting' ? '\\u{1F504}'
          : server.status === 'failed' ? '\\u{274C}'
          : server.connected ? '\\u{1F7E2}'
          : server.hasCredential ? '\\u{26A1}'
          : '\\u{26AA}';

        const statusTitle = server.status === 'connecting' ? 'Connecting to server...'
          : server.status === 'failed' ? ('Connection failed: ' + escapeHtml(server.error || 'Unknown error'))
          : server.connected ? 'Include this server in search'
          : server.hasCredential ? 'Include this server \\u2014 will auto-connect using saved credentials'
          : 'Save credentials first to search this server';

        const disabledAttr = server.disabled ? ' disabled' : '';
        const disabledClass = server.disabled ? ' disabled' : '';
        const checkedAttr = server.checked ? ' checked' : '';
        const displayName = escapeHtml(server.name) + ' (' + escapeHtml(server.username) + ')';
        const fullTitle = escapeHtml(server.name) + ' (' + escapeHtml(server.username) + ') \\u2014 ' + escapeHtml(server.host) + ':' + server.port;

        html += '<div class="server-group">';
        html += '<div class="server-row' + disabledClass + '" tabindex="0" data-server-id="' + escapeHtml(server.id) + '" data-server-idx="' + idx + '" title="' + fullTitle + '">';
        html += '<input type="checkbox" class="server-checkbox" data-server-id="' + escapeHtml(server.id) + '"' + checkedAttr + disabledAttr + ' title="' + escapeHtml(statusTitle) + '">';
        html += '<span class="server-name">' + displayName + '</span>';
        html += '<span class="server-status" title="' + escapeHtml(statusTitle) + '">' + statusIcon + '</span>';
        html += '</div>';

        // Search paths
        html += '<div class="server-paths' + (server.searchPaths.length === 0 ? ' empty' : '') + '">';
        if (server.searchPaths.length > 0) {
          server.searchPaths.forEach((sp, pathIdx) => {
            const pathIcon = sp.isFile ? '\\u{1F4C4}' : '\\u{1F4C1}';
            let pathClass = 'path-item';
            let pathTitle = escapeHtml(sp.path);
            let warnIcon = '';

            if (sp.redundantOf) {
              pathClass += ' redundant';
              pathTitle = 'Already included by ' + escapeHtml(sp.redundantOf) + ' \\u2014 this path will be skipped';
            } else if (sp.overlapWarning) {
              pathClass += ' overlap';
              pathTitle = escapeHtml(sp.overlapWarning) + ' \\u2014 results may be duplicated (different permissions)';
              warnIcon = ' \\u{26A0}\\u{FE0F}';
            }

            html += '<div class="' + pathClass + '">';
            html += '<span class="path-icon">' + pathIcon + '</span>';
            html += '<span class="path-text" title="' + pathTitle + '">' + escapeHtml(sp.path) + warnIcon + '</span>';
            html += '<button class="path-remove" data-server-id="' + escapeHtml(server.id) + '" data-path-idx="' + pathIdx + '" title="Remove this search path">\\u00D7</button>';
            html += '</div>';
          });

          // Add folder link (only if server is not disabled)
          if (!server.disabled) {
            html += '<a class="add-path-link" data-server-id="' + escapeHtml(server.id) + '" title="Add another folder to search on this server">+ Add folder</a>';
          }
        } else if (!server.disabled) {
          html += '<span class="no-paths" title="Server will search from / (root). Click + Add folder to narrow scope.">/ (all files)</span>';
          html += '<a class="add-path-link" data-server-id="' + escapeHtml(server.id) + '" title="Add another folder to search on this server" style="display:inline-block">+ Add folder</a>';
        } else {
          html += '<span class="no-paths">(no credentials)</span>';
        }

        // Per-server worker count control
        if (!server.disabled) {
          const hasOverride = server.maxSearchProcesses != null;
          const displayValue = hasOverride ? server.maxSearchProcesses : (globalMaxSearchProcesses || 20);
          const valueClass = hasOverride ? 'processes-value override' : 'processes-value';
          html += '<div class="server-processes" data-server-id="' + escapeHtml(server.id) + '">';
          html += '<span class="processes-label">Workers: </span>';
          html += '<span class="' + valueClass + '">' + displayValue + '</span>';
          if (hasOverride) {
            html += '<span class="processes-default"> (custom)</span>';
            html += '<button class="processes-reset" title="Reset to default (' + (globalMaxSearchProcesses || 20) + ')">\\u00D7</button>';
          } else {
            html += '<span class="processes-default"> (default)</span>';
          }
          html += '</div>';
        }

        html += '</div>';
        html += '</div>';
      });

      serverListEl.innerHTML = html;

      // Wire event handlers
      // Checkbox toggle
      serverListEl.querySelectorAll('.server-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const serverId = e.target.dataset.serverId;
          const checked = e.target.checked;
          vscode.postMessage({ type: 'toggleServer', serverId, checked });
        });
      });

      // Server row click (toggle checkbox) + shift-click range selection + space key
      serverListEl.querySelectorAll('.server-row').forEach(row => {
        row.addEventListener('click', (e) => {
          // Don't toggle if clicking on checkbox directly or remove button
          if (e.target.tagName === 'INPUT' || e.target.classList.contains('path-remove')) return;

          const serverId = row.dataset.serverId;
          const idx = parseInt(row.dataset.serverIdx);
          const server = serverList.find(s => s.id === serverId);
          if (!server || server.disabled) return;

          if (e.shiftKey && lastClickedServerIndex >= 0) {
            // Range selection
            const from = Math.min(lastClickedServerIndex, idx);
            const to = Math.max(lastClickedServerIndex, idx);
            const targetChecked = !server.checked;
            for (let i = from; i <= to; i++) {
              const s = serverList[i];
              if (s && !s.disabled) {
                vscode.postMessage({ type: 'toggleServer', serverId: s.id, checked: targetChecked });
              }
            }
          } else {
            // Single toggle
            vscode.postMessage({ type: 'toggleServer', serverId, checked: !server.checked });
          }
          lastClickedServerIndex = idx;
        });

        // Space key toggle
        row.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const serverId = row.dataset.serverId;
            const server = serverList.find(s => s.id === serverId);
            if (server && !server.disabled) {
              vscode.postMessage({ type: 'toggleServer', serverId, checked: !server.checked });
            }
          }
        });
      });

      // Path remove buttons
      serverListEl.querySelectorAll('.path-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const serverId = e.target.dataset.serverId;
          const pathIdx = parseInt(e.target.dataset.pathIdx);
          vscode.postMessage({ type: 'removeServerPath', serverId, pathIndex: pathIdx });
        });
      });

      // Add folder links
      serverListEl.querySelectorAll('.add-path-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const serverId = e.target.dataset.serverId;
          // Create inline input
          const container = e.target.parentElement;
          const inputRow = document.createElement('div');
          inputRow.className = 'path-input-row';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'path-input';
          input.placeholder = '/path/to/search';
          inputRow.appendChild(input);
          container.insertBefore(inputRow, e.target);
          input.focus();

          const commit = () => {
            const path = input.value.trim();
            if (path) {
              vscode.postMessage({ type: 'addServerPath', serverId, path });
            }
            inputRow.remove();
          };

          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') commit();
            if (ke.key === 'Escape') inputRow.remove();
          });
          input.addEventListener('blur', commit);
        });
      });

      // Workers: click value to edit
      serverListEl.querySelectorAll('.processes-value').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const container = el.closest('.server-processes');
          if (!container) return;
          const serverId = container.dataset.serverId;
          const server = serverList.find(s => s.id === serverId);
          if (!server) return;

          const currentVal = server.maxSearchProcesses || globalMaxSearchProcesses;
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '5';
          input.max = '50';
          input.value = String(currentVal);
          input.className = 'processes-input';

          el.replaceWith(input);
          input.focus();
          input.select();

          const commit = () => {
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && val >= 5 && val <= 50) {
              vscode.postMessage({ type: 'setServerMaxProcesses', serverId, value: val });
            } else {
              renderServers(); // revert
            }
          };

          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
            if (ke.key === 'Escape') { ke.preventDefault(); renderServers(); }
          });
          input.addEventListener('blur', commit);
        });
      });

      // Workers: reset button
      serverListEl.querySelectorAll('.processes-reset').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const container = btn.closest('.server-processes');
          if (!container) return;
          const serverId = container.dataset.serverId;
          vscode.postMessage({ type: 'setServerMaxProcesses', serverId, value: null });
        });
      });
    }

    // Debounced progressive render — 100ms debounce for intermediate batches, immediate on done
    let renderDebounceTimer = null;
    function debouncedRenderResults(hitLimit, limit, done, completedCount, totalCount) {
      if (renderDebounceTimer) {
        clearTimeout(renderDebounceTimer);
        renderDebounceTimer = null;
      }
      const doRender = () => {
        const tab = getActiveTabState();
        const tabResults = tab ? tab.results : [];
        if (tabResults.length === 0 && !done) {
          // Still searching, no results yet — show progress in searching indicator
          resultsHeader.style.display = 'flex';
          resultsHeader.innerHTML = '<span class="results-count">Searching... (' + completedCount + '/' + totalCount + ' done)</span>';
          return;
        }
        if (tabResults.length === 0 && done) {
          showNoResults();
          return;
        }
        // Save scroll position before re-render
        const scrollTop = resultsContainer.scrollTop;
        renderResults(hitLimit, limit);
        // Override header with progress info while search is in progress
        if (!done) {
          const countEl = resultsHeader.querySelector('.results-count');
          if (countEl) {
            const fileCount = new Set(tabResults.map(r => r.connectionId + ':' + r.path)).size;
            countEl.innerHTML = tabResults.length + ' result' + (tabResults.length !== 1 ? 's' : '') + ' in ' +
              fileCount + ' file' + (fileCount !== 1 ? 's' : '') +
              ' <span style="opacity: 0.7">(' + completedCount + '/' + totalCount + ' done...)</span>';
          }
        }
        // Restore scroll position
        resultsContainer.scrollTop = scrollTop;
      };

      if (done) {
        doRender(); // Final batch: render immediately
      } else {
        renderDebounceTimer = setTimeout(doRender, 100);
      }
    }

    // Render results
    function renderResults(hitLimit = false, limit = 2000) {
      // Always update tab bar
      renderTabBar();

      // Determine which data to display from active tab state
      const tab = getActiveTabState();
      const displayResults = tab.results;
      const displayScopeServers = tab.scopeServers;
      const displayHitLimit = tab.hitLimit || hitLimit;
      const displayLimit = tab.limit || limit;
      const displayQuery = tab.query || '';

      if (displayResults.length === 0) {
        showNoResults();
        return;
      }

      // Group by file
      const grouped = {};
      for (const result of displayResults) {
        const key = result.connectionId + ':' + result.path;
        if (!grouped[key]) {
          grouped[key] = {
            path: result.path,
            connectionId: result.connectionId,
            connectionName: result.connectionName,
            size: result.size,
            modified: result.modified,
            matches: []
          };
        }
        grouped[key].matches.push(result);
      }

      const fileGroups = Object.values(grouped);
      const fileCount = fileGroups.length;
      const matchCount = displayResults.length;

      // Set display scope servers for child render functions
      currentDisplayScopeServers = displayScopeServers;

      // Determine multi-server mode from scope servers (not just results)
      // This ensures server grouping appears even if one server returned zero results
      const multiServer = displayScopeServers.length > 1;

      // Count results per server for summary display
      const serverCounts = {};
      for (const result of displayResults) {
        const sKey = result.connectionId;
        if (!serverCounts[sKey]) {
          serverCounts[sKey] = { name: result.connectionName, count: 0 };
        }
        serverCounts[sKey].count++;
      }
      const serverNames = multiServer ? displayScopeServers : Object.values(serverCounts);

      // Render header with view toggle buttons
      resultsHeader.style.display = 'flex';
      let limitWarning = '';
      if (displayHitLimit) {
        limitWarning = \` <span class="limit-warning" title="Click to increase limit">⚠️ Limit \${displayLimit} reached - <a href="#" id="increaseLimitLink">increase limit</a></span>\`;
      }
      // Show per-server counts when results span multiple servers
      let serverSummary = '';
      if (multiServer) {
        serverSummary = ' (' + displayScopeServers.map(s => {
          const count = serverCounts[s.id] ? serverCounts[s.id].count : 0;
          return escapeHtml(s.name) + ': ' + count;
        }).join(', ') + ')';
      }
      const showPinBtn = !activeTabId && displayResults.length > 0;
      resultsHeader.innerHTML = \`
        <span class="results-count">\${matchCount} result\${matchCount !== 1 ? 's' : ''} in \${fileCount} file\${fileCount !== 1 ? 's' : ''}\${serverSummary}\${limitWarning}</span>
        \${showPinBtn ? '<button id="keepResultsBtn" class="view-toggle-btn" title="Keep Results (Pin)"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle"><path d="M10.97 2.29a.75.75 0 0 1 .073.976l-.073.084L9.06 5.26l1.57 1.57 1.73-1.72a.75.75 0 0 1 1.133.976l-.073.084-1.73 1.72.97.97a.75.75 0 0 1-.976 1.133l-.084-.073L9.87 8.19 7.81 10.25l.97.97a.75.75 0 0 1-.976 1.133l-.084-.073-4.5-4.5a.75.75 0 0 1 .976-1.133l.084.073.97.97 2.06-2.06-1.73-1.72a.75.75 0 0 1 .976-1.133l.084.073 1.73 1.72L9.91 2.29a.75.75 0 0 1 1.06 0z"/></svg></button>' : ''}
        <button id="expandToggleBtn" class="view-toggle-btn" title="\${getExpandToggleTitle()}">\${getExpandToggleIcon()}</button>
        <button id="listViewBtn" class="view-toggle-btn \${viewMode === 'list' ? 'active' : ''}" title="List View">☰</button>
        <button id="treeViewBtn" class="view-toggle-btn \${viewMode === 'tree' ? 'active' : ''}" title="Tree View"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;"><path d="M1 2h6v1.5H1zm4 4h6v1.5H5zm0 4h6v1.5H5zM3 3.5h1.5v3H3zm0 4h1.5v3H3z"/></svg></button>
      \`;

      // Add view toggle handlers
      setTimeout(() => {
        const listBtn = document.getElementById('listViewBtn');
        const treeBtn = document.getElementById('treeViewBtn');
        const expandToggle = document.getElementById('expandToggleBtn');
        const limitLink = document.getElementById('increaseLimitLink');
        const keepBtn = document.getElementById('keepResultsBtn');

        if (keepBtn) {
          keepBtn.addEventListener('click', () => {
            const activeTab = getActiveTabState();
            if (!activeTab || activeTab.results.length === 0) return;

            // Save current input state into the tab being kept
            saveCurrentInputState();

            // Move currentTab to resultTabs (it becomes a kept tab)
            if (!activeTabId) {
              resultTabs.push(currentTab);
              if (resultTabs.length > 10) {
                const evicted = resultTabs.shift();
                if (evicted && evicted.searchId) delete tabSearchIdMap[evicted.searchId];
                if (evicted) cleanupTab(evicted);
              }
              // Route future searchBatch for this searchId to the kept tab
              if (currentTab.searching && currentTab.searchId) {
                tabSearchIdMap[currentTab.searchId] = currentTab.id;
              }
              // Create a fresh Current tab
              currentTab = createTabState();
              activeTabId = null;
            }

            restoreTabState(currentTab);
            renderTabBar();
            renderResults();
          });
        }
        if (expandToggle) {
          expandToggle.addEventListener('click', () => {
            // Cycle: 0 → 1 (expand all) → 2 (file level) → 0 (collapse all)
            const nextState = (searchExpandState + 1) % 3;
            applySearchExpandState(nextState, fileGroups);
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (listBtn) {
          listBtn.addEventListener('click', () => {
            viewMode = 'list';
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (treeBtn) {
          treeBtn.addEventListener('click', () => {
            const wasListMode = viewMode === 'list';
            viewMode = 'tree';
            // If switching from list to tree for the first time, expand all nodes
            if (wasListMode && treeViewFirstExpand) {
              treeViewFirstExpand = false;
              expandAllTreeNodes(fileGroups);
            }
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (limitLink) {
          limitLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'increaseLimit' });
          });
        }
      }, 0);

      // Render based on view mode
      if (viewMode === 'tree') {
        renderTreeView(fileGroups, multiServer, displayQuery);
      } else {
        renderListView(fileGroups, multiServer, displayQuery);
      }
    }

    // Render list view (default)
    function renderListView(fileGroups, multiServer, displayQuery) {
      function renderFileGroup(group) {
        const fileName = group.path.split('/').pop();
        const dirPath = group.path.substring(0, group.path.length - fileName.length - 1) || '/';
        const fileKey = group.connectionId + ':' + group.path;
        const isExpanded = expandedFiles.has(fileKey);

        return \`
          <div class="file-group" data-file-key="\${escapeHtml(fileKey)}">
            <div class="file-header" data-file-key="\${escapeHtml(fileKey)}" data-path="\${escapeHtml(group.path)}" data-connection="\${escapeHtml(group.connectionId)}">
              <span class="chevron \${isExpanded ? '' : 'collapsed'}">▼</span>
              <span class="file-icon">📄</span>
              <span class="file-name">\${escapeHtml(fileName)}</span>
              <span class="file-path">\${escapeHtml(dirPath)}</span>
              <span class="file-count">\${group.matches.length}</span>
              <button class="reveal-btn" title="Reveal in File Tree" data-path="\${escapeHtml(group.path)}" data-connection="\${escapeHtml(group.connectionId)}">📍</button>
            </div>
            <div class="match-list \${isExpanded ? 'expanded' : ''}" data-file-key="\${escapeHtml(fileKey)}">
              \${group.matches.map(match => \`
                <div class="match-item" data-path="\${escapeHtml(match.path)}" data-connection="\${escapeHtml(match.connectionId)}" data-line="\${match.line || ''}">
                  <span class="match-line">\${match.line || ''}</span>
                  <span class="match-text">\${highlightMatch(match.match || '', displayQuery, caseSensitive)}</span>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }

      if (multiServer) {
        // Group file groups by server - pre-populate from currentDisplayScopeServers so all servers appear
        const serverGroups = {};
        for (const ss of currentDisplayScopeServers) {
          serverGroups[ss.id] = { name: ss.name, id: ss.id, files: [] };
        }
        for (const group of fileGroups) {
          if (!serverGroups[group.connectionId]) {
            serverGroups[group.connectionId] = { name: group.connectionName, id: group.connectionId, files: [] };
          }
          serverGroups[group.connectionId].files.push(group);
        }

        resultsContainer.innerHTML = Object.values(serverGroups).map(server => {
          const serverKey = 'server:' + server.id;
          const isServerExpanded = !expandedFiles.has(serverKey + ':collapsed');
          const totalMatches = server.files.reduce((sum, f) => sum + f.matches.length, 0);

          return \`
            <div class="server-group" data-server-key="\${escapeHtml(serverKey)}">
              <div class="server-header" data-server-key="\${escapeHtml(serverKey)}">
                <span class="chevron \${isServerExpanded ? '' : 'collapsed'}">▼</span>
                <span class="server-icon">🖥️</span>
                <span class="server-name">\${escapeHtml(server.name)}</span>
                <span class="server-count">\${totalMatches} result\${totalMatches !== 1 ? 's' : ''} in \${server.files.length} file\${server.files.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="server-files \${isServerExpanded ? 'expanded' : ''}" data-server-key="\${escapeHtml(serverKey)}">
                \${server.files.length > 0 ? server.files.map(group => renderFileGroup(group)).join('') : '<div class="no-results" style="padding: 8px 16px;">No results</div>'}
              </div>
            </div>
          \`;
        }).join('');
      } else {
        resultsContainer.innerHTML = fileGroups.map(group => renderFileGroup(group)).join('');
      }

      // Add click handlers for server headers (toggle expand/collapse)
      resultsContainer.querySelectorAll('.server-header').forEach(header => {
        header.addEventListener('click', () => {
          const serverKey = header.dataset.serverKey;
          const serverGroup = header.closest('.server-group');
          const serverFiles = serverGroup.querySelector('.server-files');
          const chevron = header.querySelector('.chevron');
          const collapseKey = serverKey + ':collapsed';

          if (expandedFiles.has(collapseKey)) {
            expandedFiles.delete(collapseKey);
            serverFiles.classList.add('expanded');
            chevron.classList.remove('collapsed');
          } else {
            expandedFiles.add(collapseKey);
            serverFiles.classList.remove('expanded');
            chevron.classList.add('collapsed');
          }
        });
      });

      // Add click handlers for file headers (toggle expand/collapse)
      resultsContainer.querySelectorAll('.file-header').forEach(header => {
        header.addEventListener('click', (e) => {
          const fileKey = header.dataset.fileKey;
          const group = header.closest('.file-group');
          const matchList = group.querySelector('.match-list');
          const chevron = header.querySelector('.chevron');

          if (expandedFiles.has(fileKey)) {
            expandedFiles.delete(fileKey);
            matchList.classList.remove('expanded');
            chevron.classList.add('collapsed');
          } else {
            expandedFiles.add(fileKey);
            matchList.classList.add('expanded');
            chevron.classList.remove('collapsed');
          }
        });
      });

      // Add click handlers for reveal buttons
      resultsContainer.querySelectorAll('.reveal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = btn.dataset.path;
          const connectionId = btn.dataset.connection;
          vscode.postMessage({
            type: 'revealInTree',
            result: { path, connectionId }
          });
        });
      });

      addMatchClickHandlers();
    }

    // Build tree structure from file groups
    function buildTree(fileGroups) {
      const tree = {};

      for (const group of fileGroups) {
        const parts = group.path.split('/').filter(Boolean);
        let current = tree;

        // Build directory structure
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (!current[part]) {
            current[part] = { _isDir: true, _children: {}, _matches: [], _connectionId: group.connectionId };
          }
          current = current[part]._children;
        }

        // Add file
        const fileName = parts[parts.length - 1] || group.path;
        current[fileName] = {
          _isDir: false,
          _path: group.path,
          _connectionId: group.connectionId,
          _matches: group.matches
        };
      }

      return tree;
    }

    // Count matches in a tree node recursively
    function countTreeMatches(node) {
      if (!node._isDir) {
        return node._matches ? node._matches.length : 0;
      }
      let count = 0;
      for (const key of Object.keys(node._children)) {
        count += countTreeMatches(node._children[key]);
      }
      return count;
    }

    // Expand all tree nodes to FILE level (used when first switching to tree view)
    // Only expands directories, not files - so matches inside files stay collapsed
    function expandAllTreeNodes(fileGroups) {
      const tree = buildTree(fileGroups);

      function collectDirectoryKeys(name, node, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;

        // Only expand directories, not files
        // Files stay collapsed so their matches don't show
        if (node._isDir) {
          expandedTreeNodes.add(nodeKey);
          for (const childName of Object.keys(node._children)) {
            collectDirectoryKeys(childName, node._children[childName], nodePath);
          }
        }
        // Don't add file nodes - they stay collapsed
      }

      // Collect directory node keys from root level
      for (const name of Object.keys(tree)) {
        collectDirectoryKeys(name, tree[name], '');
      }
    }

    // Collect tree node keys for expand state (dirs only, or dirs + files)
    function collectTreeKeys(fileGroups, includeFiles) {
      const tree = buildTree(fileGroups);
      function collect(name, node, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;
        if (node._isDir) {
          expandedTreeNodes.add(nodeKey);
          for (const childName of Object.keys(node._children)) {
            collect(childName, node._children[childName], nodePath);
          }
        } else if (includeFiles) {
          expandedTreeNodes.add(nodeKey);
        }
      }
      for (const name of Object.keys(tree)) {
        collect(name, tree[name], '');
      }
    }

    // Apply search expand state: 0=collapsed, 1=all expanded, 2=file level
    function applySearchExpandState(state, fileGroups) {
      searchExpandState = state;
      expandedTreeNodes.clear();
      expandedFiles.clear();

      if (viewMode === 'tree') {
        if (state === 0) {
          // Collapse all: servers collapsed + tree collapsed
          for (const server of currentDisplayScopeServers) {
            expandedFiles.add('server:' + server.id + ':collapsed');
          }
        } else if (state === 1) {
          // Expand all: servers expanded + dirs + files
          collectTreeKeys(fileGroups, true);
        } else {
          // File level: servers expanded + dirs only
          collectTreeKeys(fileGroups, false);
        }
      } else {
        // List view
        if (state === 0) {
          // Collapse all: servers collapsed + files collapsed
          for (const server of currentDisplayScopeServers) {
            expandedFiles.add('server:' + server.id + ':collapsed');
          }
        } else if (state === 1) {
          // Expand all: servers expanded + file match lists expanded
          for (const group of fileGroups) {
            expandedFiles.add(group.connectionId + ':' + group.path);
          }
        }
        // State 2: files clear = servers expanded, file match lists collapsed
      }
    }

    // Get expand toggle button icon based on current state
    function getExpandToggleIcon() {
      if (searchExpandState === 0) return '⊞';  // expand all
      if (searchExpandState === 1) return '≡';   // to file level
      return '⊟';                                // collapse all
    }

    // Get expand toggle button tooltip based on current state
    function getExpandToggleTitle() {
      if (searchExpandState === 0) return 'Expand All';
      if (searchExpandState === 1) return 'Collapse to File Level';
      return 'Collapse All';
    }

    // Render tree view
    function renderTreeView(fileGroups, multiServer, displayQuery) {
      function renderNode(name, node, indent, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;
        const isExpanded = expandedTreeNodes.has(nodeKey);

        if (node._isDir) {
          const matchCount = countTreeMatches(node);
          const childrenHtml = Object.keys(node._children)
            .sort((a, b) => {
              // Directories first, then files
              const aIsDir = node._children[a]._isDir;
              const bIsDir = node._children[b]._isDir;
              if (aIsDir && !bIsDir) return -1;
              if (!aIsDir && bIsDir) return 1;
              return a.localeCompare(b);
            })
            .map(childName => renderNode(childName, node._children[childName], indent + 1, nodePath))
            .join('');

          return \`
            <div class="tree-node tree-folder" data-node-key="\${escapeHtml(nodeKey)}">
              <div class="tree-folder-header" style="--indent: \${indent};" data-node-key="\${escapeHtml(nodeKey)}">
                <span class="chevron \${isExpanded ? '' : 'collapsed'}">▼</span>
                <span class="tree-folder-icon">\${isExpanded ? '📂' : '📁'}</span>
                <span class="tree-folder-name">\${escapeHtml(name)}</span>
                <span class="tree-folder-count">(\${matchCount})</span>
              </div>
              <div class="tree-folder-children \${isExpanded ? 'expanded' : ''}" data-node-key="\${escapeHtml(nodeKey)}">
                \${childrenHtml}
              </div>
            </div>
          \`;
        } else {
          // File node
          const matchCount = node._matches ? node._matches.length : 0;
          const matchesHtml = node._matches ? node._matches.map(match => \`
            <div class="tree-match-item" data-path="\${escapeHtml(match.path)}" data-connection="\${escapeHtml(match.connectionId)}" data-line="\${match.line || ''}">
              <span class="match-line">\${match.line || ''}</span>
              <span class="match-text">\${highlightMatch(match.match || '', displayQuery, caseSensitive)}</span>
            </div>
          \`).join('') : '';

          return \`
            <div class="tree-node" data-node-key="\${escapeHtml(nodeKey)}">
              <div class="tree-file" style="--indent: \${indent};" data-node-key="\${escapeHtml(nodeKey)}" data-path="\${escapeHtml(node._path)}" data-connection="\${escapeHtml(node._connectionId)}">
                <span class="chevron \${isExpanded ? '' : 'collapsed'}">▼</span>
                <span class="tree-file-icon">📄</span>
                <span class="tree-file-name">\${escapeHtml(name)}</span>
                <span class="tree-file-count">\${matchCount}</span>
                <button class="reveal-btn" title="Reveal in File Tree" data-path="\${escapeHtml(node._path)}" data-connection="\${escapeHtml(node._connectionId)}">📍</button>
              </div>
              <div class="tree-matches \${isExpanded ? 'expanded' : ''}" style="--indent: \${indent};" data-node-key="\${escapeHtml(nodeKey)}">
                \${matchesHtml}
              </div>
            </div>
          \`;
        }
      }

      // Render a tree structure into HTML
      function renderTree(tree) {
        return Object.keys(tree)
          .sort((a, b) => {
            const aIsDir = tree[a]._isDir;
            const bIsDir = tree[b]._isDir;
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.localeCompare(b);
          })
          .map(name => renderNode(name, tree[name], 0, ''))
          .join('');
      }

      if (multiServer) {
        // Group file groups by server - pre-populate from currentDisplayScopeServers so all servers appear
        const serverGroups = {};
        for (const ss of currentDisplayScopeServers) {
          serverGroups[ss.id] = { name: ss.name, id: ss.id, files: [] };
        }
        for (const group of fileGroups) {
          if (!serverGroups[group.connectionId]) {
            serverGroups[group.connectionId] = { name: group.connectionName, id: group.connectionId, files: [] };
          }
          serverGroups[group.connectionId].files.push(group);
        }

        resultsContainer.innerHTML = Object.values(serverGroups).map(server => {
          const serverKey = 'server:' + server.id;
          const isServerExpanded = !expandedFiles.has(serverKey + ':collapsed');
          const totalMatches = server.files.reduce((sum, f) => sum + f.matches.length, 0);
          const serverTree = buildTree(server.files);

          return \`
            <div class="server-group" data-server-key="\${escapeHtml(serverKey)}">
              <div class="server-header" data-server-key="\${escapeHtml(serverKey)}">
                <span class="chevron \${isServerExpanded ? '' : 'collapsed'}">▼</span>
                <span class="server-icon">🖥️</span>
                <span class="server-name">\${escapeHtml(server.name)}</span>
                <span class="server-count">\${totalMatches} result\${totalMatches !== 1 ? 's' : ''} in \${server.files.length} file\${server.files.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="server-files \${isServerExpanded ? 'expanded' : ''}" data-server-key="\${escapeHtml(serverKey)}">
                \${server.files.length > 0 ? renderTree(serverTree) : '<div class="no-results" style="padding: 8px 16px;">No results</div>'}
              </div>
            </div>
          \`;
        }).join('');
      } else {
        const tree = buildTree(fileGroups);
        resultsContainer.innerHTML = renderTree(tree);
      }

      // Add server header click handlers
      resultsContainer.querySelectorAll('.server-header').forEach(header => {
        header.addEventListener('click', () => {
          const serverKey = header.dataset.serverKey;
          const serverGroup = header.closest('.server-group');
          const serverFiles = serverGroup.querySelector('.server-files');
          const chevron = header.querySelector('.chevron');
          const collapseKey = serverKey + ':collapsed';

          if (expandedFiles.has(collapseKey)) {
            expandedFiles.delete(collapseKey);
            serverFiles.classList.add('expanded');
            chevron.classList.remove('collapsed');
          } else {
            expandedFiles.add(collapseKey);
            serverFiles.classList.remove('expanded');
            chevron.classList.add('collapsed');
          }
        });
      });

      // Add tree click handlers
      resultsContainer.querySelectorAll('.tree-folder-header').forEach(header => {
        header.addEventListener('click', (e) => {
          const nodeKey = header.dataset.nodeKey;
          const folder = header.closest('.tree-folder');
          const children = folder.querySelector('.tree-folder-children');
          const chevron = header.querySelector('.chevron');
          const icon = header.querySelector('.tree-folder-icon');

          if (expandedTreeNodes.has(nodeKey)) {
            expandedTreeNodes.delete(nodeKey);
            children.classList.remove('expanded');
            chevron.classList.add('collapsed');
            icon.textContent = '📁';
          } else {
            expandedTreeNodes.add(nodeKey);
            children.classList.add('expanded');
            chevron.classList.remove('collapsed');
            icon.textContent = '📂';
          }
        });
      });

      resultsContainer.querySelectorAll('.tree-file').forEach(file => {
        file.addEventListener('click', (e) => {
          const nodeKey = file.dataset.nodeKey;
          const node = file.closest('.tree-node');
          const matches = node.querySelector('.tree-matches');
          const chevron = file.querySelector('.chevron');

          if (expandedTreeNodes.has(nodeKey)) {
            expandedTreeNodes.delete(nodeKey);
            matches.classList.remove('expanded');
            chevron.classList.add('collapsed');
          } else {
            expandedTreeNodes.add(nodeKey);
            matches.classList.add('expanded');
            chevron.classList.remove('collapsed');
          }
        });
      });

      addMatchClickHandlers();
    }

    // Add click handlers for match items (shared by both views)
    function addMatchClickHandlers() {
      resultsContainer.querySelectorAll('.match-item, .tree-match-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = item.dataset.path;
          const connectionId = item.dataset.connection;
          const line = item.dataset.line ? parseInt(item.dataset.line) : undefined;

          vscode.postMessage({
            type: 'openResult',
            result: { path, connectionId },
            line
          });
        });
      });

      // Add click handlers for reveal buttons (shared by both views)
      resultsContainer.querySelectorAll('.reveal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = btn.dataset.path;
          const connectionId = btn.dataset.connection;
          vscode.postMessage({
            type: 'revealInTree',
            result: { path, connectionId }
          });
        });
      });
    }

    // Show no results
    // Tab bar for kept/pinned results
    function renderTabBar() {
      if (resultTabs.length === 0) {
        resultTabBar.style.display = 'none';
        return;
      }
      resultTabBar.style.display = 'flex';
      let html = '';
      // Kept tabs
      for (const tab of resultTabs) {
        const isActive = activeTabId === tab.id;
        const indicator = tab.searching ? ' \u27F3' : '';
        const label = '"' + escapeHtml(tab.query.substring(0, 20)) + (tab.query.length > 20 ? '...' : '') + '" (' + tab.results.length + ')' + indicator;
        html += '<div class="result-tab' + (isActive ? ' active' : '') + (tab.searching ? ' searching' : '') + '" data-tab-id="' + escapeHtml(tab.id) + '" title="Search: ' + escapeHtml(tab.query) + '">';
        html += '<span class="tab-label">' + label + '</span>';
        html += '<button class="tab-close" data-tab-id="' + escapeHtml(tab.id) + '" title="Close">\\u00D7</button>';
        html += '</div>';
      }
      // Current/live tab (always last)
      const isCurrentActive = !activeTabId;
      const currentIndicator = currentTab.searching ? ' \u27F3' : '';
      html += '<div class="result-tab' + (isCurrentActive ? ' active' : '') + (currentTab.searching ? ' searching' : '') + '" data-tab-id="current">';
      html += '<span class="tab-label">Current' + currentIndicator + '</span>';
      html += '</div>';
      resultTabBar.innerHTML = html;

      // Wire tab click handlers
      resultTabBar.querySelectorAll('.result-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          // Close button
          if (e.target.classList.contains('tab-close')) {
            const tabId = e.target.dataset.tabId;
            const closedTab = resultTabs.find(function(t) { return t.id === tabId; });
            if (closedTab) {
              // LITE: cancel the server-side search if this tab owns it
              if (closedTab.searching) {
                vscode.postMessage({ type: 'cancel' });
              }
              // Clean up routing
              if (closedTab.searchId) delete tabSearchIdMap[closedTab.searchId];
              // LITE: free memory
              cleanupTab(closedTab);
            }
            resultTabs = resultTabs.filter(function(t) { return t.id !== tabId; });
            if (activeTabId === tabId) {
              activeTabId = null;
              restoreTabState(currentTab);
            }
            renderTabBar();
            renderResults();
            return;
          }
          // Tab selection — save outgoing, restore incoming
          const tabId = tab.dataset.tabId;
          saveCurrentInputState();
          if (tabId === 'current') {
            activeTabId = null;
            restoreTabState(currentTab);
          } else {
            activeTabId = tabId;
            const targetTab = resultTabs.find(function(t) { return t.id === tabId; });
            if (targetTab) restoreTabState(targetTab);
          }
          renderTabBar();
          renderResults();
        });
      });
    }

    function showNoResults() {
      resultsHeader.style.display = 'none';
      const hasAnyScope = scopes.length > 0 || serverList.some(s => s.checked && !s.disabled);
      if (searchInput.value.trim() && hasAnyScope) {
        resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
      } else if (!hasAnyScope) {
        resultsContainer.innerHTML = '<div class="no-results">Select a server to search</div>';
      } else {
        resultsContainer.innerHTML = '';
      }
    }

    // Show searching state
    function showSearching(query) {
      resultsHeader.style.display = 'none';
      resultsContainer.innerHTML = '<div class="searching">Searching...</div>';
    }

    // Escape HTML
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Highlight search query in match text
    function highlightMatch(text, query, isCaseSensitive) {
      if (!query || !text) {
        return escapeHtml(text);
      }

      // Escape query for regex special chars if not using regex mode
      const escapedQuery = query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const flags = isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp('(' + escapedQuery + ')', flags);

      // Split text by matches and rebuild with highlights
      const parts = text.split(regex);
      return parts.map((part, i) => {
        const escaped = escapeHtml(part);
        // Odd indices are matches (due to capture group)
        if (i % 2 === 1) {
          return '<span class="match-highlight">' + escaped + '</span>';
        }
        return escaped;
      }).join('');
    }

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'state':
          scopes = message.scopes || [];
          serverList = message.serverList || [];
          if (message.globalMaxSearchProcesses !== undefined) {
            globalMaxSearchProcesses = message.globalMaxSearchProcesses;
          }
          if (message.findFilesMode !== undefined) {
            findFilesMode = message.findFilesMode;
            currentTab.findFilesMode = findFilesMode;
            findFilesBtn.classList.toggle('active', findFilesMode);
            searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
          }
          if (message.sortOrder) {
            sortOrder = message.sortOrder;
            sortToggleBtn.innerHTML = sortOrder === 'checked' ? '\\u2191checked' : '\\u2191name';
            sortToggleBtn.title = sortOrder === 'checked'
              ? 'Sort: servers with search paths first'
              : 'Sort: alphabetical by name';
          }
          renderServers();
          // Update button visibility based on search state
          if (message.isSearching) {
            searchBtn.style.display = 'none';
            cancelBtn.style.display = 'inline-block';
          } else {
            searchBtn.style.display = 'inline-block';
            cancelBtn.style.display = 'none';
            // Clear stale "Searching..." message when no search is running
            if (resultsContainer.querySelector('.searching')) {
              resultsContainer.innerHTML = '';
            }
          }
          break;

        case 'searching':
          // Mark any kept tabs still searching as done (old search aborted)
          for (var si = 0; si < resultTabs.length; si++) { if (resultTabs[si].searching) resultTabs[si].searching = false; }
          tabSearchIdMap = {};

          currentSearchId = message.searchId || 0;
          // Update currentTab state for the new search
          currentTab.searchId = currentSearchId;
          currentTab.searching = true;
          currentTab.results = [];
          currentTab.query = message.query || '';
          currentTab.scopeServers = message.scopeServers || [];
          currentTab.searchExpandState = 2;
          currentTab.expandedFiles = new Set();
          currentTab.expandedTreeNodes = new Set();
          currentTab.treeViewFirstExpand = true;
          // Save include/exclude from input fields into currentTab
          currentTab.include = includeInput.value;
          currentTab.exclude = excludeInput.value;

          // Reset per-tab aliases
          searchExpandState = 2;
          expandedFiles = new Set();
          expandedTreeNodes = new Set();
          treeViewFirstExpand = true;

          // Switch to Current tab to see results
          if (activeTabId) {
            saveCurrentInputState();
            activeTabId = null;
            restoreTabState(currentTab);
          }
          renderTabBar();
          showSearching(message.query);
          searchBtn.style.display = 'none';
          cancelBtn.style.display = 'inline-block';
          break;

        case 'searchBatch': {
          var msgSearchId = message.searchId;

          // 1. Check if routed to a kept tab
          var targetTabId = tabSearchIdMap[msgSearchId];
          if (targetTabId) {
            var batchTab = resultTabs.find(function(t) { return t.id === targetTabId; });
            if (batchTab) {
              if (message.results && message.results.length > 0) batchTab.results = batchTab.results.concat(message.results);
              batchTab.hitLimit = message.hitLimit || batchTab.hitLimit;
              if (message.done) {
                batchTab.searching = false;
                delete tabSearchIdMap[msgSearchId];
              }
              if (activeTabId === targetTabId) {
                debouncedRenderResults(batchTab.hitLimit, batchTab.limit, message.done,
                  message.completedCount, message.totalCount);
              } else {
                renderTabBar(); // update count in tab label
              }
              break;
            }
          }

          // 2. Stale message check
          if (msgSearchId && msgSearchId !== currentSearchId) break;

          // 3. Normal current-tab handling — append to currentTab.results
          if (message.results && message.results.length > 0) currentTab.results = currentTab.results.concat(message.results);
          currentTab.hitLimit = message.hitLimit || currentTab.hitLimit;
          if (message.done) {
            currentTab.searching = false;
          }
          // Only re-render if viewing Current tab
          if (!activeTabId) {
            debouncedRenderResults(message.hitLimit, message.limit, message.done,
              message.completedCount, message.totalCount);
          }
          if (message.done) {
            searchBtn.style.display = 'inline-block';
            cancelBtn.style.display = 'none';
          }
          break;
        }

        case 'results': {
          // Check routing map for kept tabs
          var resMsgSearchId = message.searchId;
          var resTargetTabId = tabSearchIdMap[resMsgSearchId];
          if (resTargetTabId) {
            var resTab = resultTabs.find(function(t) { return t.id === resTargetTabId; });
            if (resTab) {
              resTab.results = message.results || [];
              resTab.query = message.query || '';
              resTab.scopeServers = message.scopeServers || [];
              resTab.hitLimit = message.hitLimit || false;
              resTab.limit = message.limit || 2000;
              resTab.searching = false;
              delete tabSearchIdMap[resMsgSearchId];
              if (activeTabId === resTargetTabId) {
                renderResults(message.hitLimit, message.limit);
              } else {
                renderTabBar();
              }
              searchBtn.style.display = 'inline-block';
              cancelBtn.style.display = 'none';
              break;
            }
          }
          // Stale message check
          if (resMsgSearchId && resMsgSearchId !== currentSearchId) break;
          // Current tab handling
          currentTab.results = message.results || [];
          currentTab.query = message.query || '';
          currentTab.scopeServers = message.scopeServers || [];
          currentTab.hitLimit = message.hitLimit || false;
          currentTab.limit = message.limit || 2000;
          currentTab.searching = false;
          currentTab.searchExpandState = 2;
          currentTab.expandedFiles = new Set();
          currentTab.expandedTreeNodes = new Set();
          currentTab.treeViewFirstExpand = true;
          // Reset per-tab aliases
          searchExpandState = 2;
          expandedFiles = new Set();
          expandedTreeNodes = new Set();
          treeViewFirstExpand = true;
          if (!activeTabId) {
            renderResults(message.hitLimit, message.limit);
          }
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          break;
        }

        case 'searchCancelled':
          for (var ci = 0; ci < resultTabs.length; ci++) { if (resultTabs[ci].searching) resultTabs[ci].searching = false; }
          tabSearchIdMap = {};
          currentTab.searching = false;
          if (!activeTabId) {
            resultsHeader.style.display = 'none';
            resultsContainer.innerHTML = '<div class="no-results">Search cancelled</div>';
          }
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          renderTabBar();
          break;

        case 'error':
          resultsHeader.style.display = 'none';
          resultsContainer.innerHTML = '<div class="no-results">Error: ' + escapeHtml(message.message) + '</div>';
          // Hide cancel button, show search button
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          break;

        case 'systemDirsExcluded': {
          // Show dismissible notice about excluded system directories
          const dirs = (message.dirs || []).join(', ');
          const notice = document.createElement('div');
          notice.className = 'system-dirs-notice';
          notice.innerHTML = '\\u2139\\uFE0F System directories excluded: ' + escapeHtml(dirs) +
            ' <a href="#" class="include-all-link">Include all</a>' +
            ' <button class="notice-dismiss" title="Dismiss">\\u00D7</button>';
          // Insert before results container
          const resultsArea = resultsContainer.parentElement;
          if (resultsArea) {
            // Remove existing notice if any
            const old = resultsArea.querySelector('.system-dirs-notice');
            if (old) old.remove();
            resultsArea.insertBefore(notice, resultsContainer);
          }
          // Wire dismiss button
          notice.querySelector('.notice-dismiss').addEventListener('click', () => notice.remove());
          // Wire "Include all" link (re-search without system dir exclusion)
          notice.querySelector('.include-all-link').addEventListener('click', (e) => {
            e.preventDefault();
            notice.remove();
            vscode.postMessage({ type: 'searchIncludeSystemDirs' });
          });
          break;
        }

        case 'focusInput':
          searchInput.focus();
          searchInput.select();
          break;
      }
    });

    // Initialize
    init();
  </script>
</body>
</html>`;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    if (this.panel) {
      this.panel.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    SearchPanel.instance = undefined;
  }
}
