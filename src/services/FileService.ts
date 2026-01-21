import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { AuditService } from './AuditService';
import { FolderHistoryService } from './FolderHistoryService';
import { ProgressiveDownloadManager } from './ProgressiveDownloadManager';
import { formatFileSize } from '../utils/helpers';
import { isLikelyBinary, DEFAULT_PROGRESSIVE_CONFIG } from '../types/progressive';

/**
 * Large file size threshold (100MB default)
 */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

/**
 * Default smart refresh threshold (500KB)
 * Files larger than this use tail-based incremental refresh when they grow
 */
const DEFAULT_SMART_REFRESH_THRESHOLD = 500 * 1024;

/**
 * Mapping from local temp file to remote file info
 */
interface FileMapping {
  connectionId: string;
  remotePath: string;
  localPath: string;
  lastSyncTime: number;
  lastRemoteModTime?: number;
  lastRemoteSize?: number; // Track file size for smart refresh optimization
  originalContent?: string; // For diff tracking
  serverBackupPath?: string; // Path to backup on remote server
}

/**
 * Server-side backup folder name
 */
const SERVER_BACKUP_FOLDER = '/tmp/.ssh-lite-backups';

/**
 * Backup entry for file revert
 */
interface BackupEntry {
  connectionId: string;
  remotePath: string;
  content: string;
  timestamp: number;
  hostName: string;
}

/**
 * Service for file operations and auto-sync
 */
export class FileService {
  private static _instance: FileService;

  private tempDir: string;
  private backupDir: string;
  private fileMappings: Map<string, FileMapping> = new Map(); // localPath -> mapping
  private saveListenerDisposable: vscode.Disposable | null = null;
  private configChangeListener: vscode.Disposable | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private globalRefreshTimer: NodeJS.Timeout | null = null;
  private globalRefreshRunning: boolean = false; // Prevent concurrent global refresh cycles
  private refreshingConnections: Set<string> = new Set(); // Track which connections are currently refreshing
  private auditService: AuditService;
  private folderHistoryService: FolderHistoryService;
  private skipNextSave: Set<string> = new Set(); // Paths to skip upload on next save
  private activeDownloads: Set<string> = new Set(); // Track paths currently being downloaded

  private autoCleanupTimer: NodeJS.Timeout | null = null;

  // Backup storage for file revert (connectionId:remotePath -> BackupEntry[])
  private backupHistory: Map<string, BackupEntry[]> = new Map();
  private readonly MAX_BACKUPS_PER_FILE = 10;

  // Lock for file operations to prevent concurrent access
  private fileOperationLocks: Map<string, Promise<void>> = new Map();

  // Concurrency control for file preloading
  private activePreloadCount: number = 0;
  private preloadWaitQueue: Array<() => void> = [];
  private preloadCancelled: boolean = false;
  private totalPreloadQueued: number = 0;
  private completedPreloadCount: number = 0;
  private preloadProgressResolve: (() => void) | null = null;

  // File watcher state
  private currentWatchedFile: { localPath: string; remotePath: string; connectionId: string } | null = null;
  private fileChangeSubscriptions: Map<string, vscode.Disposable> = new Map(); // connectionId -> subscription
  private focusedFilePollTimer: NodeJS.Timeout | null = null; // Fast polling for focused file when no native watch
  private usingNativeWatch: boolean = false; // Track if native watch is active

