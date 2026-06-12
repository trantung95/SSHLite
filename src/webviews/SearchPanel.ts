import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { IHostConfig } from '../types';
import { SavedCredential } from '../services/CredentialService';
import { formatFileSize, formatRelativeTime } from '../utils/helpers';
import { ActivityService } from '../services/ActivityService';
import { FilenameIndexService } from '../services/FilenameIndexService';
import { infoLog, diagLog, isDiagEnabled } from '../utils/diagnosticLog';

/** Default exclude patterns matching VS Code's files.exclude + search.exclude defaults */
const DEFAULT_SEARCH_EXCLUDES = '.git,.svn,.hg,CVS,.DS_Store,node_modules,bower_components,*.code-search';

/** Human "X ago" for the indexed-search staleness hint, given an age in ms. */
function formatIndexAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown age';
  const min = Math.floor(ageMs / 60000);
  if (min < 1) return 'just updated';
  if (min < 60) return `${min}m old`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h old`;
  return `${Math.floor(hr / 24)}d old`;
}

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
  | { type: 'search'; query: string; include: string; exclude: string; caseSensitive: boolean; regex: boolean; findFiles?: boolean; wholeWord?: boolean; useIndex?: boolean }
  | { type: 'removeScope'; index: number }
  | { type: 'clearScopes' }
  | { type: 'openResult'; result: WebviewSearchResult; line?: number }
  | { type: 'revealInTree'; result: WebviewSearchResult }
  | { type: 'increaseLimit' }
  | { type: 'cancelSearch'; searchId?: number }
  | { type: 'keepSearch'; searchId: number }
  | { type: 'ready' }
  | { type: 'toggleServer'; serverId: string; checked: boolean }
  | { type: 'removeServerPath'; serverId: string; pathIndex: number }
  | { type: 'addServerPath'; serverId: string; path: string }
  | { type: 'toggleSort' }
  | { type: 'setServerMaxProcesses'; serverId: string; value: number | null }
  | { type: 'log'; level: 'info' | 'diag'; scope: string; event: string; payload?: Record<string, unknown> }
  | { type: 'webviewError'; message: string; stack?: string };

/**
 * SearchPanel - VS Code native-style search webview
 */
export class SearchPanel {
  private static instance: SearchPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  // State
  private searchScopes: SearchScope[] = [];
  private lastSearchQuery: string = '';
  private lastIncludePattern: string = '';
  private lastExcludePattern: string = '';
  private lastCaseSensitive: boolean = false;
  private lastRegex: boolean = false;
  private lastWholeWord: boolean = false;
  private currentSearchId: number = 0;

  // Per-search tracking: each active search has its own abort controller and activity IDs
  private activeSearches: Map<number, {
    abortController: AbortController;
    activityIds: string[];
    kept: boolean; // true after "Keep Results" — don't abort when new search starts
  }> = new Map();

  // Hard global cap on simultaneously-active search workers across ALL servers and
  // ALL active searches. With per-server worker pools, a user with 5 servers and
  // searchParallelProcesses=5 would otherwise spin up 25 SSH grep operations in
  // parallel, saturating the event loop and tripping VS Code's extension-host
  // watchdog (which kills the host after ~10s of unresponsiveness — no JS
  // exception surfaces, the process is just gone). 10 is a deliberate ceiling
  // chosen so behavior is robust without being so restrictive that single-server
  // searches feel slow.
  private static readonly MAX_GLOBAL_SEARCH_WORKERS = 10;

  /** Sum active workers across all per-pool entries — used by the global cap. */
  private totalActiveSearchWorkers(): number {
    let total = 0;
    for (const pool of this.activeWorkerPools.values()) {
      total += pool.activeWorkerCount;
    }
    return total;
  }

  private lastSearchConnectionMap: Map<string, SSHConnection> = new Map();

  // Dynamic worker pool tracking (allows mid-search worker count adjustment)
  private activeWorkerPools: Map<string, {
    desiredWorkerCount: number;
    fullWorkerCount: number;       // Unthrottled target (before priority/multi-search division)
    activeWorkerCount: number;
    addWorker: () => void;
  }> = new Map();

  // Pool metadata: maps poolKey → connectionId and poolKey → searchId
  private poolConnectionMap: Map<string, string> = new Map();
  private searchPoolMap: Map<string, number> = new Map();

  // Priority throttling (shared across all active searches)
  private priorityThrottleDisposable: vscode.Disposable | null = null;
  private _updateSearchPriority: (() => void) | null = null;

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

  /** Whether any search is currently running */
  private get isSearching(): boolean {
    return this.activeSearches.size > 0;
  }

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
    infoLog('search-panel', 'show', {
      hasPanel: !!this.panel,
      scopeCount: this.searchScopes.length,
      serverCount: this.serverList.length,
    });
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    if (!this.extensionContext) {
      throw new Error('SearchPanel.show() called before extensionContext was set — call loadSortOrder(context) first');
    }
    this.panel = vscode.window.createWebviewPanel(
      'sshLiteSearch',
      'Search',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'search'),
        ],
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

    // Note: 'ready' message is already handled by handleMessage() above (case 'ready': this.sendState())
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
   * Set up priority throttling: reduces search workers when user has active non-search
   * operations, and divides workers equally among concurrent searches per connection.
   * Returns a Disposable to stop listening.
   */
  private _setupSearchPriorityThrottling(): vscode.Disposable {
    const activityService = ActivityService.getInstance();
    const USER_OP_TYPES = new Set([
      'download', 'upload', 'directory-load', 'file-refresh', 'terminal', 'monitor', 'connect',
    ]);

    const updatePriority = () => {
      // Count active searches per connection
      const searchesPerConnection = new Map<string, Set<number>>();
      for (const [poolKey] of this.activeWorkerPools) {
        const connId = this.poolConnectionMap.get(poolKey);
        const sid = this.searchPoolMap.get(poolKey);
        if (connId && sid !== undefined) {
          if (!searchesPerConnection.has(connId)) searchesPerConnection.set(connId, new Set());
          searchesPerConnection.get(connId)!.add(sid);
        }
      }

      for (const [poolKey, pool] of this.activeWorkerPools) {
        const connectionId = this.poolConnectionMap.get(poolKey);
        if (!connectionId) continue;

        // Step 1: Divide by concurrent search count on this connection
        const searchCount = searchesPerConnection.get(connectionId)?.size || 1;
        let effectiveCount = Math.max(1, Math.ceil(pool.fullWorkerCount / searchCount));

        // Step 2: Further throttle if user has active non-search operations
        const hasUserOps = activityService
          .getActivitiesForConnection(connectionId)
          .some(a => a.status === 'running' && USER_OP_TYPES.has(a.type));
        if (hasUserOps) {
          effectiveCount = 1;
        }

        // Apply (only if changed)
        if (pool.desiredWorkerCount !== effectiveCount) {
          pool.desiredWorkerCount = effectiveCount;
          if (effectiveCount > pool.activeWorkerCount) {
            // Respect the global cap: stop spawning if we already hit the
            // total-active-workers ceiling across all pools.
            while (
              pool.activeWorkerCount < effectiveCount &&
              this.totalActiveSearchWorkers() < SearchPanel.MAX_GLOBAL_SEARCH_WORKERS
            ) {
              pool.addWorker();
            }
          }
          // If decreasing, workers self-terminate via the guard check
        }
      }
    };

    // Store for external calls (pool add/remove, manual worker count change)
    this._updateSearchPriority = updatePriority;

    const disposable = activityService.onDidChangeActivities(updatePriority);
    updatePriority();
    return disposable;
  }

  /**
   * Cancel ongoing search(es).
   * @param searchId If provided, cancel only that specific search (for kept-tab close).
   *                 If omitted, cancel ALL active searches.
   */
  public cancelSearch(searchId?: number): void {
    const activityService = ActivityService.getInstance();
    const wasSearching = this.isSearching;

    if (searchId !== undefined) {
      // Cancel a specific (kept) search
      const search = this.activeSearches.get(searchId);
      if (search) {
        search.abortController.abort();
        for (const id of search.activityIds) activityService.cancelActivity(id);
        this.activeSearches.delete(searchId);
      }
      // Clean up pools owned by this search
      for (const [key, sid] of [...this.searchPoolMap]) {
        if (sid === searchId) {
          this.activeWorkerPools.delete(key);
          this.poolConnectionMap.delete(key);
          this.searchPoolMap.delete(key);
        }
      }
    } else {
      // Cancel ALL active searches
      for (const [, search] of this.activeSearches) {
        search.abortController.abort();
        for (const id of search.activityIds) activityService.cancelActivity(id);
      }
      this.activeSearches.clear();
      this.activeWorkerPools.clear();
      this.poolConnectionMap.clear();
      this.searchPoolMap.clear();
    }

    // Recalculate priority after pool changes
    this._updateSearchPriority?.();

    // Clean up priority throttling if no more searches
    if (this.activeSearches.size === 0 && this.priorityThrottleDisposable) {
      this.priorityThrottleDisposable.dispose();
      this.priorityThrottleDisposable = null;
      this._updateSearchPriority = null;
    }

    if (wasSearching && !this.isSearching) {
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
      wholeWord: this.lastWholeWord,
      sortOrder: this.sortOrder,
      globalMaxSearchProcesses: vscode.workspace.getConfiguration('sshLite').get<number>('searchParallelProcesses', 5),
    });
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    diagLog('search-panel', 'recv', { type: typeof message?.type === 'string' ? message.type : 'unknown' });
    switch (message.type) {
      case 'log': {
        const level = message.level === 'diag' ? 'diag' : 'info';
        const scope = typeof message.scope === 'string' ? message.scope : 'search-webview';
        const event = typeof message.event === 'string' ? message.event : 'unknown';
        const payload = (message.payload && typeof message.payload === 'object') ? message.payload : undefined;
        if (level === 'info') {
          infoLog(scope, event, payload);
        } else {
          diagLog(scope, event, payload);
        }
        break;
      }

      case 'webviewError': {
        infoLog('search-panel', 'webview-error', {
          message: typeof message.message === 'string' ? message.message : '(no message)',
          stack: typeof message.stack === 'string' ? message.stack.slice(0, 1000) : undefined,
        });
        break;
      }

      case 'search':
        await this.performSearch(message.query, message.include, message.exclude, message.caseSensitive, message.regex, message.findFiles, message.wholeWord, message.useIndex);
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
        this.cancelSearch(message.searchId);
        break;

      case 'keepSearch': {
        const kept = this.activeSearches.get(message.searchId);
        if (kept) kept.kept = true;
        break;
      }

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

      case 'setServerMaxProcesses': {
        const targetServer = this.serverList.find((s) => s.id === message.serverId);
        if (targetServer) {
          if (message.value === null) {
            // Clear override — use global default
            targetServer.maxSearchProcesses = undefined;
          } else {
            // Clamp to min 1, max 50
            targetServer.maxSearchProcesses = Math.max(1, Math.min(50, message.value));
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
            ?? vscode.workspace.getConfiguration('sshLite').get<number>('searchParallelProcesses', 5);
          const clampedCount = Math.max(1, newCount);
          for (const [poolKey, pool] of this.activeWorkerPools) {
            if (poolKey.startsWith(message.serverId + ':')) {
              pool.fullWorkerCount = clampedCount;
            }
          }
          // Let priority throttling recalculate effective counts (respects multi-search division + user ops)
          this._updateSearchPriority?.();
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
    findFiles?: boolean,
    wholeWord?: boolean,
    useIndex?: boolean
  ): Promise<void> {
    // Determine which model to use: serverList (new) or searchScopes (legacy)
    // Checked servers without explicit paths default to searching from /
    const checkedServers = this.serverList.filter((s) => s.checked && !s.disabled);
    const useServerList = checkedServers.length > 0;

    if (!query.trim() || (!useServerList && this.searchScopes.length === 0)) {
      this.postMessage({ type: 'results', results: [], query: '' });
      return;
    }

    // Cancel any un-kept current search (kept searches continue in background)
    for (const [id, search] of [...this.activeSearches]) {
      if (!search.kept) {
        search.abortController.abort();
        this.activeSearches.delete(id);
      }
    }

    const abortController = new AbortController();
    const signal = abortController.signal;
    const searchId = ++this.currentSearchId;
    this.activeSearches.set(searchId, { abortController, activityIds: [], kept: false });
    const searchActivityIds = this.activeSearches.get(searchId)!.activityIds;

    // Start priority throttling if not already running (shared across concurrent searches)
    if (!this.priorityThrottleDisposable) {
      this.priorityThrottleDisposable = this._setupSearchPriorityThrottling();
    }

    this.lastSearchQuery = query;
    this.lastIncludePattern = includePattern;
    this.lastExcludePattern = excludePattern;
    this.lastCaseSensitive = caseSensitive;
    this.lastRegex = regex;
    this.lastWholeWord = !!wholeWord;
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
    // 'auto' lets each connection probe for ripgrep/fd/parallel-grep and use the
    // fastest tool with automatic grep/find fallback; 'off' forces grep/find.
    const nativeTools = config.get<'auto' | 'off'>('searchNativeTools', 'auto');

    // Apply default exclusions (VS Code-style: .git, node_modules, etc.)
    const useDefaultExcludes = config.get<boolean>('searchUseDefaultExcludes', true);
    const effectiveExcludePattern = useDefaultExcludes
      ? (excludePattern ? `${DEFAULT_SEARCH_EXCLUDES},${excludePattern}` : DEFAULT_SEARCH_EXCLUDES)
      : excludePattern;

    const activityService = ActivityService.getInstance();
    const autoConnectedIds = new Set<string>();
    const serverResults = new Map<string, number>(); // connectionId -> result count

    try {
      if (useServerList) {
        // === New serverList-based search ===
        infoLog('search', 'begin', { mode: findFiles ? 'findFiles' : 'content', query: query.slice(0, 80), servers: checkedServers.length });

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
        // Per-search counters (local — multiple searches can run concurrently)
        const globalSeen = new Set<string>();
        let completedCount = 0;
        let totalCount = 0;
        this.lastSearchConnectionMap = connectionMap;

        // Abort all workers the first time the result limit is reached. Without
        // this, workers keep dispatching new dir listings for every remaining
        // path and the extension keeps posting empty `searchBatch` messages —
        // each of which triggers a full DOM rebuild on the webview, which is
        // what historically caused the "open file + wait ~1 minute = crash"
        // symptom on wide queries against large servers. SIGTERM is wired to
        // the abortController in each worker's grep stream so remote grep
        // processes exit cleanly.
        let limitAbortFired = false;
        const maybeAbortOnLimit = () => {
          if (limitAbortFired) return;
          if (globalSeen.size < maxResults) return;
          limitAbortFired = true;
          infoLog('search', 'limit-reached-abort', {
            searchId, totalResults: globalSeen.size, limit: maxResults,
          });
          try { abortController.abort(); } catch { /* ignore */ }
        };

        const globalParallelProcesses = config.get<number>('searchParallelProcesses', 5);

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
          searchActivityIds.push(activityId);

          const searchPromise = (async (): Promise<WebviewSearchResult[]> => {
            if (signal.aborted) return [];
            try {
              let results: Awaited<ReturnType<SSHConnection['searchFiles']>> | undefined;
              let indexNote = '';

              // Opt-in indexed filename search. Single-path only. Precedence:
              // (1) client snapshot (instant, 0 round-trips, any server) →
              // (2) server plocate/locate → (3) live find. Falls through on miss.
              if (useIndex && findFiles && typeof searchPathArg === 'string') {
                const snap = FilenameIndexService.getInstance().search(connection, searchPathArg, query, caseSensitive, maxResults);
                if (snap) {
                  results = snap.results;
                  indexNote = ` [client index, ${formatIndexAge(Date.now() - snap.timestamp)}]`;
                } else {
                  const indexed = await connection.searchIndexed(searchPathArg, query, { caseSensitive, maxResults, signal });
                  if (signal.aborted) { activityService.cancelActivity(activityId); return []; }
                  if (indexed) {
                    results = indexed.results;
                    const age = indexed.dbMTimeMs ? formatIndexAge(Date.now() - indexed.dbMTimeMs) : 'unknown age';
                    indexNote = ` [${indexed.tool} index, ${age}]`;
                  } else {
                    indexNote = ' [no file index — used live find]';
                  }
                }
              }

              if (!results) {
                results = await connection.searchFiles(searchPathArg, query, {
                  searchContent: !findFiles,
                  caseSensitive,
                  regex,
                  wholeWord: !!wholeWord,
                  filePattern: includePattern || '*',
                  excludePattern: effectiveExcludePattern || undefined,
                  maxResults,
                  signal,
                  nativeTools,
                });
              }

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

              diagLog('search', 'server-result', { server: displayName, count: mapped.length, indexNote });
              activityService.completeActivity(activityId, `${mapped.length} results${indexNote}`);

              serverResults.set(server.id, (serverResults.get(server.id) || 0) + mapped.length);
              return mapped;
            } catch (error) {
              infoLog('search', 'server-failed', { server: displayName, errorMessage: (error as Error).message });
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
              // Pass glob patterns to listEntries (supports comma-separated, but not brace expansion)
              const listEntriesPattern = (includePattern && !/[{]/.test(includePattern))
                ? includePattern : undefined;

              const poolPromise = (async () => {
                const workQueue: Array<{ type: 'dir'; path: string } | { type: 'files'; filePaths: string[] }> = [];
                let workIndex = 0;
                let pendingDirListings = 0;

                workQueue.push({ type: 'dir', path: sp.path });

                totalCount += workQueue.length;
                diagLog('search', 'worker-pool-start', { path: sp.path, initialItems: workQueue.length, workers: parallelProcesses });

                // Dynamic worker tracking — always target the full configured count;
                // workers auto-exit when queue is empty and ramp up as work is discovered
                let desiredWorkerCount = parallelProcesses;
                let activeWorkerCount = 0;
                const allWorkerPromises: Promise<void>[] = [];
                const poolKey = `${server.id}:${sp.path}`;

                // Safe done check: only true when ALL work is complete (no pending dir listings, queue fully consumed)
                const isDone = () => completedCount >= totalCount && pendingDirListings === 0 && workIndex >= workQueue.length;

                const runWorker = async (): Promise<void> => {
                  activeWorkerCount++;
                  try {
                  while (!signal.aborted && globalSeen.size < maxResults) {
                    // Graceful shrink: if more workers than desired, exit (keep at least 1)
                    if (activeWorkerCount > desiredWorkerCount && activeWorkerCount > 1) return;
                    // Wait for in-flight dir listings before exiting — they may push new items
                    while (workIndex >= workQueue.length) {
                      if (pendingDirListings === 0) return; // truly done — all dirs explored
                      await new Promise(r => setTimeout(r, 50));
                    }
                    const item = workQueue[workIndex++];

                    if (item.type === 'dir') {
                      // LIST: discover files + subdirs at this level
                      pendingDirListings++;
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
                        totalCount += newItems;

                        // Ramp up workers as queue grows (initial queue may be small).
                        // Respect the global cap across all pools to avoid event-loop
                        // saturation.
                        while (
                          activeWorkerCount < desiredWorkerCount &&
                          this.totalActiveSearchWorkers() < SearchPanel.MAX_GLOBAL_SEARCH_WORKERS &&
                          workQueue.length > workIndex
                        ) {
                          addWorker();
                        }

                        // Dir listing done — decrement pending BEFORE done check
                        pendingDirListings--;
                        completedCount++;
                        if (!this.activeSearches.has(searchId)) return;
                        this.postMessage({
                          type: 'searchBatch', searchId, results: [],
                          totalResults: globalSeen.size, completedCount: completedCount, totalCount: totalCount,
                          hitLimit: false, limit: maxResults,
                          done: isDone(),
                        });
                      } catch {
                        // listEntries failed — fallback to recursive grep on this dir
                        pendingDirListings--;
                        const actId = activityService.startActivity(
                          'search', connection.id, connection.host.name,
                          `${findFiles ? 'Find' : 'Search'}: "${query.substring(0, 30)}${query.length > 30 ? '...' : ''}"`,
                          { detail: `in ${item.path} (fallback)`, cancellable: true, onCancel: () => { abortController.abort(); } }
                        );
                        searchActivityIds.push(actId);
                        try {
                          const results = await connection.searchFiles(item.path, query, {
                            searchContent: !findFiles, caseSensitive, regex, wholeWord: !!wholeWord,
                            filePattern: includePattern || '*',
                            excludePattern: effectiveExcludePattern || undefined,
                            maxResults, signal, nativeTools,
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
                          maybeAbortOnLimit();
                          completedCount++;
                          if (!this.activeSearches.has(searchId)) return;
                          await this.postSearchBatchChunked({
                            searchId, results: unique,
                            totalResults: globalSeen.size, completedCount, totalCount,
                            hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                            done: isDone(),
                          });
                        } catch (error) {
                          activityService.failActivity(actId, (error as Error).message);
                          failedScopes.push(`${server.hostConfig.name}: ${(error as Error).message}`);
                          completedCount++;
                          if (!this.activeSearches.has(searchId)) return;
                          this.postMessage({
                            type: 'searchBatch', searchId, results: [],
                            totalResults: globalSeen.size, completedCount: completedCount, totalCount: totalCount,
                            hitLimit: false, limit: maxResults,
                            done: isDone(),
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
                      searchActivityIds.push(actId);
                      try {
                        const results = await connection.searchFiles(item.filePaths, query, {
                          searchContent: !findFiles, caseSensitive, regex, wholeWord: !!wholeWord,
                          filePattern: includePattern || '*',
                          excludePattern: effectiveExcludePattern || undefined,
                          maxResults, signal, nativeTools,
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
                        maybeAbortOnLimit();
                        completedCount++;
                        if (!this.activeSearches.has(searchId)) return;
                        await this.postSearchBatchChunked({
                          searchId, results: unique,
                          totalResults: globalSeen.size, completedCount, totalCount,
                          hitLimit: globalSeen.size >= maxResults, limit: maxResults,
                          done: isDone(),
                        });
                      } catch (error) {
                        activityService.failActivity(actId, (error as Error).message);
                        failedScopes.push(`${server.hostConfig.name}: ${(error as Error).message}`);
                        completedCount++;
                        if (!this.activeSearches.has(searchId)) return;
                        this.postMessage({
                          type: 'searchBatch', searchId, results: [],
                          totalResults: globalSeen.size, completedCount: completedCount, totalCount: totalCount,
                          hitLimit: false, limit: maxResults,
                          done: isDone(),
                        });
                      }
                    }
                  }
                  } finally {
                    activeWorkerCount--;
                  }
                };

                // Register pool controller for dynamic worker adjustment
                let fullDesiredCount = parallelProcesses;
                const addWorker = () => {
                  const p = runWorker();
                  allWorkerPromises.push(p);
                };
                this.activeWorkerPools.set(poolKey, {
                  get desiredWorkerCount() { return desiredWorkerCount; },
                  set desiredWorkerCount(v: number) { desiredWorkerCount = v; },
                  get fullWorkerCount() { return fullDesiredCount; },
                  set fullWorkerCount(v: number) { fullDesiredCount = v; },
                  get activeWorkerCount() { return activeWorkerCount; },
                  addWorker,
                });
                this.poolConnectionMap.set(poolKey, server.id);
                this.searchPoolMap.set(poolKey, searchId);
                this._updateSearchPriority?.();

                // Spawn initial workers (only as many as queue items; more spawn as work is discovered)
                const initialWorkers = Math.min(desiredWorkerCount, workQueue.length);
                for (let wi = 0; wi < initialWorkers; wi++) {
                  allWorkerPromises.push(runWorker());
                }
                // Await all workers (including dynamically added ones)
                while (true) {
                  const len = allWorkerPromises.length;
                  await Promise.all(allWorkerPromises);
                  if (allWorkerPromises.length === len) break;
                }
                this.activeWorkerPools.delete(poolKey);
                this.poolConnectionMap.delete(poolKey);
                this.searchPoolMap.delete(poolKey);
                this._updateSearchPriority?.();
              })();

              workerPoolPromises.push(poolPromise);
              continue; // skip single-path fallthrough
            }

            // Single search (no parallel split or fallback)
            searchTasks.push(createSearchTask(server, connection, sp.path, sp.path));
          }
        }

        totalCount += searchTasks.length;

        // Wrap each task with .then() that sends progressive searchBatch messages
        const wrappedPromises = searchTasks.map((task) =>
          task.promise.then((batchResults) => {
            if (signal.aborted || !this.activeSearches.has(searchId)) return [];
            // Deduplicate against global set
            const unique = batchResults.filter((r) => {
              const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
              if (globalSeen.has(key)) return false;
              globalSeen.add(key);
              return true;
            });
            maybeAbortOnLimit();
            completedCount++;
            this.postMessage({
              type: 'searchBatch',
              searchId,
              results: unique,
              totalResults: globalSeen.size,
              completedCount: completedCount,
              totalCount: totalCount,
              hitLimit: globalSeen.size >= maxResults,
              limit: maxResults,
              done: completedCount >= totalCount,
            });
            return unique;
          }).catch(() => {
            if (signal.aborted || !this.activeSearches.has(searchId)) return [] as WebviewSearchResult[];
            completedCount++;
            this.postMessage({
              type: 'searchBatch',
              searchId,
              results: [],
              totalResults: globalSeen.size,
              completedCount: completedCount,
              totalCount: totalCount,
              hitLimit: false,
              limit: maxResults,
              done: completedCount >= totalCount,
            });
            return [] as WebviewSearchResult[];
          })
        );

        await Promise.all([...wrappedPromises, ...workerPoolPromises]);

        infoLog('search', 'complete', { totalResults: globalSeen.size, failedScopes: failedScopes.length });

        if (failedScopes.length > 0) {
          vscode.window.showWarningMessage(
            `Search failed for ${failedScopes.length} scope(s): ${failedScopes.join('; ')}`
          );
        }
      } else {
        // === Legacy searchScopes-based search ===
        infoLog('search', 'legacy/begin', { query: query.slice(0, 80), scopes: this.searchScopes.length });

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
          searchActivityIds.push(activityId);

          try {
            const results = await connection.searchFiles(scope.path, query, {
              searchContent: !findFiles,
              caseSensitive,
              regex,
              wholeWord: !!wholeWord,
              filePattern: includePattern || '*',
              excludePattern: effectiveExcludePattern || undefined,
              maxResults,
              signal,
              nativeTools,
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

            diagLog('search', 'legacy/scope-result', { scope: scope.displayName, count: mappedResults.length });
            activityService.completeActivity(activityId, `${mappedResults.length} results`);
            return mappedResults;
          } catch (error) {
            infoLog('search', 'legacy/scope-failed', { scope: scope.displayName, errorMessage: (error as Error).message });
            activityService.failActivity(activityId, (error as Error).message);
            failedScopes.push(`${scope.displayName}: ${(error as Error).message}`);
            return [];
          }
        });

        const allResults = (await Promise.all(searchPromises)).flat();
        infoLog('search', 'legacy/complete', { totalResults: allResults.length, failedScopes: failedScopes.length });

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
      for (const id of searchActivityIds) {
        activityService.failActivity(id, 'Search error');
      }
    } finally {
      // Clean up auto-connected servers with no results
      for (const connId of autoConnectedIds) {
        const hadResults = (serverResults.get(connId) || 0) > 0;
        if (!hadResults) {
          try {
            diagLog('search', 'auto-disconnect', { connectionId: connId, reason: 'no-results' });
            await this.autoDisconnectCallback?.(connId);
            // Update server state
            const server = this.serverList.find((s) => s.id === connId);
            if (server) {
              server.connected = false;
              server.status = undefined;
            }
          } catch (e) {
            infoLog('search', 'auto-disconnect/failed', { connectionId: connId, error: String(e) });
          }
        }
      }

      // Clean up THIS search's pools (not other concurrent searches')
      for (const [key, sid] of [...this.searchPoolMap]) {
        if (sid === searchId) {
          this.activeWorkerPools.delete(key);
          this.poolConnectionMap.delete(key);
          this.searchPoolMap.delete(key);
        }
      }
      this.activeSearches.delete(searchId);

      // Recalculate priority for remaining searches
      this._updateSearchPriority?.();

      // Clean up priority throttling if no more searches
      if (this.activeSearches.size === 0) {
        if (this.priorityThrottleDisposable) {
          this.priorityThrottleDisposable.dispose();
          this.priorityThrottleDisposable = null;
          this._updateSearchPriority = null;
        }
        this.sendState();
      }
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
  private postMessage(msg: unknown): void {
    // Gate the diag data construction behind isDiagEnabled() — JSON.stringify on
    // a 10k-result searchBatch payload allocates megabytes of string per batch,
    // and that work would happen unconditionally even when logging is off.
    if (isDiagEnabled()) {
      try {
        const m = msg as { type?: string };
        diagLog('search-panel', 'post', {
          type: m && typeof m.type === 'string' ? m.type : 'unknown',
        });
      } catch { /* never let logging break postMessage */ }
    }
    if (this.panel) {
      this.panel.webview.postMessage(msg);
    }
  }

  /**
   * Post a search batch in size-bounded chunks, yielding to the event loop
   * between each chunk. A single grep task can produce thousands of matching
   * lines (one greppable file with many hits); shipping that to the webview
   * as one IPC message serializes megabytes of JSON in a single tick. With
   * many parallel workers, the cumulative serialization work blocks the
   * event loop past VS Code's extension-host watchdog (~10s) and the host
   * is force-killed without a JS error. The chunk size is small enough that
   * each post is bounded; the yield gives VS Code's IPC and watchdog a
   * chance to make forward progress.
   */
  private async postSearchBatchChunked(args: {
    searchId: number;
    results: WebviewSearchResult[];
    totalResults: number;
    completedCount: number;
    totalCount: number;
    hitLimit: boolean;
    limit: number;
    done: boolean;
  }): Promise<void> {
    const POST_CHUNK = 500;
    const total = args.results.length;
    if (total <= POST_CHUNK) {
      this.postMessage({
        type: 'searchBatch',
        searchId: args.searchId,
        results: args.results,
        totalResults: args.totalResults,
        completedCount: args.completedCount,
        totalCount: args.totalCount,
        hitLimit: args.hitLimit,
        limit: args.limit,
        done: args.done,
      });
      await new Promise<void>((r) => setImmediate(r));
      return;
    }
    const chunkCount = Math.ceil(total / POST_CHUNK);
    for (let ci = 0; ci < chunkCount; ci++) {
      const start = ci * POST_CHUNK;
      const slice = args.results.slice(start, start + POST_CHUNK);
      const isLast = ci === chunkCount - 1;
      this.postMessage({
        type: 'searchBatch',
        searchId: args.searchId,
        results: slice,
        totalResults: args.totalResults,
        // Only the last chunk advances the visible completedCount and signals
        // done — earlier chunks keep the same count so the UI does not show
        // false "task complete" mid-task.
        completedCount: isLast ? args.completedCount : Math.max(0, args.completedCount - 1),
        totalCount: args.totalCount,
        hitLimit: isLast ? args.hitLimit : false,
        limit: args.limit,
        done: isLast ? args.done : false,
      });
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /** Generate a CSP nonce per webview load. */
  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(): string {
    if (!this.panel) {
      throw new Error('SearchPanel.getWebviewContent called before panel was created');
    }
    if (!this.extensionContext) {
      throw new Error('SearchPanel.getWebviewContent called before extensionContext was set');
    }
    const webview = this.panel.webview;
    const nonce = SearchPanel.makeNonce();
    const cspSource = webview.cspSource;

    const mediaRoot = vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'search');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));

    const csp = [
      `default-src 'none'`,
      `script-src ${cspSource} 'nonce-${nonce}'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data:`,
      `font-src ${cspSource}`,
    ].join('; ');

    const htmlPath = path.join(this.extensionContext.extensionPath, 'media', 'search', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace('__CSP__', csp)
      .replace('__STYLES_URI__', stylesUri.toString())
      .replace('__SCRIPT_URI__', scriptUri.toString())
      .replace('__NONCE__', nonce);

    diagLog('search-panel', 'load-html', {
      htmlPath,
      nonceLen: nonce.length,
      bytes: html.length,
    });

    return html;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    infoLog('search-panel', 'dispose', {});
    if (this.panel) {
      this.panel.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    SearchPanel.instance = undefined;
  }
}
