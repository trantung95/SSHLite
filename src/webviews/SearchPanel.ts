import * as vscode from 'vscode';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { formatFileSize, formatRelativeTime } from '../utils/helpers';

/**
 * Search scope - a folder to search in
 */
export interface SearchScope {
  id: string; // connection.id + ":" + path
  path: string;
  connection: SSHConnection;
  displayName: string; // connection.host.name + ": " + path
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
 * Message types for webview communication
 */
type WebviewMessage =
  | { type: 'search'; query: string; include: string; exclude: string; caseSensitive: boolean; regex: boolean }
  | { type: 'removeScope'; index: number }
  | { type: 'clearScopes' }
  | { type: 'openResult'; result: WebviewSearchResult; line?: number }
  | { type: 'increaseLimit' }
  | { type: 'ready' };

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

  // Callbacks
  private openFileCallback?: (connectionId: string, remotePath: string, line?: number) => Promise<void>;

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
  public setOpenFileCallback(callback: (connectionId: string, remotePath: string, line?: number) => Promise<void>): void {
    this.openFileCallback = callback;
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
   * Add a search scope
   */
  public addScope(scopePath: string, connection: SSHConnection): void {
    const id = `${connection.id}:${scopePath}`;

    // Check for duplicate
    if (this.searchScopes.some((s) => s.id === id)) {
      return;
    }

    this.searchScopes.push({
      id,
      path: scopePath,
      connection,
      displayName: `${connection.host.name}: ${scopePath}`,
    });

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
   * Clear all scopes
   */
  public clearScopes(): void {
    this.searchScopes = [];
    this.sendState();
  }

  /**
   * Check if any scopes exist
   */
  public hasScopes(): boolean {
    return this.searchScopes.length > 0;
  }

  /**
   * Focus search input in webview
   */
  public focusSearchInput(): void {
    this.postMessage({ type: 'focusInput' });
  }

  /**
   * Send current state to webview
   */
  private sendState(): void {
    this.postMessage({
      type: 'state',
      scopes: this.searchScopes.map((s) => ({
        id: s.id,
        path: s.path,
        displayName: s.displayName,
        connectionId: s.connection.id,
      })),
      isSearching: this.isSearching,
    });
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'search':
        await this.performSearch(message.query, message.include, message.exclude, message.caseSensitive, message.regex);
        break;

      case 'removeScope':
        this.removeScope(message.index);
        break;

      case 'clearScopes':
        this.clearScopes();
        break;

      case 'openResult':
        if (this.openFileCallback) {
          await this.openFileCallback(message.result.connectionId, message.result.path, message.line);
        }
        break;

      case 'increaseLimit':
        await this.increaseSearchLimit();
        break;

      case 'ready':
        this.sendState();
        break;
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
        if (isNaN(num) || num < 100 || num > 50000) {
          return 'Please enter a number between 100 and 50000';
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
   * Perform search across all scopes
   */
  private async performSearch(
    query: string,
    includePattern: string,
    excludePattern: string,
    caseSensitive: boolean,
    regex: boolean
  ): Promise<void> {
    if (!query.trim() || this.searchScopes.length === 0) {
      this.postMessage({ type: 'results', results: [], query: '' });
      return;
    }

    this.isSearching = true;
    this.lastSearchQuery = query;
    this.postMessage({ type: 'searching', query });

    // Get configurable limit from settings
    const config = vscode.workspace.getConfiguration('sshLite');
    const maxResults = config.get<number>('searchMaxResults', 2000);

    try {
      // Deduplicate scopes (same connection+path)
      const uniqueScopes = new Map<string, SearchScope>();
      for (const scope of this.searchScopes) {
        if (!uniqueScopes.has(scope.id)) {
          uniqueScopes.set(scope.id, scope);
        }
      }

      // Search each scope in parallel
      const searchPromises = Array.from(uniqueScopes.values()).map(async (scope) => {
        try {
          const results = await scope.connection.searchFiles(scope.path, query, {
            searchContent: true,
            caseSensitive,
            regex,
            filePattern: includePattern || '*',
            excludePattern: excludePattern || undefined,
            maxResults,
          });

          return results.map((r) => ({
            ...r,
            modified: r.modified ? r.modified.getTime() : undefined,
            connectionId: scope.connection.id,
            connectionName: scope.connection.host.name,
          }));
        } catch {
          // Search failed for this scope, continue with others
          return [];
        }
      });

      const allResults = (await Promise.all(searchPromises)).flat();

      // Deduplicate results (same file+line from overlapping scopes)
      const seen = new Set<string>();
      const uniqueResults = allResults.filter((r) => {
        const key = `${r.connectionId}:${r.path}:${r.line || 0}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Check if we hit the limit
      const hitLimit = uniqueResults.length >= maxResults;
      this.postMessage({ type: 'results', results: uniqueResults, query, hitLimit, limit: maxResults });
    } catch (error) {
      this.postMessage({ type: 'error', message: (error as Error).message });
    } finally {
      this.isSearching = false;
      this.sendState();
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
      flex-direction: column;
      margin: 0;
    }

    .controls-section {
      max-width: 600px;
      border-bottom: 1px solid var(--vscode-panel-border);
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
      max-width: 400px;
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
      max-width: 300px;
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

    .results-section {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    .results-header {
      padding: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
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
          </div>
          <button id="searchBtn" class="search-btn" title="Search (Enter)">&#128269;</button>
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

      <div class="scopes-section">
        <div class="scopes-header">
          <span class="scopes-title">Search In</span>
          <button id="clearScopesBtn" class="clear-btn" title="Clear all scopes">Clear</button>
        </div>
        <div id="scopeList" class="scope-list">
          <div class="no-scopes">No folders selected. Click search icon on a folder to add.</div>
        </div>
      </div>
    </div>

    <div class="results-section">
      <div id="resultsHeader" class="results-header" style="display: none;"></div>
      <div id="resultsContainer"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // State
    let scopes = [];
    let results = [];
    let currentQuery = '';
    let caseSensitive = false;
    let useRegex = false;
    let expandedFiles = new Set();

    // Elements
    const searchInput = document.getElementById('searchInput');
    const includeInput = document.getElementById('includeInput');
    const excludeInput = document.getElementById('excludeInput');
    const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
    const regexBtn = document.getElementById('regexBtn');
    const searchBtn = document.getElementById('searchBtn');
    const clearScopesBtn = document.getElementById('clearScopesBtn');
    const scopeList = document.getElementById('scopeList');
    const resultsHeader = document.getElementById('resultsHeader');
    const resultsContainer = document.getElementById('resultsContainer');
    const patternToggle = document.getElementById('patternToggle');
    const patternChevron = document.getElementById('patternChevron');
    const patternFields = document.getElementById('patternFields');

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

      // Clear scopes
      clearScopesBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearScopes' });
      });

      // Notify extension we're ready
      vscode.postMessage({ type: 'ready' });
    }

    // Perform search
    function performSearch() {
      const query = searchInput.value.trim();
      if (!query || scopes.length === 0) {
        showNoResults();
        return;
      }

      vscode.postMessage({
        type: 'search',
        query,
        include: includeInput.value.trim(),
        exclude: excludeInput.value.trim(),
        caseSensitive,
        regex: useRegex
      });
    }

    // Render scopes
    function renderScopes() {
      if (scopes.length === 0) {
        scopeList.innerHTML = '<div class="no-scopes">No folders selected. Click search icon on a folder to add.</div>';
        return;
      }

      scopeList.innerHTML = scopes.map((scope, index) => \`
        <div class="scope-item">
          <span class="scope-icon">📁</span>
          <span class="scope-path" title="\${escapeHtml(scope.displayName)}">\${escapeHtml(scope.displayName)}</span>
          <button class="scope-remove" data-index="\${index}" title="Remove">×</button>
        </div>
      \`).join('');

      // Add click handlers
      scopeList.querySelectorAll('.scope-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const index = parseInt(e.target.dataset.index);
          vscode.postMessage({ type: 'removeScope', index });
        });
      });
    }

    // Render results
    function renderResults(hitLimit = false, limit = 2000) {
      if (results.length === 0) {
        showNoResults();
        return;
      }

      // Group by file
      const grouped = {};
      for (const result of results) {
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
      const matchCount = results.length;

      resultsHeader.style.display = 'block';
      if (hitLimit) {
        resultsHeader.innerHTML = \`\${matchCount} result\${matchCount !== 1 ? 's' : ''} in \${fileCount} file\${fileCount !== 1 ? 's' : ''} <span class="limit-warning" title="Click to increase limit">⚠️ Limit \${limit} reached - <a href="#" id="increaseLimitLink">increase limit</a></span>\`;
        // Add click handler for increase limit link
        setTimeout(() => {
          const link = document.getElementById('increaseLimitLink');
          if (link) {
            link.addEventListener('click', (e) => {
              e.preventDefault();
              vscode.postMessage({ type: 'increaseLimit' });
            });
          }
        }, 0);
      } else {
        resultsHeader.textContent = \`\${matchCount} result\${matchCount !== 1 ? 's' : ''} in \${fileCount} file\${fileCount !== 1 ? 's' : ''}\`;
      }

      resultsContainer.innerHTML = fileGroups.map((group, index) => {
        const fileName = group.path.split('/').pop();
        const dirPath = group.path.substring(0, group.path.length - fileName.length - 1) || '/';
        const fileKey = group.connectionId + ':' + group.path;
        const isExpanded = expandedFiles.has(fileKey);

        return \`
          <div class="file-group" data-file-key="\${escapeHtml(fileKey)}">
            <div class="file-header" data-file-key="\${escapeHtml(fileKey)}">
              <span class="chevron \${isExpanded ? '' : 'collapsed'}">▼</span>
              <span class="file-icon">📄</span>
              <span class="file-name">\${escapeHtml(fileName)}</span>
              <span class="file-path">\${escapeHtml(dirPath)}</span>
              <span class="file-count">\${group.matches.length}</span>
            </div>
            <div class="match-list \${isExpanded ? 'expanded' : ''}" data-file-key="\${escapeHtml(fileKey)}">
              \${group.matches.map(match => \`
                <div class="match-item" data-path="\${escapeHtml(match.path)}" data-connection="\${escapeHtml(match.connectionId)}" data-line="\${match.line || ''}">
                  <span class="match-line">\${match.line || ''}</span>
                  <span class="match-text">\${escapeHtml(match.match || '')}</span>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }).join('');

      // Add click handlers
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

      resultsContainer.querySelectorAll('.match-item').forEach(item => {
        item.addEventListener('click', () => {
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
    }

    // Show no results
    function showNoResults() {
      resultsHeader.style.display = 'none';
      if (searchInput.value.trim() && scopes.length > 0) {
        resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
      } else if (scopes.length === 0) {
        resultsContainer.innerHTML = '<div class="no-results">Add a folder to search in</div>';
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

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'state':
          scopes = message.scopes || [];
          renderScopes();
          break;

        case 'searching':
          showSearching(message.query);
          break;

        case 'results':
          results = message.results || [];
          currentQuery = message.query || '';
          renderResults(message.hitLimit, message.limit);
          break;

        case 'error':
          resultsHeader.style.display = 'none';
          resultsContainer.innerHTML = '<div class="no-results">Error: ' + escapeHtml(message.message) + '</div>';
          break;

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