  private constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ssh-lite');
    this.backupDir = path.join(this.tempDir, 'backups');
    this.ensureTempDir();
    this.ensureBackupDir();
    this.setupSaveListener();
    this.setupConfigListener();
    this.setupFocusedFileWatcher();
    this.auditService = AuditService.getInstance();
    this.folderHistoryService = FolderHistoryService.getInstance();
    this.startGlobalRefreshTimer();
    this.startAutoCleanupTimer();
  }

  /**
   * Listen for configuration changes to restart refresh timer
   */
  private setupConfigListener(): void {
    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite.fileRefreshIntervalSeconds')) {
        this.restartGlobalRefreshTimer();
      }
      if (e.affectsConfiguration('sshLite.tempFileRetentionHours')) {
        this.restartAutoCleanupTimer();
      }
    });
  }

  /**
   * Setup file watcher for focused file (auto-watch the currently active SSH file)
   */
  private setupFocusedFileWatcher(): void {
    // Watch for active editor changes to update file watcher
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) {
        await this.stopCurrentFileWatch();
        return;
      }

      const localPath = editor.document.uri.fsPath;
      const mapping = this.fileMappings.get(localPath);

      if (!mapping) {
        // Not an SSH file - stop watching
        await this.stopCurrentFileWatch();
        return;
      }

      // If already watching this file, do nothing
      if (this.currentWatchedFile?.localPath === localPath) {
        return;
      }

      // Stop watching previous file
      await this.stopCurrentFileWatch();

      // Start watching new file
      await this.startFileWatch(localPath, mapping);
    });
  }

  /**
   * Start watching a file for real-time updates
   */
  private async startFileWatch(localPath: string, mapping: FileMapping): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      return;
    }

    // Stop any existing poll timer
    this.stopFocusedFilePollTimer();

    // Set current watched file
    this.currentWatchedFile = {
      localPath,
      remotePath: mapping.remotePath,
      connectionId: mapping.connectionId,
    };

    // Try to start native file watcher
    const watchStarted = await connection.watchFile(mapping.remotePath);

    if (watchStarted) {
      this.usingNativeWatch = true;

      // Subscribe to file change events if not already subscribed
      if (!this.fileChangeSubscriptions.has(connection.id)) {
        const subscription = connection.onFileChange(async (event) => {
          // Only process if this is the file we're watching
          if (this.currentWatchedFile?.remotePath === event.remotePath) {
            await this.handleFileChangeEvent(event);
          }
        });
        this.fileChangeSubscriptions.set(connection.id, subscription);
      }

      vscode.window.setStatusBarMessage(`$(eye) Watching ${path.basename(mapping.remotePath)} (native)`, 2000);
    } else {
      // No native watch - use fast polling for focused file (1 second interval)
      this.usingNativeWatch = false;
      this.startFocusedFilePollTimer();
      vscode.window.setStatusBarMessage(`$(eye) Watching ${path.basename(mapping.remotePath)} (polling)`, 2000);
    }
  }

  /**
   * Start fast polling timer for focused file (when native watch not available)
   */
  private startFocusedFilePollTimer(): void {
    this.stopFocusedFilePollTimer();

    // Poll every 1 second for focused file
    this.focusedFilePollTimer = setInterval(async () => {
      if (!this.currentWatchedFile) {
        return;
      }

      const mapping = this.fileMappings.get(this.currentWatchedFile.localPath);
      if (mapping) {
        await this.refreshSingleFile(this.currentWatchedFile.localPath, mapping, true);
      }
    }, 1000);
  }

  /**
   * Stop focused file poll timer
   */
  private stopFocusedFilePollTimer(): void {
    if (this.focusedFilePollTimer) {
      clearInterval(this.focusedFilePollTimer);
      this.focusedFilePollTimer = null;
    }
  }

  /**
   * Stop watching the current file
   */
  private async stopCurrentFileWatch(): Promise<void> {
    // Stop poll timer
    this.stopFocusedFilePollTimer();

    if (!this.currentWatchedFile) {
      return;
    }

    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(this.currentWatchedFile.connectionId);

    if (connection && this.usingNativeWatch) {
      await connection.unwatchFile(this.currentWatchedFile.remotePath);
    }

    this.currentWatchedFile = null;
    this.usingNativeWatch = false;
  }

  /**
   * Handle file change event from watcher - refresh the file immediately
   */
  private async handleFileChangeEvent(event: { remotePath: string; event: 'modify' | 'delete' | 'create' }): Promise<void> {
    if (event.event === 'delete') {
      vscode.window.showWarningMessage(`File "${path.basename(event.remotePath)}" was deleted on server`);
      return;
    }

    // Find local path for this remote file
    const localPath = this.currentWatchedFile?.localPath;
    if (!localPath) {
      return;
    }

    const mapping = this.fileMappings.get(localPath);
    if (!mapping) {
      return;
    }

    // Debounce rapid changes (e.g., log files being written to quickly)
    const debounceKey = `watch:${localPath}`;
    const existingTimer = this.debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(debounceKey, setTimeout(async () => {
      this.debounceTimers.delete(debounceKey);

      // Refresh the file immediately
      await this.refreshSingleFile(localPath, mapping, true);

      vscode.window.setStatusBarMessage(`$(zap) File updated (real-time watch)`, 1500);
    }, 100)); // 100ms debounce for rapid changes
  }

  /**
   * Start auto-cleanup timer for old temp files
   */
  private startAutoCleanupTimer(): void {
    const config = vscode.workspace.getConfiguration('sshLite');
    const retentionHours = config.get<number>('tempFileRetentionHours', 0);

    if (retentionHours <= 0) {
      return; // Disabled
    }

    // Run cleanup every hour
    this.autoCleanupTimer = setInterval(() => {
      this.cleanupOldTempFiles();
    }, 60 * 60 * 1000); // 1 hour

    // Also run immediately on startup
    this.cleanupOldTempFiles();
  }

  /**
   * Stop auto-cleanup timer
   */
  private stopAutoCleanupTimer(): void {
    if (this.autoCleanupTimer) {
      clearInterval(this.autoCleanupTimer);
      this.autoCleanupTimer = null;
    }
  }

  /**
   * Restart auto-cleanup timer (when config changes)
   */
  private restartAutoCleanupTimer(): void {
    this.stopAutoCleanupTimer();
    this.startAutoCleanupTimer();
  }

  /**
   * Clean up temp files older than retention period
   */
  cleanupOldTempFiles(connectionId?: string): number {
    const config = vscode.workspace.getConfiguration('sshLite');
    const retentionHours = config.get<number>('tempFileRetentionHours', 24);

    if (retentionHours <= 0) {
      return 0; // Cleanup disabled
    }

    const now = Date.now();
    const maxAge = retentionHours * 60 * 60 * 1000; // Convert hours to milliseconds
    let cleanedCount = 0;

    // Clean files in our mappings
    // Create snapshot to avoid concurrent modification during iteration
    const mappingsSnapshot = Array.from(this.fileMappings.entries());
    for (const [localPath, mapping] of mappingsSnapshot) {
      // Skip if filtering by connection and this doesn't match
      if (connectionId && mapping.connectionId !== connectionId) {
        continue;
      }

      const fileAge = now - mapping.lastSyncTime;
      if (fileAge > maxAge) {
        // Clear any pending debounce timer
        const timer = this.debounceTimers.get(localPath);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(localPath);
        }

        // Delete the temp file
        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
            cleanedCount++;
          }
        } catch {
          // Ignore errors during cleanup
        }
        this.fileMappings.delete(localPath);
      }
    }

    // Also clean orphan files in temp directory that aren't in our mappings
    // Handle both flat files and connection subdirectories
    try {
      const entries = fs.readdirSync(this.tempDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(this.tempDir, entry.name);

        if (entry.isDirectory() && entry.name !== 'backups') {
          // Connection subdirectory - check files inside
          try {
            const subFiles = fs.readdirSync(entryPath);
            for (const subFile of subFiles) {
              const filePath = path.join(entryPath, subFile);

              // Skip if this file is in our active mappings
              if (this.fileMappings.has(filePath)) {
                continue;
              }

              try {
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                if (fileAge > maxAge) {
                  fs.unlinkSync(filePath);
                  cleanedCount++;
                }
              } catch {
                // Ignore errors for individual files
              }
            }

            // Remove empty subdirectory
            try {
              const remainingFiles = fs.readdirSync(entryPath);
              if (remainingFiles.length === 0) {
                fs.rmdirSync(entryPath);
              }
            } catch {
              // Ignore errors
            }
          } catch {
            // Ignore errors reading subdirectory
          }
        } else if (entry.isFile()) {
          // Legacy flat file (from old structure)
          if (this.fileMappings.has(entryPath)) {
            continue;
          }

          try {
            const stats = fs.statSync(entryPath);
            const fileAge = now - stats.mtimeMs;
            if (fileAge > maxAge) {
              fs.unlinkSync(entryPath);
              cleanedCount++;
            }
          } catch {
            // Ignore errors for individual files
          }
        }
      }
    } catch {
      // Ignore errors reading directory
    }

    return cleanedCount;
  }

  /**
   * Clear all temp files for all servers
   */
  clearAllTempFiles(): number {
    let cleanedCount = 0;

    // Clear all mappings
    // Create snapshot to avoid concurrent modification during iteration
    const localPaths = Array.from(this.fileMappings.keys());
    for (const localPath of localPaths) {
      const timer = this.debounceTimers.get(localPath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(localPath);
      }

      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          cleanedCount++;
        }
      } catch {
        // Ignore errors
      }
    }
    this.fileMappings.clear();

    // Also clean any orphan files in temp directory
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          fs.unlinkSync(filePath);
          cleanedCount++;
        } catch {
          // Ignore errors
        }
      }
    } catch {
      // Ignore errors
    }

    return cleanedCount;
  }

  /**
   * Clear all temp files for a specific server
   */
  clearTempFilesForConnection(connectionId: string): number {
    let cleanedCount = 0;

    // Create snapshot to avoid concurrent modification during iteration
    const mappingsSnapshot = Array.from(this.fileMappings.entries());
    for (const [localPath, mapping] of mappingsSnapshot) {
      if (mapping.connectionId === connectionId) {
        const timer = this.debounceTimers.get(localPath);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(localPath);
        }

        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
            cleanedCount++;
          }
        } catch {
          // Ignore errors
        }
        this.fileMappings.delete(localPath);
      }
    }

    return cleanedCount;
  }

  /**
   * Restart global refresh timer (when config changes)
   */
  private restartGlobalRefreshTimer(): void {
    this.stopGlobalRefreshTimer();
    this.startGlobalRefreshTimer();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): FileService {
    if (!FileService._instance) {
      FileService._instance = new FileService();
    }
    return FileService._instance;
  }

  /**
   * Ensure temp directory exists
   */
  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Get local temp file path for a remote file.
   * Uses connection subdirectories to avoid collisions while keeping original filenames.
   */
  private getLocalFilePath(connectionId: string, remotePath: string): string {
    // Create a short hash of connection ID for subdirectory
    const connHash = crypto
      .createHash('md5')
      .update(connectionId)
      .digest('hex')
      .substring(0, 8);

    const connDir = path.join(this.tempDir, connHash);

    // Ensure connection subdirectory exists
    if (!fs.existsSync(connDir)) {
      fs.mkdirSync(connDir, { recursive: true });
    }

    // Use original filename
    const fileName = path.basename(remotePath);
    return path.join(connDir, fileName);
  }

  /**
   * Get backup key for a file
   */
  private getBackupKey(connectionId: string, remotePath: string): string {
    return `${connectionId}:${remotePath}`;
  }

  /**
   * Acquire a lock for file operations to prevent concurrent access
   * Returns a release function that must be called when done
   */
  private async acquireFileLock(localPath: string): Promise<() => void> {
    // Wait for any existing operation to complete
    const existingLock = this.fileOperationLocks.get(localPath);
    if (existingLock) {
      await existingLock;
    }

    // Create a new lock
    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    this.fileOperationLocks.set(localPath, lockPromise);

    return () => {
      this.fileOperationLocks.delete(localPath);
      releaseFn!();
    };
  }

  /**
   * Save a backup of file content before upload
   */
  private saveBackup(connectionId: string, remotePath: string, content: string, hostName: string): void {
    const key = this.getBackupKey(connectionId, remotePath);
    let backups = this.backupHistory.get(key) || [];

    // Add new backup
    backups.unshift({
      connectionId,
      remotePath,
      content,
      timestamp: Date.now(),
      hostName,
    });

    // Keep only last N backups
    if (backups.length > this.MAX_BACKUPS_PER_FILE) {
      backups = backups.slice(0, this.MAX_BACKUPS_PER_FILE);
    }

    this.backupHistory.set(key, backups);

    // Also save to disk for persistence
    this.saveBackupToDisk(connectionId, remotePath, content);
  }

  /**
   * Save backup to disk file
   */
  private saveBackupToDisk(connectionId: string, remotePath: string, content: string): void {
    try {
      const hash = crypto
        .createHash('md5')
        .update(`${connectionId}:${remotePath}`)
        .digest('hex')
        .substring(0, 8);
      const timestamp = Date.now();
      const ext = path.extname(remotePath);
      const baseName = path.basename(remotePath, ext);
      const backupPath = path.join(this.backupDir, `${baseName}-${hash}-${timestamp}${ext}`);
      fs.writeFileSync(backupPath, content);
    } catch {
      // Ignore backup disk errors
    }
  }

  /**
   * Get backup history for a file
   */
  getBackupHistory(connectionId: string, remotePath: string): BackupEntry[] {
    const key = this.getBackupKey(connectionId, remotePath);
    return this.backupHistory.get(key) || [];
  }

  /**
   * Clear all backup history (for factory reset)
   */
  clearBackupHistory(): void {
    this.backupHistory.clear();
  }

  /**
   * Revert a file to a previous backup
   */
  async revertToBackup(
    connection: SSHConnection,
    remotePath: string,
    backup: BackupEntry
  ): Promise<boolean> {
    try {
      const content = Buffer.from(backup.content, 'utf-8');
      await connection.writeFile(remotePath, content);

      // Update local file if open
      const localPath = this.findLocalPath(connection.id, remotePath);
      if (localPath) {
        const mapping = this.fileMappings.get(localPath);
        if (mapping) {
          // Write to disk first
          this.ensureTempDir();
          fs.writeFileSync(localPath, content);

          // Update editor content if open
          const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
          if (document) {
            this.skipNextSave.add(localPath);
            // Revert document to reload from disk
            await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
          }
          mapping.originalContent = backup.content;
          mapping.lastSyncTime = Date.now();
        }
      }

      vscode.window.setStatusBarMessage(
        `$(check) Reverted ${path.basename(remotePath)}`, 3000
      );
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to revert: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Find local path for a remote file
   */
  private findLocalPath(connectionId: string, remotePath: string): string | undefined {
    for (const [localPath, mapping] of this.fileMappings) {
      if (mapping.connectionId === connectionId && mapping.remotePath === remotePath) {
        return localPath;
      }
    }
    return undefined;
  }

  /**
   * Create a backup of the original file on the remote server
   * Called when a file is first opened for editing
   */
  async createServerBackup(connection: SSHConnection, remotePath: string): Promise<string | undefined> {
    try {
      // Generate backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = path.extname(remotePath);
      const baseName = path.basename(remotePath, ext);
      const backupFileName = `${baseName}_${timestamp}${ext}`;
      const backupPath = `${SERVER_BACKUP_FOLDER}/${backupFileName}`;

      // Ensure backup folder exists and copy file in one command (more reliable)
      // Use || true to prevent errors from propagating
      await connection.exec(
        `mkdir -p ${SERVER_BACKUP_FOLDER} 2>/dev/null; cp "${remotePath}" "${backupPath}" 2>/dev/null || true`
      );

      // Verify backup was created
      const verifyResult = await connection.exec(`test -f "${backupPath}" && echo "ok" || echo "fail"`).catch(() => 'fail');
      if (verifyResult.trim() === 'ok') {
        vscode.window.setStatusBarMessage(`$(archive) Server backup: ${backupFileName}`, 2000);
        return backupPath;
      }

      // Backup failed silently - no error shown to user
      return undefined;
    } catch {
      // Silently fail - backup is optional and shouldn't interrupt workflow
      return undefined;
    }
  }

  /**
   * List ALL server backups (for backup viewer UI)
   */
  async listAllServerBackups(connection: SSHConnection): Promise<{name: string, path: string, timestamp: Date, size: number, isDirectory: boolean}[]> {
    try {
      // List all files in backup folder with size
      const result = await connection.exec(
        `ls -lh ${SERVER_BACKUP_FOLDER} 2>/dev/null | tail -n +2 || true`
      );
      const lines = result.trim().split('\n').filter((f) => f.length > 0);

      return lines.map((line) => {
        // Parse ls -lh output: -rw-r--r-- 1 user group 1.5K Jan 21 12:30 filename
        const parts = line.split(/\s+/);
        const sizeStr = parts[4] || '0';
        const fileName = parts.slice(8).join(' ');
        const filePath = `${SERVER_BACKUP_FOLDER}/${fileName}`;
        const isDirectory = fileName.endsWith('.tar.gz');

        // Parse size (1.5K, 2M, etc.)
        let size = 0;
        const sizeMatch = sizeStr.match(/^([\d.]+)([KMGT]?)$/i);
        if (sizeMatch) {
          const num = parseFloat(sizeMatch[1]);
          const unit = (sizeMatch[2] || '').toUpperCase();
          const multipliers: Record<string, number> = { '': 1, 'K': 1024, 'M': 1024 * 1024, 'G': 1024 * 1024 * 1024, 'T': 1024 * 1024 * 1024 * 1024 };
          size = num * (multipliers[unit] || 1);
        }

        // Extract timestamp from filename
        const match = fileName.match(/_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
        const timestamp = match ? new Date(match[1].replace(/-/g, (m, i) => i > 9 ? (i === 13 || i === 16 ? ':' : '.') : '-')) : new Date();

        return {
          name: fileName,
          path: filePath,
          timestamp,
          size,
          isDirectory,
        };
      }).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()); // Newest first
    } catch {
      return [];
    }
  }

  /**
   * Show ALL backups UI for a connection
   */
  async showAllBackups(connection: SSHConnection): Promise<void> {
    const backups = await this.listAllServerBackups(connection);

    if (backups.length === 0) {
      vscode.window.showInformationMessage(`No backups found on ${connection.host.name}`);
      return;
    }

    const items = backups.map((backup) => {
      const icon = backup.isDirectory ? '$(folder)' : '$(file)';
      const typeLabel = backup.isDirectory ? 'Folder backup' : 'File backup';
      const originalName = backup.name.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(\.tar\.gz)?/, '');

      return {
        label: `${icon} ${originalName}`,
        description: backup.timestamp.toLocaleString(),
        detail: `${typeLabel} - ${formatFileSize(backup.size)}`,
        backup,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select backup to restore or delete (${backups.length} backup(s) on ${connection.host.name})`,
      ignoreFocusOut: true,
    });

    if (!selected) return;

    const actions = [
      { label: '$(history) Restore', description: 'Restore this backup (current version will be backed up first)', value: 'restore' },
      { label: '$(trash) Delete Backup', description: 'Remove this backup from server', value: 'delete' },
    ];

    // Add view option for non-directory backups
    if (!selected.backup.isDirectory) {
      actions.unshift({ label: '$(eye) View Content', description: 'View backup file content', value: 'view' });
    }

    const action = await vscode.window.showQuickPick(actions, {
      placeHolder: `Action for "${selected.backup.name}"`,
    });

    if (!action) return;

    switch (action.value) {
      case 'view':
        await this.viewBackupContent(connection, selected.backup.path);
        break;
      case 'restore':
        await this.restoreBackupWithConfirmation(connection, selected.backup);
        break;
      case 'delete':
        await this.deleteBackup(connection, selected.backup);
        break;
    }
  }

  /**
   * View content of a backup file
   */
  private async viewBackupContent(connection: SSHConnection, backupPath: string): Promise<void> {
    try {
      const content = await connection.readFile(backupPath);
      const tempPath = path.join(this.tempDir, `backup-view-${path.basename(backupPath)}`);
      fs.writeFileSync(tempPath, content);

      const document = await vscode.workspace.openTextDocument(tempPath);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to view backup: ${(error as Error).message}`);
    }
  }

  /**
   * Restore a backup with confirmation and pre-restore backup
   */
  private async restoreBackupWithConfirmation(
    connection: SSHConnection,
    backup: { name: string; path: string; timestamp: Date; isDirectory: boolean }
  ): Promise<void> {
    // Extract original path from backup name
    const originalName = backup.name.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(\.tar\.gz)?/, '');

    // Ask where to restore
    const restorePath = await vscode.window.showInputBox({
      prompt: 'Restore to path (leave empty to restore to original location)',
      placeHolder: backup.isDirectory ? `/path/to/restore/${originalName}` : `/path/to/restore/${originalName}`,
      value: '',
    });

    if (restorePath === undefined) return; // Cancelled

    const targetPath = restorePath || `~/${originalName}`;

    const confirm = await vscode.window.showWarningMessage(
      `Restore "${backup.name}" to "${targetPath}"?\n\nIf the target exists, it will be backed up first.`,
      { modal: true },
      'Restore'
    );

    if (confirm !== 'Restore') return;

    try {
      // Check if target exists and backup if so
      const existsResult = await connection.exec(`test -e "${targetPath}" && echo "exists" || echo "not_exists"`);
      if (existsResult.trim() === 'exists') {
        // Create backup of current version before restore
        if (backup.isDirectory) {
          await this.createDirectoryBackup(connection, targetPath);
        } else {
          await this.createServerBackup(connection, targetPath);
        }
        vscode.window.setStatusBarMessage(`$(archive) Backed up current version`, 2000);
      }

      // Perform restore
      if (backup.isDirectory) {
        // Extract tar.gz
        await connection.exec(`mkdir -p "${path.dirname(targetPath)}" && tar -xzf "${backup.path}" -C "${path.dirname(targetPath)}"`);
      } else {
        // Copy file
        await connection.exec(`mkdir -p "${path.dirname(targetPath)}" && cp "${backup.path}" "${targetPath}"`);
      }

      vscode.window.showInformationMessage(`Restored "${originalName}" to ${targetPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to restore: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a backup from server
   */
  private async deleteBackup(
    connection: SSHConnection,
    backup: { name: string; path: string }
  ): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete backup "${backup.name}"? This cannot be undone.`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') return;

    try {
      await connection.exec(`rm -f "${backup.path}"`);
      vscode.window.setStatusBarMessage(`$(check) Deleted backup: ${backup.name}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete backup: ${(error as Error).message}`);
    }
  }

  /**
   * List all server backups for a remote file
   */
  async listServerBackups(connection: SSHConnection, remotePath: string): Promise<{name: string, path: string, timestamp: Date}[]> {
    try {
      const baseName = path.basename(remotePath, path.extname(remotePath));
      const ext = path.extname(remotePath);

      // List files matching the pattern
      const result = await connection.exec(`ls -1t ${SERVER_BACKUP_FOLDER}/${baseName}_*${ext} 2>/dev/null || true`);
      const files = result.trim().split('\n').filter((f) => f.length > 0);

      return files.map((filePath) => {
        const fileName = path.basename(filePath);
        // Extract timestamp from filename: baseName_2026-01-19T12-30-45-123Z.ext
        const match = fileName.match(/_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
        const timestamp = match ? new Date(match[1].replace(/-/g, (m, i) => i > 9 ? (i === 13 || i === 16 ? ':' : '.') : '-')) : new Date();

        return {
          name: fileName,
          path: filePath,
          timestamp,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Show diff between current server file and a server backup
   */
  async showServerBackupDiff(connection: SSHConnection, remotePath: string, backupPath: string): Promise<void> {
    try {
      // Download both files to temp for diff
      const currentContent = await connection.readFile(remotePath);
      const backupContent = await connection.readFile(backupPath);

      const currentTempPath = path.join(this.tempDir, `current-${path.basename(remotePath)}`);
      const backupTempPath = path.join(this.tempDir, `backup-${path.basename(backupPath)}`);

      fs.writeFileSync(currentTempPath, currentContent);
      fs.writeFileSync(backupTempPath, backupContent);

      const currentUri = vscode.Uri.file(currentTempPath);
      const backupUri = vscode.Uri.file(backupTempPath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        backupUri,
        currentUri,
        `${path.basename(remotePath)} (Backup ↔ Current)`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to show diff: ${(error as Error).message}`);
    }
  }

  /**
   * Restore a file from server backup
   */
  async restoreFromServerBackup(connection: SSHConnection, remotePath: string, backupPath: string): Promise<boolean> {
    try {
      // Create backup of current version before restoring
      await this.createServerBackup(connection, remotePath);

      // Restore from backup
      await connection.exec(`cp "${backupPath}" "${remotePath}"`);

      // Update local file if open
      const localPath = this.findLocalPath(connection.id, remotePath);
      if (localPath) {
        const mapping = this.fileMappings.get(localPath);
        if (mapping) {
          const content = await connection.readFile(remotePath);
          const contentStr = content.toString('utf-8');

          // Write to disk first
          this.ensureTempDir();
          fs.writeFileSync(localPath, content);

          const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
          if (document) {
            this.skipNextSave.add(localPath);
            // Revert document to reload from disk
            await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
          }
          mapping.originalContent = contentStr;
          mapping.lastSyncTime = Date.now();
        }
      }

      vscode.window.setStatusBarMessage(`$(check) Restored ${path.basename(remotePath)}`, 3000);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to restore: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Show picker to select and restore from server backup
   */
  async showServerBackupPicker(connection: SSHConnection, remotePath: string): Promise<void> {
    const backups = await this.listServerBackups(connection, remotePath);

    if (backups.length === 0) {
      vscode.window.showInformationMessage(`No server backups found for ${path.basename(remotePath)}`);
      return;
    }

    const items = backups.map((backup, index) => ({
      label: `$(history) ${backup.timestamp.toLocaleString()}`,
      description: index === 0 ? '(Most Recent)' : '',
      detail: backup.name,
      backup,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select server backup for ${path.basename(remotePath)}`,
      ignoreFocusOut: true,
    });

    if (!selected) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(eye) View Diff', description: 'Compare backup with current version', value: 'diff' },
        { label: '$(history) Restore', description: 'Restore this backup to server', value: 'restore' },
      ],
      { placeHolder: 'What do you want to do?' }
    );

    if (!action) return;

    if (action.value === 'diff') {
      await this.showServerBackupDiff(connection, remotePath, selected.backup.path);
    } else if (action.value === 'restore') {
      const confirm = await vscode.window.showWarningMessage(
        `Restore "${path.basename(remotePath)}" from backup ${selected.backup.timestamp.toLocaleString()}?`,
        { modal: true },
        'Restore'
      );

      if (confirm === 'Restore') {
        await this.restoreFromServerBackup(connection, remotePath, selected.backup.path);
      }
    }
  }

  /**
   * Show combined backup logs (both local and server-side backups)
   */
  async showBackupLogs(connection: SSHConnection, remotePath: string): Promise<void> {
    const fileName = path.basename(remotePath);

    // Gather both local and server backups
    const localBackups = this.getBackupHistory(connection.id, remotePath);
    const serverBackups = await this.listServerBackups(connection, remotePath);

    if (localBackups.length === 0 && serverBackups.length === 0) {
      vscode.window.showInformationMessage(`No backups found for ${fileName}`);
      return;
    }

    // Build combined list of backup items
    interface BackupItem {
      label: string;
      description: string;
      detail: string;
      type: 'local' | 'server';
      localBackup?: BackupEntry;
      serverBackup?: { name: string; path: string; timestamp: Date };
    }

    const items: BackupItem[] = [];

    // Add local backups
    for (const backup of localBackups) {
      items.push({
        label: `$(file) ${new Date(backup.timestamp).toLocaleString()}`,
        description: 'Local backup',
        detail: `Size: ${formatFileSize(backup.content.length)} - Host: ${backup.hostName}`,
        type: 'local',
        localBackup: backup,
      });
    }

    // Add server backups
    for (const backup of serverBackups) {
      items.push({
        label: `$(server) ${backup.timestamp.toLocaleString()}`,
        description: 'Server backup',
        detail: backup.name,
        type: 'server',
        serverBackup: backup,
      });
    }

    // Sort by timestamp (newest first)
    items.sort((a, b) => {
      const timeA = a.type === 'local' ? a.localBackup!.timestamp : a.serverBackup!.timestamp.getTime();
      const timeB = b.type === 'local' ? b.localBackup!.timestamp : b.serverBackup!.timestamp.getTime();
      return timeB - timeA;
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Backup history for ${fileName} (${items.length} backup${items.length > 1 ? 's' : ''})`,
      ignoreFocusOut: true,
    });

    if (!selected) return;

    // Show action menu
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(eye) View Diff', description: 'Compare with current version', value: 'diff' },
        { label: '$(history) Restore', description: 'Restore this backup', value: 'restore' },
      ],
      { placeHolder: 'What do you want to do?' }
    );

    if (!action) return;

    if (selected.type === 'local') {
      if (action.value === 'diff') {
        // Show diff for local backup
        await this.showLocalBackupDiff(connection, remotePath, selected.localBackup!);
      } else {
        const confirm = await vscode.window.showWarningMessage(
          `Restore "${fileName}" from local backup ${new Date(selected.localBackup!.timestamp).toLocaleString()}?`,
          { modal: true },
          'Restore'
        );
        if (confirm === 'Restore') {
          await this.revertToBackup(connection, remotePath, selected.localBackup!);
        }
      }
    } else {
      if (action.value === 'diff') {
        await this.showServerBackupDiff(connection, remotePath, selected.serverBackup!.path);
      } else {
        const confirm = await vscode.window.showWarningMessage(
          `Restore "${fileName}" from server backup ${selected.serverBackup!.timestamp.toLocaleString()}?`,
          { modal: true },
          'Restore'
        );
        if (confirm === 'Restore') {
          await this.restoreFromServerBackup(connection, remotePath, selected.serverBackup!.path);
        }
      }
    }
  }

  /**
   * Show diff between current file and a local backup
   */
  private async showLocalBackupDiff(connection: SSHConnection, remotePath: string, backup: BackupEntry): Promise<void> {
    try {
      // Get current content from server
      const currentContent = await connection.readFile(remotePath);

      const currentTempPath = path.join(this.tempDir, `current-${path.basename(remotePath)}`);
      const backupTempPath = path.join(this.tempDir, `local-backup-${path.basename(remotePath)}`);

      fs.writeFileSync(currentTempPath, currentContent);
      fs.writeFileSync(backupTempPath, backup.content);

      const currentUri = vscode.Uri.file(currentTempPath);
      const backupUri = vscode.Uri.file(backupTempPath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        backupUri,
        currentUri,
        `${path.basename(remotePath)} (Local Backup ↔ Current)`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to show diff: ${(error as Error).message}`);
    }
  }

  /**
   * Open server backup folder in terminal or show listing
   */
  async openServerBackupFolder(connection: SSHConnection): Promise<void> {
    try {
      // List all files in the backup folder
      const result = await connection.exec(`ls -lh ${SERVER_BACKUP_FOLDER} 2>/dev/null || echo "No backups found"`);

      if (result.includes('No backups found') || result.trim() === '') {
        vscode.window.showInformationMessage(`No server backups found on ${connection.host.name}`);
        return;
      }

      // Show in output panel
      const outputChannel = vscode.window.createOutputChannel(`SSH Lite - Server Backups (${connection.host.name})`);
      outputChannel.clear();
      outputChannel.appendLine(`=== Server Backup Folder: ${SERVER_BACKUP_FOLDER} ===`);
      outputChannel.appendLine(`=== Host: ${connection.host.name} (${connection.host.username}@${connection.host.host}) ===`);
      outputChannel.appendLine('');
      outputChannel.appendLine(result);
      outputChannel.show();

      // Also offer to open terminal at that location
      const action = await vscode.window.showInformationMessage(
        `Server backups listed in output panel`,
        'Open Terminal Here',
        'Clear All Backups'
      );

      if (action === 'Open Terminal Here') {
        // Import TerminalService and open terminal with cd command
        const { TerminalService } = await import('./TerminalService');
        const terminalService = TerminalService.getInstance();
        const terminal = await terminalService.createTerminal(connection);
        if (terminal) {
          terminal.sendText(`cd ${SERVER_BACKUP_FOLDER}`);
        }
      } else if (action === 'Clear All Backups') {
        const confirm = await vscode.window.showWarningMessage(
          `Clear all server backups on ${connection.host.name}?`,
          { modal: true },
          'Clear'
        );
        if (confirm === 'Clear') {
          const count = await this.clearServerBackups(connection);
          vscode.window.setStatusBarMessage(`$(check) Cleared ${count} backup(s)`, 3000);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to access server backup folder: ${(error as Error).message}`);
    }
  }

  /**
   * Clean up old server backups based on retention settings
   */
  async cleanupServerBackups(connection: SSHConnection): Promise<number> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const retentionHours = config.get<number>('tempFileRetentionHours', 504);

    if (retentionHours <= 0) {
      return 0;
    }

    try {
      // Delete files older than retention period
      const retentionMinutes = retentionHours * 60;
      const result = await connection.exec(
        `find ${SERVER_BACKUP_FOLDER} -type f -mmin +${retentionMinutes} -delete 2>/dev/null; ` +
        `find ${SERVER_BACKUP_FOLDER} -type f -mmin +${retentionMinutes} 2>/dev/null | wc -l || echo 0`
      );

      const deletedCount = parseInt(result.trim(), 10) || 0;
      return deletedCount;
    } catch {
      return 0;
    }
  }

  /**
   * Delete all server backups for a connection
   */
  async clearServerBackups(connection: SSHConnection): Promise<number> {
    try {
      const result = await connection.exec(
        `ls -1 ${SERVER_BACKUP_FOLDER} 2>/dev/null | wc -l; rm -rf ${SERVER_BACKUP_FOLDER}/* 2>/dev/null || true`
      );
      const count = parseInt(result.split('\n')[0].trim(), 10) || 0;
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Setup listener for file saves
   */
  private setupSaveListener(): void {
    this.saveListenerDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
      this.handleFileSave(document);
    });
  }

  /**
   * Handle file save event
   */
  private handleFileSave(document: vscode.TextDocument): void {
    const localPath = document.uri.fsPath;

    // Check if we should skip this save (used after loading to clear dirty state)
    if (this.skipNextSave.has(localPath)) {
      this.skipNextSave.delete(localPath);
      return;
    }

    const config = vscode.workspace.getConfiguration('sshLite');
    const autoUpload = config.get<boolean>('autoUploadOnSave', true);

    if (!autoUpload) {
      return;
    }

    const mapping = this.fileMappings.get(localPath);

    if (!mapping) {
      return;
    }

    // Debounce uploads
    const debounceMs = config.get<number>('uploadDebounceMs', 500);
    const existingTimer = this.debounceTimers.get(localPath);

    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(localPath);
      await this.uploadFileWithAudit(mapping, document.getText());
    }, debounceMs);

    this.debounceTimers.set(localPath, timer);
  }

  /**
   * Upload a file after save with audit logging
   */
  private async uploadFileWithAudit(mapping: FileMapping, newContent: string): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      vscode.window.showWarningMessage(
        `Cannot upload: connection to ${mapping.connectionId} is no longer active`
      );
      return;
    }

    // Check if upload confirmation is enabled
    const config = vscode.workspace.getConfiguration('sshLite');
    const confirmUpload = config.get<boolean>('confirmUpload', false);

    if (confirmUpload) {
      const fileName = path.basename(mapping.remotePath);
      const fileSize = Buffer.byteLength(newContent, 'utf-8');
      const oldSize = mapping.originalContent ? Buffer.byteLength(mapping.originalContent, 'utf-8') : 0;
      const sizeDiff = fileSize - oldSize;
      const sizeDiffStr = sizeDiff >= 0 ? `+${formatFileSize(sizeDiff)}` : `-${formatFileSize(Math.abs(sizeDiff))}`;

      // Show detailed confirmation with file info
      const items = [
        {
          label: '$(cloud-upload) Upload',
          description: 'Upload file to server',
          detail: `${fileName} → ${connection.host.name}:${mapping.remotePath}`,
          value: 'upload',
        },
        {
          label: '$(eye) View Changes',
          description: 'Compare local changes with server version',
          detail: `Size: ${formatFileSize(fileSize)} (${sizeDiffStr})`,
          value: 'diff',
        },
        {
          label: '$(x) Cancel',
          description: 'Cancel upload',
          detail: 'Changes will remain in local editor only',
          value: 'cancel',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Upload "${fileName}" to ${connection.host.name}?`,
        title: 'Confirm File Upload',
        ignoreFocusOut: true,
      });

      if (!selected || selected.value === 'cancel') {
        vscode.window.setStatusBarMessage(`$(x) Upload cancelled`, 2000);
        return;
      }

      if (selected.value === 'diff') {
        // Show diff before upload
        await this.showUploadDiff(mapping, newContent);
        return; // User can save again after reviewing
      }
    }

    // Save backup of old content before upload
    const oldContent = mapping.originalContent || '';
    if (oldContent) {
      this.saveBackup(
        connection.id,
        mapping.remotePath,
        oldContent,
        connection.host.name
      );
    }

    try {
      const content = Buffer.from(newContent, 'utf-8');
      await connection.writeFile(mapping.remotePath, content);

      // Log to audit trail with diff
      this.auditService.logEdit(
        connection.id,
        connection.host.name,
        connection.host.username,
        mapping.remotePath,
        mapping.localPath,
        oldContent,
        newContent,
        true
      );

      // Update original content and size for next diff and smart refresh
      mapping.originalContent = newContent;
      mapping.lastRemoteSize = content.length;
      mapping.lastSyncTime = Date.now();

      // Show info notification with revert option
      const backups = this.getBackupHistory(connection.id, mapping.remotePath);
      if (backups.length > 0) {
        vscode.window.showInformationMessage(
          `$(cloud-upload) Uploaded ${path.basename(mapping.remotePath)} to ${connection.host.name}`,
          'Revert'
        ).then((action) => {
          if (action === 'Revert') {
            this.showRevertPicker(connection, mapping.remotePath);
          }
        });
      } else {
        vscode.window.setStatusBarMessage(
          `$(cloud-upload) Uploaded to ${path.basename(mapping.remotePath)}`,
          3000
        );
      }
    } catch (error) {
      // Log failed upload
      this.auditService.logEdit(
        connection.id,
        connection.host.name,
        connection.host.username,
        mapping.remotePath,
        mapping.localPath,
        oldContent,
        newContent,
        false,
        (error as Error).message
      );
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Show diff between local changes and original content
   */
  private async showUploadDiff(mapping: FileMapping, newContent: string): Promise<void> {
    try {
      const oldContent = mapping.originalContent || '';

      // Create temp files for diff
      const oldTempPath = path.join(this.tempDir, `diff-old-${path.basename(mapping.remotePath)}`);
      const newTempPath = path.join(this.tempDir, `diff-new-${path.basename(mapping.remotePath)}`);

      fs.writeFileSync(oldTempPath, oldContent);
      fs.writeFileSync(newTempPath, newContent);

      const oldUri = vscode.Uri.file(oldTempPath);
      const newUri = vscode.Uri.file(newTempPath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        newUri,
        `${path.basename(mapping.remotePath)} (Server ↔ Your Changes)`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to show diff: ${(error as Error).message}`);
    }
  }

  /**
   * Show picker for selecting backup to revert to
   */
  async showRevertPicker(connection: SSHConnection, remotePath: string): Promise<void> {
    const backups = this.getBackupHistory(connection.id, remotePath);

    if (backups.length === 0) {
      vscode.window.showInformationMessage('No backups available for this file');
      return;
    }

    const items = backups.map((backup, index) => ({
      label: `$(history) ${new Date(backup.timestamp).toLocaleString()}`,
      description: index === 0 ? '(Most Recent)' : '',
      detail: `${formatFileSize(backup.content.length)} - ${backup.hostName}`,
      backup,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select backup to revert ${path.basename(remotePath)}`,
      ignoreFocusOut: true,
    });

    if (selected) {
      const confirm = await vscode.window.showWarningMessage(
        `Revert "${path.basename(remotePath)}" to backup from ${new Date(selected.backup.timestamp).toLocaleString()}?`,
        { modal: true },
        'Revert'
      );

      if (confirm === 'Revert') {
        await this.revertToBackup(connection, remotePath, selected.backup);
      }
    }
  }

  /**
   * Start global refresh timer for all opened files
   * Prioritizes focused file, then refreshes others
   */
  private startGlobalRefreshTimer(): void {
    const config = vscode.workspace.getConfiguration('sshLite');
    const refreshInterval = config.get<number>('fileRefreshIntervalSeconds', 0);

    if (refreshInterval <= 0) {
      return;
    }

    // Clear existing timer
    if (this.globalRefreshTimer) {
      clearInterval(this.globalRefreshTimer);
    }

    this.globalRefreshTimer = setInterval(async () => {
      // Skip if previous refresh cycle is still running
      if (this.globalRefreshRunning) {
        return;
      }
      this.globalRefreshRunning = true;
      try {
        await this.refreshOpenedFiles();
      } finally {
        this.globalRefreshRunning = false;
      }
    }, refreshInterval * 1000);
  }

  /**
   * Stop global refresh timer
   */
  private stopGlobalRefreshTimer(): void {
    if (this.globalRefreshTimer) {
      clearInterval(this.globalRefreshTimer);
      this.globalRefreshTimer = null;
    }
  }

  /**
   * Refresh all opened files - focused file first, then others
   * Uses per-connection tracking to allow parallel refresh of different connections
   */
  private async refreshOpenedFiles(): Promise<void> {
    if (this.fileMappings.size === 0) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const focusedPath = activeEditor?.document.uri.fsPath;

    // Group mappings by connectionId for parallel refresh
    // Create snapshot to avoid concurrent modification during iteration
    const mappingsByConnection = new Map<string, Array<[string, FileMapping]>>();
    const mappingsSnapshot = Array.from(this.fileMappings.entries());
    for (const [localPath, mapping] of mappingsSnapshot) {
      const group = mappingsByConnection.get(mapping.connectionId) || [];
      group.push([localPath, mapping]);
      mappingsByConnection.set(mapping.connectionId, group);
    }

    // Refresh each connection's files in parallel (but files within each connection sequentially)
    const refreshPromises: Promise<void>[] = [];

    for (const [connectionId, mappings] of mappingsByConnection) {
      // Skip if this connection is already refreshing
      if (this.refreshingConnections.has(connectionId)) {
        continue;
      }

      this.refreshingConnections.add(connectionId);

      const refreshConnection = async () => {
        try {
          // Find focused file for this connection
          const focusedMapping = focusedPath ? mappings.find(([lp]) => lp === focusedPath) : null;

          // Refresh focused file first if it belongs to this connection
          if (focusedMapping) {
            const fileName = path.basename(focusedMapping[1].remotePath);
            vscode.window.setStatusBarMessage(`$(sync~spin) Refreshing ${fileName}...`, 2000);
            await this.refreshSingleFile(focusedMapping[0], focusedMapping[1], true);
          }

          // Refresh other non-focused files in this connection
          for (const [localPath, mapping] of mappings) {
            if (localPath !== focusedPath) {
              await this.refreshSingleFile(localPath, mapping, false);
            }
          }
        } finally {
          this.refreshingConnections.delete(connectionId);
        }
      };

      refreshPromises.push(refreshConnection());
    }

    // Wait for all connections to finish refreshing
    await Promise.all(refreshPromises);
  }

  /**
   * Get smart refresh threshold from configuration
   */
  private getSmartRefreshThreshold(): number {
    const config = vscode.workspace.getConfiguration('sshLite');
    return config.get<number>('smartRefreshThreshold', DEFAULT_SMART_REFRESH_THRESHOLD);
  }

  /**
   * Refresh a single file from remote using smart optimization
   * For files > threshold that grew: fetch only new bytes (tail)
   * For other cases: fetch entire file
   */
  private async refreshSingleFile(localPath: string, mapping: FileMapping, isFocused: boolean): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      return;
    }

    // Check if local file still exists - if not, clean up the mapping
    if (!fs.existsSync(localPath)) {
      // Check if the document is still open in VS Code
      const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
      if (!document) {
        // File deleted and not open - remove mapping
        this.fileMappings.delete(localPath);
        return;
      }
      // Document is open but file deleted - recreate temp directory and file
      this.ensureTempDir();
    }

    // Try to acquire lock - if already locked, skip this refresh cycle
    const existingLock = this.fileOperationLocks.get(localPath);
    if (existingLock) {
      // Another operation is in progress, skip this refresh
      return;
    }

    const releaseLock = await this.acquireFileLock(localPath);

    try {
      // Step 1: Get current remote file stats
      const stats = await connection.stat(mapping.remotePath);
      const currentSize = stats.size;
      const previousSize = mapping.lastRemoteSize ?? 0;
      const smartThreshold = this.getSmartRefreshThreshold();

      let content: Buffer;
      let usedSmartRefresh = false;

      // Step 2: Smart refresh decision tree
      // Use tail optimization if: threshold > 0, file is large, file grew (not shrunk or replaced)
      if (smartThreshold > 0 && previousSize > 0 && currentSize > smartThreshold && currentSize > previousSize) {
        // File is large and grew - use tail optimization to fetch only new bytes
        try {
          const newBytes = await connection.readFileTail(mapping.remotePath, previousSize);

          // Read existing local content
          const existingContent = fs.readFileSync(localPath);

          // Append new bytes to existing content
          content = Buffer.concat([existingContent, newBytes]);
          usedSmartRefresh = true;

          if (isFocused) {
            const savedBytes = formatFileSize(previousSize);
            vscode.window.setStatusBarMessage(
              `$(zap) Smart refresh: ${path.basename(mapping.remotePath)} (+${formatFileSize(newBytes.length)}, saved ${savedBytes})`,
              2000
            );
          }
        } catch {
          // Fallback to full download if tail fails (e.g., tail not available, encoding issues)
          content = await connection.readFile(mapping.remotePath);
        }
      } else {
        // File is small, shrunk, same size, or first refresh - full download
        content = await connection.readFile(mapping.remotePath);
      }

      const newContent = content.toString('utf-8');

      // Step 3: Check if content actually changed
      if (newContent !== mapping.originalContent) {
        // Find if document is open in VS Code
        const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);

        if (document && !document.isDirty) {
          // Document is open and clean - write to disk first, then revert to pick up changes
          this.ensureTempDir();
          fs.writeFileSync(localPath, content);

          // Skip the upload on save - we're syncing FROM remote, not TO remote
          this.skipNextSave.add(localPath);

          // Revert document to reload from disk (safer than WorkspaceEdit + save)
          await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);

          // Update mapping after successful refresh
          mapping.originalContent = newContent;
          mapping.lastRemoteSize = currentSize;
          mapping.lastSyncTime = Date.now();

          if (isFocused && !usedSmartRefresh) {
            vscode.window.setStatusBarMessage(`$(sync) Auto-refreshed ${path.basename(mapping.remotePath)}`, 2000);
          }
        } else if (document?.isDirty && isFocused) {
          // Only notify for focused file with unsaved changes
          vscode.window.showWarningMessage(
            `Remote file "${path.basename(mapping.remotePath)}" changed. You have unsaved local changes.`,
            'Reload (lose changes)',
            'Keep local'
          ).then(async (action) => {
            if (action === 'Reload (lose changes)') {
              await this.reloadRemoteFile(localPath, mapping, connection);
            }
          });
        } else if (!document) {
          // Document not open in editor - just update the file on disk
          this.ensureTempDir();
          fs.writeFileSync(localPath, content);
          mapping.originalContent = newContent;
          mapping.lastRemoteSize = currentSize;
          mapping.lastSyncTime = Date.now();
        }
      } else {
        // Content unchanged but update size tracking
        mapping.lastRemoteSize = currentSize;
      }
    } catch {
      // Ignore errors during refresh (connection might be temporarily down)
    } finally {
      releaseLock();
    }
  }

  /**
   * Refresh a single open file from the remote server
   * Used by the inline refresh button
   */
  async refreshOpenFile(connection: SSHConnection, remotePath: string): Promise<void> {
    // Find the local path for this remote file
    const localPath = this.findLocalPath(connection.id, remotePath);
    if (!localPath) {
      vscode.window.showWarningMessage('File is not currently open for editing');
      return;
    }

    const mapping = this.fileMappings.get(localPath);
    if (!mapping) {
      return;
    }

    // Acquire lock to prevent concurrent operations
    const releaseLock = await this.acquireFileLock(localPath);

    try {
      vscode.window.setStatusBarMessage(`$(sync~spin) Refreshing ${path.basename(remotePath)}...`, 5000);

      // Ensure temp directory exists
      this.ensureTempDir();

      const content = await connection.readFile(remotePath);
      const newContent = content.toString('utf-8');

      // Find if document is open in VS Code
      const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);

      if (document) {
        if (document.isDirty) {
          // Document has unsaved changes - ask user
          const action = await vscode.window.showWarningMessage(
            `File "${path.basename(remotePath)}" has unsaved local changes. Reload from server?`,
            'Reload (lose changes)',
            'Cancel'
          );

          if (action !== 'Reload (lose changes)') {
            return;
          }
        }

        // Write to disk first as Buffer
        fs.writeFileSync(localPath, content);

        // Skip the upload on save - we're syncing FROM remote
        this.skipNextSave.add(localPath);

        // Revert document to reload from disk (safer than WorkspaceEdit + save)
        await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
      } else {
        // Document not open in editor - just update the file on disk
        fs.writeFileSync(localPath, content);
      }

      // Update mapping including size for smart refresh
      mapping.originalContent = newContent;
      mapping.lastRemoteSize = content.length;
      mapping.lastSyncTime = Date.now();

      vscode.window.setStatusBarMessage(`$(check) Refreshed ${path.basename(remotePath)}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh file: ${(error as Error).message}`);
    } finally {
      releaseLock();
    }
  }

  /**
   * Reload a file from remote
   */
  private async reloadRemoteFile(
    localPath: string,
    mapping: FileMapping,
    connection: SSHConnection
  ): Promise<void> {
    // Acquire lock to prevent concurrent operations
    const releaseLock = await this.acquireFileLock(localPath);

    try {
      const content = await connection.readFile(mapping.remotePath);
      const contentStr = content.toString('utf-8');

      // Ensure temp directory exists
      this.ensureTempDir();

      // Write to disk first as Buffer
      fs.writeFileSync(localPath, content);

      // Refresh the document in VS Code
      const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
      if (document) {
        // Skip the upload on save - we're syncing FROM remote
        this.skipNextSave.add(localPath);

        // Revert document to reload from disk (safer than WorkspaceEdit + save)
        await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
      }

      mapping.originalContent = contentStr;
      mapping.lastRemoteSize = content.length;
      mapping.lastSyncTime = Date.now();

      vscode.window.setStatusBarMessage(`$(sync) Reloaded ${path.basename(mapping.remotePath)}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to reload file: ${(error as Error).message}`);
    } finally {
      releaseLock();
    }
  }

  /**
   * Show diff between local and remote
   */
  private async showRemoteDiff(
    localPath: string,
    mapping: FileMapping,
    connection: SSHConnection
  ): Promise<void> {
    try {
      const remoteContent = await connection.readFile(mapping.remotePath);
      const remoteTempPath = path.join(
        this.tempDir,
        `remote-${path.basename(mapping.remotePath)}`
      );
      fs.writeFileSync(remoteTempPath, remoteContent);

      const localUri = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(remoteTempPath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        remoteUri,
        localUri,
        `${path.basename(mapping.remotePath)} (Remote ↔ Local)`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to show diff: ${(error as Error).message}`);
    }
  }

  /**
   * Get progressive download threshold from configuration
   */
  private getProgressiveDownloadThreshold(): number {
    const config = vscode.workspace.getConfiguration('sshLite');
    return config.get<number>('progressiveDownloadThreshold', DEFAULT_PROGRESSIVE_CONFIG.threshold);
  }

  /**
   * Open a remote file for editing
   * Downloads content first, then opens editor to avoid corruption issues
   * Uses progressive download for large text files (>threshold)
   */
  async openRemoteFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    // Check for very large files (>100MB) - use old large file handler
    if (remoteFile.size >= LARGE_FILE_THRESHOLD) {
      await this.handleLargeFile(connection, remoteFile);
      return;
    }

    // Check for progressive download threshold (default 1MB)
    // Uses tail-first preview + background download for better UX
    const progressiveThreshold = this.getProgressiveDownloadThreshold();
    if (progressiveThreshold > 0 &&
        remoteFile.size >= progressiveThreshold &&
        !isLikelyBinary(remoteFile.name)) {
      await this.openFileWithProgressiveDownload(connection, remoteFile);
      return;
    }

    // Get local file path (uses connection subdirectory with original filename)
    const localPath = this.getLocalFilePath(connection.id, remoteFile.path);

    // Check if document is already open in VS Code editor (quick check before acquiring lock)
    const existingDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
    if (existingDoc) {
      // Document is open - check if content is loaded or still has placeholder
      const hasMapping = this.fileMappings.has(localPath);
      const isDownloading = this.activeDownloads.has(localPath);

      if (hasMapping) {
        // Content is loaded - just show the document
        await vscode.window.showTextDocument(existingDoc, { preview: false });
        return;
      }

      if (isDownloading) {
        // Download still in progress - show the document and notify user
        await vscode.window.showTextDocument(existingDoc, { preview: false });
        vscode.window.setStatusBarMessage(`$(sync~spin) Download in progress: ${remoteFile.name}...`, 5000);
        return;
      }

      // Document open but no mapping and not downloading - might be stale placeholder
      // Check if content looks like a placeholder
      const content = existingDoc.getText();
      if (content.startsWith('// Loading ') || content.startsWith('// Failed to download')) {
        // Stale placeholder - trigger high-priority refresh with progress
        await this.refreshFileContentWithProgress(connection, remoteFile, existingDoc, localPath);
        return;
      }

      // Unknown state - just show the document
      await vscode.window.showTextDocument(existingDoc, { preview: false });
      return;
    }

    // Acquire lock to prevent concurrent operations on the same file
    const releaseLock = await this.acquireFileLock(localPath);

    try {
      // Re-check after acquiring lock (another operation might have completed)
      const existingMapping = this.fileMappings.get(localPath);
      if (existingMapping && fs.existsSync(localPath)) {
        const existingDocAfterLock = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
        if (existingDocAfterLock) {
          await vscode.window.showTextDocument(existingDocAfterLock, { preview: false });
          return;
        }
        // Document was closed - remove stale mapping and re-download fresh from server
        this.fileMappings.delete(localPath);
      }

      // Ensure temp directory exists
      this.ensureTempDir();

      // Create placeholder file and open tab IMMEDIATELY for instant feedback
      const loadingPlaceholder = `// Loading ${remoteFile.name}...\n// Size: ${formatFileSize(remoteFile.size)}\n// Please wait...`;
      fs.writeFileSync(localPath, loadingPlaceholder);

      // Open tab immediately - user sees instant feedback
      const document = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(document, { preview: false });

      // Download content in background with status bar indicator
      const fileSizeStr = formatFileSize(remoteFile.size);
      vscode.window.setStatusBarMessage(`$(sync~spin) Downloading ${remoteFile.name} (${fileSizeStr})...`, 30000);

      // Mark download as active
      this.activeDownloads.add(localPath);

      try {
        const content = await connection.readFile(remoteFile.path);
        const contentStr = content.toString('utf-8');

        // Skip the save listener for this update (we're writing downloaded content, not user changes)
        this.skipNextSave.add(localPath);

        // Update editor content (this makes document dirty)
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, contentStr);
        await vscode.workspace.applyEdit(edit);

        // Save document - VS Code writes to disk and clears dirty state
        // Don't manually write to disk, let VS Code handle it to avoid conflict detection
        await document.save();

        vscode.window.setStatusBarMessage(`$(check) Downloaded ${remoteFile.name}`, 3000);

        // Store mapping with original content for audit
        const mapping: FileMapping = {
          connectionId: connection.id,
          remotePath: remoteFile.path,
          localPath,
          lastSyncTime: Date.now(),
          lastRemoteModTime: remoteFile.modifiedTime,
          lastRemoteSize: remoteFile.size,
          originalContent: contentStr,
        };
        this.fileMappings.set(localPath, mapping);

        // Create server-side backup in background (non-blocking, silent failure)
        this.createServerBackup(connection, remoteFile.path)
          .then((backupPath) => {
            if (backupPath) {
              mapping.serverBackupPath = backupPath;
            }
          })
          .catch(() => {
            // Silently ignore backup errors
          });

        // Log download
        this.auditService.log({
          action: 'download',
          connectionId: connection.id,
          hostName: connection.host.name,
          username: connection.host.username,
          remotePath: remoteFile.path,
          localPath,
          fileSize: remoteFile.size,
          success: true,
        });

        // Record file open for preloading
        this.folderHistoryService.recordFileOpen(connection.id, remoteFile.path);

        // Start file watcher for real-time updates (mapping must exist first)
        await this.startFileWatch(localPath, mapping);

        // Mark download as complete
        this.activeDownloads.delete(localPath);
      } catch (downloadError) {
        // Mark download as failed
        this.activeDownloads.delete(localPath);

        // Download failed - show error in the placeholder tab
        vscode.window.setStatusBarMessage(`$(error) Download failed: ${remoteFile.name}`, 5000);

        const errorContent = `// Failed to download ${remoteFile.name}\n// Error: ${(downloadError as Error).message}\n// \n// Close this tab and try again.`;
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, errorContent);
        await vscode.workspace.applyEdit(edit);

        throw downloadError; // Re-throw to be caught by outer catch
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load file: ${(error as Error).message}`);

      // Clean up any partial file
      if (fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Refresh file content with progress indicator (high-priority update)
   * Used when clicking on a file that has stale placeholder content
   */
  private async refreshFileContentWithProgress(
    connection: SSHConnection,
    remoteFile: IRemoteFile,
    document: vscode.TextDocument,
    localPath: string
  ): Promise<void> {
    // Show the document first
    await vscode.window.showTextDocument(document, { preview: false });

    // Check if already downloading
    if (this.activeDownloads.has(localPath)) {
      vscode.window.setStatusBarMessage(`$(sync~spin) Download already in progress: ${remoteFile.name}...`, 5000);
      return;
    }

    // Use progress notification for visibility
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Updating ${remoteFile.name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: `Downloading (${formatFileSize(remoteFile.size)})...` });

        // Mark download as active
        this.activeDownloads.add(localPath);

        try {
          const content = await connection.readFile(remoteFile.path);
          const contentStr = content.toString('utf-8');

          // Skip the save listener for this update
          this.skipNextSave.add(localPath);

          // Update editor content
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, fullRange, contentStr);
          await vscode.workspace.applyEdit(edit);

          // Save document
          await document.save();

          progress.report({ message: 'Complete!' });

          // Store mapping
          const mapping: FileMapping = {
            connectionId: connection.id,
            remotePath: remoteFile.path,
            localPath,
            lastSyncTime: Date.now(),
            lastRemoteModTime: remoteFile.modifiedTime,
            lastRemoteSize: remoteFile.size,
            originalContent: contentStr,
          };
          this.fileMappings.set(localPath, mapping);

          // Create server-side backup in background
          this.createServerBackup(connection, remoteFile.path)
            .then((backupPath) => {
              if (backupPath) {
                mapping.serverBackupPath = backupPath;
              }
            })
            .catch(() => {});

          // Log download
          this.auditService.log({
            action: 'download',
            connectionId: connection.id,
            hostName: connection.host.name,
            username: connection.host.username,
            remotePath: remoteFile.path,
            localPath,
            fileSize: remoteFile.size,
            success: true,
          });

          // Record file open
          this.folderHistoryService.recordFileOpen(connection.id, remoteFile.path);

          // Start file watcher
          await this.startFileWatch(localPath, mapping);

          vscode.window.setStatusBarMessage(`$(check) Updated ${remoteFile.name}`, 3000);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update file: ${(error as Error).message}`);
        } finally {
          this.activeDownloads.delete(localPath);
        }
      }
    );
  }

  /**
   * Handle large file opening with options
   */
  private async handleLargeFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const sizeStr = formatFileSize(remoteFile.size);

    const action = await vscode.window.showQuickPick(
      [
        {
          label: '$(cloud-download) Download in Background',
          description: `Download full file (${sizeStr}) and open when ready`,
          value: 'background',
        },
        {
          label: '$(eye) Preview First Lines',
          description: 'Download first 1000 lines to preview',
          value: 'preview',
        },
        {
          label: '$(file-binary) Download to Disk',
          description: 'Save to local disk without opening',
          value: 'disk',
        },
        {
          label: '$(terminal) View with tail/head',
          description: 'Use remote commands to view portions',
          value: 'remote',
        },
      ],
      {
        placeHolder: `Large file detected (${sizeStr}). How would you like to open it?`,
        ignoreFocusOut: true,
      }
    );

    if (!action) {
      return;
    }

    switch (action.value) {
      case 'background':
        await this.downloadLargeFileBackground(connection, remoteFile);
        break;
      case 'preview':
        await this.previewLargeFile(connection, remoteFile);
        break;
      case 'disk':
        await this.downloadFileTo(connection, remoteFile);
        break;
      case 'remote':
        await this.viewLargeFileRemote(connection, remoteFile);
        break;
    }
  }

  /**
   * Open a file using progressive download
   * Shows last N lines instantly as preview, then downloads full file in background
   */
  private async openFileWithProgressiveDownload(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const downloadManager = ProgressiveDownloadManager.getInstance();

    // Check if already downloading
    if (downloadManager.isDownloading(connection.id, remoteFile.path)) {
      vscode.window.showWarningMessage(`Already downloading: ${remoteFile.name}`);
      return;
    }

    // Check if already downloaded and available locally
    const existingLocalPath = downloadManager.getLocalPath(connection.id, remoteFile.path);
    if (existingLocalPath && fs.existsSync(existingLocalPath)) {
      // File already downloaded - open it directly
      const document = await vscode.workspace.openTextDocument(existingLocalPath);
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    // Subscribe to download completion to create file mapping
    // Also subscribe to error events to ensure cleanup
    let completionDisposable: vscode.Disposable | null = null;
    let errorDisposable: vscode.Disposable | null = null;

    const cleanup = () => {
      completionDisposable?.dispose();
      errorDisposable?.dispose();
    };

    completionDisposable = downloadManager.onDownloadComplete(async ({ state, localPath }) => {
      if (state.connectionId === connection.id && state.remotePath === remoteFile.path) {
        // Create file mapping for the downloaded file
        const content = fs.readFileSync(localPath);
        const contentStr = content.toString('utf-8');

        const mapping: FileMapping = {
          connectionId: connection.id,
          remotePath: remoteFile.path,
          localPath,
          lastSyncTime: Date.now(),
          lastRemoteModTime: remoteFile.modifiedTime,
          lastRemoteSize: remoteFile.size,
          originalContent: contentStr,
        };
        this.fileMappings.set(localPath, mapping);

        // Create server-side backup in background
        this.createServerBackup(connection, remoteFile.path)
          .then((backupPath) => {
            if (backupPath) {
              mapping.serverBackupPath = backupPath;
            }
          })
          .catch(() => {
            // Silently ignore backup errors
          });

        // Log download
        this.auditService.log({
          action: 'download',
          connectionId: connection.id,
          hostName: connection.host.name,
          username: connection.host.username,
          remotePath: remoteFile.path,
          localPath,
          fileSize: remoteFile.size,
          success: true,
        });

        // Record file open for preloading
        this.folderHistoryService.recordFileOpen(connection.id, remoteFile.path);

        // Start file watcher for real-time updates
        await this.startFileWatch(localPath, mapping);

        // Cleanup listeners
        cleanup();
      }
    });

    // Subscribe to error events to cleanup on failure
    errorDisposable = downloadManager.onDownloadError(({ state }) => {
      if (state.connectionId === connection.id && state.remotePath === remoteFile.path) {
        cleanup();
      }
    });

    // Start the progressive download (use try-catch to cleanup on immediate failure)
    try {
      await downloadManager.startProgressiveDownload(connection, remoteFile);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /**
   * Download large file in background with progress
   */
  private async downloadLargeFileBackground(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    // Get local file path (uses connection subdirectory with original filename)
    const localPath = this.getLocalFilePath(connection.id, remoteFile.path);

    const fileSizeStr = formatFileSize(remoteFile.size);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${remoteFile.name} (${fileSizeStr})`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // Show initial progress with file size info
          progress.report({ increment: 5, message: `Starting download of ${fileSizeStr}...` });

          // Start the download
          const downloadPromise = connection.readFile(remoteFile.path);

          // Simulate progress during download (5% to 75%) with smooth animation
          let currentProgress = 5;
          const progressInterval = setInterval(() => {
            if (currentProgress < 75 && !token.isCancellationRequested) {
              // Slower progress for larger files to make it feel more realistic
              const increment = Math.min(3, 75 - currentProgress);
              currentProgress += increment;
              progress.report({ increment, message: `Downloading... ${currentProgress}%` });
            }
          }, 300);

          const content = await downloadPromise;
          clearInterval(progressInterval);

          if (token.isCancellationRequested) {
            return;
          }

          progress.report({ increment: 80 - currentProgress, message: 'Writing to disk...' });
          fs.writeFileSync(localPath, content);

          const contentStr = content.toString('utf-8');
          const mapping: FileMapping = {
            connectionId: connection.id,
            remotePath: remoteFile.path,
            localPath,
            lastSyncTime: Date.now(),
            lastRemoteModTime: remoteFile.modifiedTime,
            lastRemoteSize: remoteFile.size, // Initialize size for smart refresh
            originalContent: contentStr,
          };
          this.fileMappings.set(localPath, mapping);

          progress.report({ increment: 10, message: 'Opening editor...' });

          const document = await vscode.workspace.openTextDocument(localPath);
          await vscode.window.showTextDocument(document);

          // Start file watcher for real-time updates
          await this.startFileWatch(localPath, mapping);

          this.auditService.log({
            action: 'download',
            connectionId: connection.id,
            hostName: connection.host.name,
            username: connection.host.username,
            remotePath: remoteFile.path,
            localPath,
            fileSize: remoteFile.size,
            success: true,
          });

          progress.report({ increment: 10, message: 'Complete!' });
        } catch (error) {
          if (!token.isCancellationRequested) {
            vscode.window.showErrorMessage(`Failed to download: ${(error as Error).message}`);
          }
        }
      }
    );
  }

  /**
   * Preview first lines of a large file
   */
  private async previewLargeFile(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    try {
      // Use head command to get first 1000 lines
      const result = await connection.exec(`head -n 1000 "${remoteFile.path}"`);

      // Create a preview document
      const previewPath = path.join(
        this.tempDir,
        `preview-${path.basename(remoteFile.name)}`
      );

      const previewContent =
        `=== PREVIEW: First 1000 lines of ${remoteFile.name} ===\n` +
        `=== Full size: ${formatFileSize(remoteFile.size)} ===\n` +
        `=== Use "Download in Background" for full file ===\n\n` +
        result;

      fs.writeFileSync(previewPath, previewContent);

      const document = await vscode.workspace.openTextDocument(previewPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to preview file: ${(error as Error).message}`);
    }
  }

  /**
   * View large file using remote commands
   */
  private async viewLargeFileRemote(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const command = await vscode.window.showQuickPick(
      [
        { label: 'head -n 100', description: 'First 100 lines', value: `head -n 100 "${remoteFile.path}"` },
        { label: 'head -n 500', description: 'First 500 lines', value: `head -n 500 "${remoteFile.path}"` },
        { label: 'tail -n 100', description: 'Last 100 lines', value: `tail -n 100 "${remoteFile.path}"` },
        { label: 'tail -n 500', description: 'Last 500 lines', value: `tail -n 500 "${remoteFile.path}"` },
        {
          label: 'Custom range',
          description: 'Specify line range',
          value: 'custom',
        },
      ],
      {
        placeHolder: 'Select viewing option',
        ignoreFocusOut: true,
      }
    );

    if (!command) {
      return;
    }

    let cmd = command.value;

    if (cmd === 'custom') {
      const range = await vscode.window.showInputBox({
        prompt: 'Enter line range (e.g., "100,200" for lines 100-200)',
        placeHolder: '100,200',
        ignoreFocusOut: true,
      });

      if (!range) {
        return;
      }

      const [start, end] = range.split(',').map((s) => parseInt(s.trim(), 10));
      if (isNaN(start) || isNaN(end)) {
        vscode.window.showErrorMessage('Invalid range format. Use "start,end" format.');
        return;
      }

      cmd = `sed -n '${start},${end}p' "${remoteFile.path}"`;
    }

    try {
      const result = await connection.exec(cmd);

      const viewPath = path.join(this.tempDir, `view-${path.basename(remoteFile.name)}`);
      fs.writeFileSync(viewPath, result);

      const document = await vscode.workspace.openTextDocument(viewPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to view file: ${(error as Error).message}`);
    }
  }

  /**
   * Download a file to a user-selected location
   */
  async downloadFileTo(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const defaultUri = vscode.Uri.file(path.join(os.homedir(), remoteFile.name));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'All Files': ['*'],
      },
    });

    if (!saveUri) {
      return;
    }

    try {
      const fileSizeStr = formatFileSize(remoteFile.size);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${remoteFile.name} (${fileSizeStr})`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 10, message: 'Starting download...' });

          // Start download with progress simulation
          const downloadPromise = connection.readFile(remoteFile.path);

          let currentProgress = 10;
          const progressInterval = setInterval(() => {
            if (currentProgress < 80) {
              const increment = Math.min(5, 80 - currentProgress);
              currentProgress += increment;
              progress.report({ increment, message: `Downloading... ${currentProgress}%` });
            }
          }, 200);

          const content = await downloadPromise;
          clearInterval(progressInterval);

          progress.report({ increment: 90 - currentProgress, message: 'Saving file...' });
          fs.writeFileSync(saveUri.fsPath, content);
          progress.report({ increment: 10, message: 'Complete!' });
        }
      );

      this.auditService.log({
        action: 'download',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        localPath: saveUri.fsPath,
        fileSize: remoteFile.size,
        success: true,
      });

      vscode.window.setStatusBarMessage(`$(check) Downloaded ${remoteFile.name}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to download file: ${(error as Error).message}`);
    }
  }

  /**
   * Download a folder recursively
   */
  async downloadFolder(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Download Location',
    });

    if (!folderUri || folderUri.length === 0) {
      return;
    }

    const targetDir = path.join(folderUri[0].fsPath, remoteFile.name);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading folder: ${remoteFile.name}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 5, message: 'Scanning folder...' });
          await this.downloadFolderRecursive(connection, remoteFile.path, targetDir, progress, { count: 0 });
          progress.report({ increment: 5, message: 'Complete!' });
        }
      );

      vscode.window.setStatusBarMessage(`$(check) Downloaded folder ${remoteFile.name}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to download folder: ${(error as Error).message}`);
    }
  }

  /**
   * Recursively download a folder
   */
  private async downloadFolderRecursive(
    connection: SSHConnection,
    remotePath: string,
    localPath: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    counter: { count: number }
  ): Promise<void> {
    // Create local directory
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
    }

    // List remote directory
    const files = await connection.listFiles(remotePath);

    for (const file of files) {
      const localFilePath = path.join(localPath, file.name);
      counter.count++;

      if (file.isDirectory) {
        progress.report({ increment: 1, message: `Folder: ${file.name}` });
        await this.downloadFolderRecursive(connection, file.path, localFilePath, progress, counter);
      } else {
        const fileSizeStr = formatFileSize(file.size);
        progress.report({ increment: 1, message: `${file.name} (${fileSizeStr})` });
        const content = await connection.readFile(file.path);
        fs.writeFileSync(localFilePath, content);
      }
    }
  }

  /**
   * Upload a file from local to remote
   */
  async uploadFileTo(connection: SSHConnection, remoteFolderPath: string): Promise<void> {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: 'Select File to Upload',
    });

    if (!fileUri || fileUri.length === 0) {
      return;
    }

    const localPath = fileUri[0].fsPath;
    const fileName = path.basename(localPath);
    const remotePath = `${remoteFolderPath}/${fileName}`;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${fileName}...`,
          cancellable: false,
        },
        async () => {
          const content = fs.readFileSync(localPath);
          await connection.writeFile(remotePath, content);
        }
      );

      this.auditService.log({
        action: 'upload',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath,
        localPath,
        fileSize: fs.statSync(localPath).size,
        success: true,
      });

      vscode.window.setStatusBarMessage(`$(check) Uploaded ${fileName}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a remote file or folder
   */
  async deleteRemote(connection: SSHConnection, remoteFile: IRemoteFile): Promise<boolean> {
    const typeLabel = remoteFile.isDirectory ? 'folder' : 'file';

    // Show warning with backup option
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${remoteFile.name}"?\n\nA backup will be created before deletion.`,
      { modal: true, detail: `This ${typeLabel} will be backed up to ${SERVER_BACKUP_FOLDER} before deletion.` },
      'Delete with Backup',
      'Delete Permanently'
    );

    if (!confirm) {
      return false;
    }

    const createBackup = confirm === 'Delete with Backup';

    try {
      let backupPath: string | undefined;

      // Create backup before deletion
      if (createBackup) {
        if (remoteFile.isDirectory) {
          backupPath = await this.createDirectoryBackup(connection, remoteFile.path);
        } else {
          backupPath = await this.createServerBackup(connection, remoteFile.path);
        }
      }

      // Perform deletion
      if (remoteFile.isDirectory) {
        await this.deleteDirectoryRecursive(connection, remoteFile.path);
      } else {
        await connection.deleteFile(remoteFile.path);
      }

      this.auditService.log({
        action: 'delete',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        fileSize: remoteFile.size,
        success: true,
      });

      // Show notification with backup path and option to view backups
      if (backupPath) {
        const viewBackups = await vscode.window.showInformationMessage(
          `Deleted "${remoteFile.name}". Backup saved.`,
          'View Backups',
          'OK'
        );
        if (viewBackups === 'View Backups') {
          vscode.commands.executeCommand('sshLite.showAllBackups', connection);
        }
      } else {
        vscode.window.setStatusBarMessage(`$(check) Deleted ${remoteFile.name}`, 3000);
      }
      return true;
    } catch (error) {
      this.auditService.log({
        action: 'delete',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        success: false,
        error: (error as Error).message,
      });
      vscode.window.showErrorMessage(`Failed to delete: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Create a backup of a directory (as tar.gz)
   */
  private async createDirectoryBackup(connection: SSHConnection, remotePath: string): Promise<string | undefined> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dirName = path.basename(remotePath);
      const backupFileName = `${dirName}_${timestamp}.tar.gz`;
      const backupPath = `${SERVER_BACKUP_FOLDER}/${backupFileName}`;

      // Create backup folder and tar the directory
      await connection.exec(
        `mkdir -p ${SERVER_BACKUP_FOLDER} 2>/dev/null; cd "${path.dirname(remotePath)}" && tar -czf "${backupPath}" "${dirName}" 2>/dev/null || true`
      );

      // Verify backup was created
      const verifyResult = await connection.exec(`test -f "${backupPath}" && echo "ok" || echo "fail"`).catch(() => 'fail');
      if (verifyResult.trim() === 'ok') {
        return backupPath;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Recursively delete a directory
   */
  private async deleteDirectoryRecursive(connection: SSHConnection, remotePath: string): Promise<void> {
    const files = await connection.listFiles(remotePath);

    for (const file of files) {
      if (file.isDirectory) {
        await this.deleteDirectoryRecursive(connection, file.path);
      } else {
        await connection.deleteFile(file.path);
      }
    }

    await connection.deleteFile(remotePath);
  }

  /**
   * Create a new folder
   */
  async createFolder(connection: SSHConnection, parentPath: string): Promise<string | undefined> {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      placeHolder: 'new-folder',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Folder name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Folder name cannot contain slashes';
        }
        return null;
      },
    });

    if (!folderName) {
      return undefined;
    }

    const remotePath = `${parentPath}/${folderName}`;

    try {
      await connection.mkdir(remotePath);

      this.auditService.log({
        action: 'mkdir',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath,
        success: true,
      });

      vscode.window.setStatusBarMessage(`$(check) Created folder ${folderName}`, 3000);
      return remotePath;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create folder: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Get all open file mappings
   */
  getOpenFiles(): FileMapping[] {
    return Array.from(this.fileMappings.values());
  }

  /**
   * Get mapping for a local file path
   * Handles path normalization for cross-platform compatibility
   */
  getMappingForLocalPath(localPath: string): { connectionId: string; remotePath: string } | undefined {
    // Try exact match first
    const mapping = this.fileMappings.get(localPath);
    if (mapping) {
      return {
        connectionId: mapping.connectionId,
        remotePath: mapping.remotePath,
      };
    }

    // On Windows, paths may have different casing or drive letter format
    // Try case-insensitive search and path normalization
    const normalizedInput = path.normalize(localPath).toLowerCase();
    for (const [storedPath, storedMapping] of this.fileMappings) {
      const normalizedStored = path.normalize(storedPath).toLowerCase();
      if (normalizedInput === normalizedStored) {
        return {
          connectionId: storedMapping.connectionId,
          remotePath: storedMapping.remotePath,
        };
      }
    }

    return undefined;
  }

  /**
   * Get frequently opened files for a connection
   */
  getFrequentFiles(connectionId: string, limit?: number): string[] {
    return this.folderHistoryService.getFrequentFiles(connectionId, limit);
  }

  /**
   * Get max preloading concurrency from settings
   */
  private getMaxPreloadingConcurrency(): number {
    const config = vscode.workspace.getConfiguration('sshLite');
    return config.get<number>('maxPreloadingConcurrency', 2);
  }

  /**
   * Acquire a preload slot (for concurrency limiting)
   * Returns a release function that must be called when done
   */
  private async acquirePreloadSlot(): Promise<() => void> {
    const maxConcurrency = this.getMaxPreloadingConcurrency();

    if (this.activePreloadCount < maxConcurrency) {
      this.activePreloadCount++;
      return () => this.releasePreloadSlot();
    }

    // Wait for a slot to become available
    await new Promise<void>((resolve) => {
      this.preloadWaitQueue.push(resolve);
    });

    this.activePreloadCount++;
    return () => this.releasePreloadSlot();
  }

  /**
   * Release a preload slot
   */
  private releasePreloadSlot(): void {
    this.activePreloadCount--;

    // Wake up next waiting preload if any
    if (this.preloadWaitQueue.length > 0) {
      const next = this.preloadWaitQueue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Cancel all pending file preload operations
   */
  cancelPreloading(): void {
    this.preloadCancelled = true;

    // Wake up all waiting preloads so they can check cancellation
    while (this.preloadWaitQueue.length > 0) {
      const next = this.preloadWaitQueue.shift();
      if (next) {
        next();
      }
    }

    // Resolve the progress if waiting
    if (this.preloadProgressResolve) {
      this.preloadProgressResolve();
      this.preloadProgressResolve = null;
    }
  }

  /**
   * Check if file preloading is in progress
   */
  isPreloadingInProgress(): boolean {
    return this.activePreloadCount > 0;
  }

  /**
   * Get file preload status for UI display
   */
  getPreloadStatus(): { active: number; completed: number; total: number } {
    return {
      active: this.activePreloadCount,
      completed: this.completedPreloadCount,
      total: this.totalPreloadQueued,
    };
  }

  /**
   * Preload frequently opened files for a connection
   * Downloads files in background to cache them locally
   * Respects maxPreloadingConcurrency setting to limit server load
   */
  async preloadFrequentFiles(connection: SSHConnection, limit: number = 5): Promise<void> {
    // Reset cancelled flag if starting fresh preload
    if (this.activePreloadCount === 0) {
      this.preloadCancelled = false;
      this.completedPreloadCount = 0;
      this.totalPreloadQueued = 0;
    }

    if (this.preloadCancelled) {
      return;
    }

    const frequentFiles = this.folderHistoryService.getFrequentFiles(connection.id, limit);

    for (const filePath of frequentFiles) {
      if (this.preloadCancelled) {
        break;
      }

      // Get the same temp file path as openRemoteFile
      const localPath = this.getLocalFilePath(connection.id, filePath);

      // Skip if already cached (file exists and has mapping)
      if (this.fileMappings.has(localPath) && fs.existsSync(localPath)) {
        continue;
      }

      // Skip if lock exists (already being loaded)
      if (this.fileOperationLocks.has(localPath)) {
        continue;
      }

      this.totalPreloadQueued++;

      // Preload with concurrency limiting (non-blocking, silent errors)
      this.preloadFileWithConcurrencyLimit(connection, filePath, localPath).catch(() => {
        /* Silently ignore preload errors */
      });
    }
  }

  /**
   * Preload a file with concurrency limiting
   */
  private async preloadFileWithConcurrencyLimit(
    connection: SSHConnection,
    remotePath: string,
    localPath: string
  ): Promise<void> {
    // Check if cancelled before acquiring slot
    if (this.preloadCancelled) {
      return;
    }

    const releaseSlot = await this.acquirePreloadSlot();

    try {
      // Check again after acquiring slot
      if (this.preloadCancelled) {
        return;
      }
      await this.preloadFile(connection, remotePath, localPath);
    } finally {
      this.completedPreloadCount++;
      releaseSlot();

      // Check if all preloads are done
      if (this.activePreloadCount === 0 && this.preloadProgressResolve) {
        this.preloadProgressResolve();
        this.preloadProgressResolve = null;
      }
    }
  }

  /**
   * Preload a single file in background
   */
  private async preloadFile(connection: SSHConnection, remotePath: string, localPath: string): Promise<void> {
    const releaseLock = await this.acquireFileLock(localPath);

    try {
      // Double check it's still not cached
      if (this.fileMappings.has(localPath) && fs.existsSync(localPath)) {
        return;
      }

      // Ensure temp directory exists
      this.ensureTempDir();

      // Download content
      const content = await connection.readFile(remotePath);
      const contentStr = content.toString('utf-8');

      // Write to disk
      fs.writeFileSync(localPath, content);

      // Store mapping (but don't open the document)
      const mapping: FileMapping = {
        connectionId: connection.id,
        remotePath: remotePath,
        localPath,
        lastSyncTime: Date.now(),
        lastRemoteSize: content.length, // Initialize size for smart refresh
        originalContent: contentStr,
      };
      this.fileMappings.set(localPath, mapping);
    } finally {
      releaseLock();
    }
  }

  /**
   * Get the temp directory path
   */
  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Clean up temp files for a connection
   */
  cleanupConnection(connectionId: string): void {
    // Create snapshot to avoid concurrent modification during iteration
    const mappingsSnapshot = Array.from(this.fileMappings.entries());
    for (const [localPath, mapping] of mappingsSnapshot) {
      if (mapping.connectionId === connectionId) {
        // Clear any pending debounce timer
        const timer = this.debounceTimers.get(localPath);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(localPath);
        }

        // Try to delete the temp file
        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
          }
        } catch {
          // Ignore errors during cleanup
        }
        this.fileMappings.delete(localPath);
      }
    }
  }

  /**
   * Clean up all temp files
   */
  cleanupAll(): void {
    // Create snapshot to avoid concurrent modification during iteration
    const localPaths = Array.from(this.fileMappings.keys());
    for (const localPath of localPaths) {
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.fileMappings.clear();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.cleanupAll();
    this.stopGlobalRefreshTimer();
    this.stopAutoCleanupTimer();
    this.stopFocusedFilePollTimer();

    if (this.saveListenerDisposable) {
      this.saveListenerDisposable.dispose();
    }

    if (this.configChangeListener) {
      this.configChangeListener.dispose();
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
