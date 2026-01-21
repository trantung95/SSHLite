import * as vscode from 'vscode';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { formatFileSize, formatRelativeTime } from '../utils/helpers';

/**
 * Search result item
 */
export interface SearchResult {
  path: string;
  line?: number;
  match?: string;
  connection: SSHConnection;
  size?: number;
  modified?: Date;
  permissions?: string;
}

/**
 * Tree item for a search result file
 */
export class SearchResultFileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly connection: SSHConnection,
    public readonly results: SearchResult[],
    hasMatches: boolean
  ) {
    // Always make collapsible if there are matches to show (line numbers or multiple results)
    // Default to Collapsed so user can expand to see details
    super(
      path.basename(filePath),
      hasMatches
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Unique ID for tree state preservation
    this.id = `search-file:${connection.id}:${filePath}`;
    this.description = path.dirname(filePath);
    this.contextValue = 'searchResultFile';
    this.iconPath = vscode.ThemeIcon.File;
    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${filePath}`);

    // Rich tooltip with file info (same as file tree items)
    const matchCount = results.length;
    const lineNumbers = results
      .filter((r) => r.line !== undefined)
      .map((r) => r.line)
      .slice(0, 10); // Show first 10 lines
    const linesPreview = lineNumbers.length > 0
      ? `Lines: ${lineNumbers.join(', ')}${lineNumbers.length < matchCount ? '...' : ''}`
      : '';

    // Get file metadata from first result (all results for same file share same metadata)
    const firstResult = results[0];
    const sizeStr = firstResult.size !== undefined ? formatFileSize(firstResult.size) : 'Unknown';
    const modifiedStr = firstResult.modified ? formatRelativeTime(firstResult.modified.getTime()) : 'Unknown';
    const permStr = firstResult.permissions || 'Unknown';

    this.tooltip = new vscode.MarkdownString(
      `**${path.basename(filePath)}**\n\n` +
      `- Path: \`${filePath}\`\n` +
      `- Server: ${connection.host.name}\n` +
      `- Size: ${sizeStr}\n` +
      `- Modified: ${modifiedStr}\n` +
      `- Permissions: \`${permStr}\`\n` +
      `- Matches: ${matchCount}\n` +
      (linesPreview ? `- ${linesPreview}\n` : '') +
      `\n*Click to open, right-click for options*`
    );

    // Always make clickable - opens first result (first match or file itself)
    if (results.length > 0) {
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

    // Unique ID for tree state preservation
    this.id = `search-match:${result.connection.id}:${result.path}:${result.line || 0}`;
    this.description = lineInfo;
    this.contextValue = 'searchResultMatch';
    this.iconPath = new vscode.ThemeIcon('search');

    // Rich tooltip with match context and file metadata
    const fileName = path.basename(result.path);
    const sizeStr = result.size !== undefined ? formatFileSize(result.size) : 'Unknown';
    const modifiedStr = result.modified ? formatRelativeTime(result.modified.getTime()) : 'Unknown';
    const permStr = result.permissions || 'Unknown';

    this.tooltip = new vscode.MarkdownString(
      `**${fileName}${result.line ? `:${result.line}` : ''}**\n\n` +
      (result.match ? `\`\`\`\n${result.match}\n\`\`\`\n\n` : '') +
      `- Path: \`${result.path}\`\n` +
      `- Server: ${result.connection.host.name}\n` +
      `- Size: ${sizeStr}\n` +
      `- Modified: ${modifiedStr}\n` +
      `- Permissions: \`${permStr}\`\n` +
      `\n*Click to open at this line*`
    );

    this.command = {
      command: 'sshLite.openSearchResult',
      title: 'Open at Line',
      arguments: [result],
    };
  }
}

type SearchTreeItem = SearchResultFileItem | SearchResultMatchItem | SortOptionItem;

/**
 * Sort options for search results
 */
export type SortOption = 'name' | 'path' | 'matches';

/**
 * Tree item for displaying current sort option (clickable to change)
 */
export class SortOptionItem extends vscode.TreeItem {
  constructor(public readonly currentSort: SortOption, public readonly resultCount: number) {
    const sortLabels: Record<SortOption, string> = {
      name: 'Name (A-Z)',
      path: 'Path',
      matches: 'Match Count',
    };
    super(`Sort: ${sortLabels[currentSort]}`, vscode.TreeItemCollapsibleState.None);

    this.description = `${resultCount} file(s) found`;
    this.contextValue = 'sortOption';
    this.iconPath = new vscode.ThemeIcon('arrow-swap');
    this.tooltip = 'Click to change sort order';
    this.command = {
      command: 'sshLite.cycleSearchSort',
      title: 'Change Sort Order',
    };
  }
}

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
  private sortOption: SortOption = 'name'; // Default sort by name

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

  /**
   * Get current sort option
   */
  getSortOption(): SortOption {
    return this.sortOption;
  }

  /**
   * Set sort option and refresh
   */
  setSortOption(option: SortOption): void {
    this.sortOption = option;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Cycle through sort options
   */
  cycleSort(): void {
    const options: SortOption[] = ['name', 'path', 'matches'];
    const currentIndex = options.indexOf(this.sortOption);
    this.sortOption = options[(currentIndex + 1) % options.length];
    this._onDidChangeTreeData.fire();
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

      // Sort items based on current sort option
      items.sort((a, b) => {
        switch (this.sortOption) {
          case 'name':
            return path.basename(a.filePath).localeCompare(path.basename(b.filePath));
          case 'path':
            return a.filePath.localeCompare(b.filePath);
          case 'matches':
            return b.results.length - a.results.length; // Descending (most matches first)
          default:
            return 0;
        }
      });

      // Add sort option header at top
      const result: SearchTreeItem[] = [new SortOptionItem(this.sortOption, items.length)];
      result.push(...items);
      return result;
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
