import * as vscode from 'vscode';
import * as fs from 'fs';
import { FileService, FileMapping } from '../services/FileService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { normalizeLocalPath, formatFileSize, formatDateTime } from '../utils/helpers';

/**
 * Provides file decorations for SSH temp files:
 * - Upload state badge (↑ uploading, ✗ failed) on tab
 * - Grayed-out tab decoration for SSH temp files without active connection (file:// URIs)
 * - Blue highlight for filtered folders in the file tree (ssh:// URIs)
 */
export class SSHFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private disposables: vscode.Disposable[] = [];
  private fileService: FileService;
  private connectionManager: ConnectionManager;
  private tempDir: string;

  // Filtered folder URIs (multiple simultaneous filters supported)
  private filteredFolderUris: Set<string> = new Set();

  // Filename filter state for empty folder graying (supports multiple filters)
  private filterHighlightedUris: Set<string> = new Set();
  private filterBasePrefixes: Set<string> = new Set();

  constructor(fileService: FileService, connectionManager: ConnectionManager) {
    this.fileService = fileService;
    this.connectionManager = connectionManager;
    this.tempDir = fileService.getTempDir();

    // Subscribe to file mapping changes (for live-refresh tab decorations)
    this.disposables.push(
      fileService.onFileMappingsChanged(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );

    // Subscribe to upload state changes (uploading/failed badges)
    this.disposables.push(
      fileService.onUploadStateChanged(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );

    // Subscribe to connection state changes (connect/disconnect/drop)
    this.disposables.push(
      connectionManager.onDidChangeConnections(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );
    this.disposables.push(
      connectionManager.onConnectionStateChange(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );
  }

  /**
   * Add a filtered folder to highlight in the tree view (additive, supports multiple).
   */
  setFilteredFolder(connectionId: string, folderPath: string): void {
    if (!connectionId) return;
    const uri = `ssh://${connectionId}${folderPath}`;
    this.filteredFolderUris.add(uri);
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Clear filtered folder highlight(s) and empty folder graying.
   * @param connectionId - Optional: clear only this connection+folder
   * @param folderPath - Optional: clear only this specific folder
   */
  clearFilteredFolder(connectionId?: string, folderPath?: string): void {
    if (connectionId && folderPath) {
      const uri = `ssh://${connectionId}${folderPath}`;
      this.filteredFolderUris.delete(uri);
      const prefix = `ssh://${connectionId}${folderPath}/`;
      this.filterBasePrefixes.delete(prefix);
      // Rebuild highlighted URIs from remaining filters (simplified: just fire refresh)
      this._onDidChangeFileDecorations.fire(undefined);
    } else {
      this.filteredFolderUris.clear();
      this.filterHighlightedUris.clear();
      this.filterBasePrefixes.clear();
      this._onDidChangeFileDecorations.fire(undefined);
    }
  }

  /**
   * Set highlighted paths for a filename filter (additive, supports multiple filters).
   * Folders under basePath that are NOT in highlightedPaths will be grayed out.
   */
  setFilenameFilterPaths(highlightedPaths: Set<string>, basePath: string, connectionId: string): void {
    if (!connectionId || !basePath) {
      return;
    }

    this.filterBasePrefixes.add(`ssh://${connectionId}${basePath}/`);

    for (const p of highlightedPaths) {
      this.filterHighlightedUris.add(`ssh://${connectionId}${p}`);
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Rebuild all decoration state from scratch (call after filter changes).
   */
  rebuildFilterState(filterStates: Array<{ highlightedPaths: Set<string>; basePath: string; connectionId: string }>): void {
    this.filteredFolderUris.clear();
    this.filterHighlightedUris.clear();
    this.filterBasePrefixes.clear();

    for (const state of filterStates) {
      this.filteredFolderUris.add(`ssh://${state.connectionId}${state.basePath}`);
      this.filterBasePrefixes.add(`ssh://${state.connectionId}${state.basePath}/`);
      for (const p of state.highlightedPaths) {
        this.filterHighlightedUris.add(`ssh://${state.connectionId}${p}`);
      }
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Handle ssh:// URIs — highlight filtered folders and gray out empty folders
    if (uri.scheme === 'ssh') {
      const uriString = uri.toString();

      // Blue badge for filtered folder(s)
      if (this.filteredFolderUris.has(uriString)) {
        return {
          badge: 'F',
          color: new vscode.ThemeColor('charts.blue'),
          tooltip: 'Filtered folder',
        };
      }

      // Gray out non-matching items (under any filter basePath, not in highlightedPaths)
      for (const prefix of this.filterBasePrefixes) {
        if (uriString.startsWith(prefix) && !this.filterHighlightedUris.has(uriString)) {
          return {
            color: new vscode.ThemeColor('disabledForeground'),
            tooltip: 'Not matching filter',
          };
        }
      }
    }

    // Handle file:// URIs
    if (uri.scheme === 'file') {
      const filePath = normalizeLocalPath(uri.fsPath);
      const tooltipsEnabled = vscode.workspace.getConfiguration('sshLite').get<boolean>('localFileTooltips', true);

      // Non-SSH local files — tooltip only
      if (!filePath.startsWith(this.tempDir)) {
        if (!tooltipsEnabled) return undefined;
        const tooltip = this._buildLocalTooltip(uri.fsPath);
        return tooltip ? { tooltip } : undefined;
      }

      // SSH temp files — badges + remote tooltip
      const remoteTooltipSuffix = (mapping: FileMapping) => {
        if (!tooltipsEnabled) return '';
        return '\n\n' + this._buildRemoteTooltip(mapping);
      };

      // Upload state badges take priority
      if (this.fileService.isFileUploading(filePath)) {
        const mapping = this.fileService.getFileMapping(filePath);
        return {
          badge: '↑',
          color: new vscode.ThemeColor('charts.yellow'),
          tooltip: 'Uploading to server...' + (mapping ? remoteTooltipSuffix(mapping) : ''),
        };
      }

      if (this.fileService.isFileUploadFailed(filePath)) {
        const mapping = this.fileService.getFileMapping(filePath);
        return {
          badge: '✗',
          color: new vscode.ThemeColor('errorForeground'),
          tooltip: 'Upload failed — save again to retry' + (mapping ? remoteTooltipSuffix(mapping) : ''),
        };
      }

      // Check if this file has an active mapping
      const mapping = this.fileService.getFileMapping(filePath);
      if (!mapping) {
        return {
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: 'Not connected — click "Reconnect" to enable live refresh',
        };
      }

      // Has mapping — check if the connection is still active
      const connection = this.connectionManager.getConnection(mapping.connectionId);
      if (!connection) {
        return {
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: 'Connection lost — file is not being refreshed' + remoteTooltipSuffix(mapping),
        };
      }

      // File is live — show remote tooltip only
      if (tooltipsEnabled) {
        return { tooltip: this._buildRemoteTooltip(mapping) };
      }
      return undefined;
    }

    return undefined;
  }

  private _formatPermissions(mode: number): string {
    const chars = 'rwx';
    let result = '';
    for (let i = 8; i >= 0; i--) {
      result += (mode & (1 << i)) ? chars[(8 - i) % 3] : '-';
    }
    return result;
  }

  private _buildLocalTooltip(fsPath: string): string | undefined {
    try {
      const stat = fs.statSync(fsPath);
      const lines: string[] = [
        `Path: ${fsPath}`,
        `Size: ${stat.isDirectory() ? 'Directory' : formatFileSize(stat.size)}`,
        `Modified: ${formatDateTime(stat.mtimeMs)}`,
        `Accessed: ${formatDateTime(stat.atimeMs)}`,
        `Permissions: ${this._formatPermissions(stat.mode)}`,
      ];
      return lines.join('\n');
    } catch {
      return undefined;
    }
  }

  private _buildRemoteTooltip(mapping: FileMapping): string {
    const rf = mapping.remoteFile;
    const parts = mapping.connectionId.split(':');
    const serverLine = `Server: ${parts[0]}:${parts[1]} (${parts[2]})`;

    const size = rf ? formatFileSize(rf.size) : (mapping.lastRemoteSize != null ? formatFileSize(mapping.lastRemoteSize) : 'N/A');
    const modified = rf ? formatDateTime(rf.modifiedTime) : (mapping.lastRemoteModTime != null ? formatDateTime(mapping.lastRemoteModTime) : 'N/A');
    const accessed = rf?.accessTime ? formatDateTime(rf.accessTime) : 'N/A';
    const owner = rf ? `${rf.owner || 'N/A'}:${rf.group || 'N/A'}` : 'N/A';
    const perms = rf?.permissions || 'N/A';

    const lines: string[] = [
      `Path: ${rf?.path || mapping.remotePath}`,
      serverLine,
      `Size: ${size}`,
      `Modified: ${modified}`,
      `Accessed: ${accessed}`,
      `Owner: ${owner}`,
      `Permissions: ${perms}`,
    ];
    return lines.join('\n');
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
