import * as vscode from 'vscode';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';

/**
 * Search result item
 */
export interface SearchResult {
  path: string;
  line?: number;
  match?: string;
  connection: SSHConnection;
}

/**
 * Tree item for a search result file
 */
export class SearchResultFileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly connection: SSHConnection,
    public readonly results: SearchResult[],
    hasMultipleMatches: boolean
  ) {
    super(
      path.basename(filePath),
      hasMultipleMatches
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );

    this.description = path.dirname(filePath);
    this.tooltip = filePath;
    this.contextValue = 'searchResultFile';
    this.iconPath = vscode.ThemeIcon.File;
    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${filePath}`);

    // If only one result, make it clickable directly
    if (!hasMultipleMatches && results.length === 1) {
      this.command = {
        command: 'sshLite.openSearchResult',
        title: 'Open File',
        arguments: [results[0]],
      };
    }
  }
}

/**
 * Tree item for a specific match within a file
 */
export class SearchResultMatchItem extends vscode.TreeItem {
  constructor(public readonly result: SearchResult) {
    const lineInfo = result.line ? `Line ${result.line}` : '';
    const matchText = result.match
      ? result.match.length > 80
        ? result.match.substring(0, 80) + '...'
        : result.match
      : '';

    super(matchText || lineInfo, vscode.TreeItemCollapsibleState.None);

    this.description = lineInfo;
    this.tooltip = result.match || result.path;
    this.contextValue = 'searchResultMatch';
    this.iconPath = new vscode.ThemeIcon('search');

    this.command = {
      command: 'sshLite.openSearchResult',
      title: 'Open at Line',
      arguments: [result],
    };
  }
}

type SearchTreeItem = SearchResultFileItem | SearchResultMatchItem;

/**
 * Tree data provider for search results
 */
export class SearchResultsProvider implements vscode.TreeDataProvider<SearchTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SearchTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: SearchResult[] = [];
  private searchQuery: string = '';
  private searchPath: string = '';
  private isSearching: boolean = false;

  /**
   * Set search results
   */
  setResults(results: SearchResult[], query: string, searchPath: string): void {
    this.results = results;
    this.searchQuery = query;
    this.searchPath = searchPath;
    this.isSearching = false;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear search results
   */
  clear(): void {
    this.results = [];
    this.searchQuery = '';
    this.searchPath = '';
    this.isSearching = false;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set searching state
   */
  setSearching(query: string, searchPath: string): void {
    this.searchQuery = query;
    this.searchPath = searchPath;
    this.isSearching = true;
    this.results = [];
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get current search query
   */
  getSearchQuery(): string {
    return this.searchQuery;
  }

  /**
   * Get result count
   */
  getResultCount(): number {
    return this.results.length;
  }

  /**
   * Check if searching
   */
  getIsSearching(): boolean {
    return this.isSearching;
  }

  getTreeItem(element: SearchTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SearchTreeItem): SearchTreeItem[] {
    if (!element) {
      // Root level - group results by file
      if (this.results.length === 0) {
        return [];
      }

      // Group by file path
      const fileMap = new Map<string, SearchResult[]>();
      for (const result of this.results) {
        const existing = fileMap.get(result.path) || [];
        existing.push(result);
        fileMap.set(result.path, existing);
      }

      // Create file items
      const items: SearchResultFileItem[] = [];
      for (const [filePath, fileResults] of fileMap) {
        const connection = fileResults[0].connection;
        const hasMultiple = fileResults.length > 1 || (fileResults[0].line !== undefined);
        items.push(new SearchResultFileItem(filePath, connection, fileResults, hasMultiple));
      }

      return items;
    }

    // Child level - show individual matches
    if (element instanceof SearchResultFileItem) {
      return element.results.map((r) => new SearchResultMatchItem(r));
    }

    return [];
  }

  getParent(element: SearchTreeItem): SearchTreeItem | undefined {
    if (element instanceof SearchResultMatchItem) {
      // Find parent file item - not strictly needed for basic functionality
      return undefined;
    }
    return undefined;
  }
}
