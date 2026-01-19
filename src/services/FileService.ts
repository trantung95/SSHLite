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
import { formatFileSize } from '../utils/helpers';

/**
 * Large file size threshold (100MB default)
 */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

/**
 * Mapping from local temp file to remote file info
 */
interface FileMapping {
  connectionId: string;
  remotePath: string;
  localPath: string;
  lastSyncTime: number;
  lastRemoteModTime?: number;
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
  private refreshingConnections: Set<string> = new Set(); // Track which connections are currently refreshing
  private auditService: AuditService;
  private folderHistoryService: FolderHistoryService;
  private skipNextSave: Set<string> = new Set(); // Paths to skip upload on next save

  private autoCleanupTimer: NodeJS.Timeout | null = null;

  // Backup storage for file revert (connectionId:remotePath -> BackupEntry[])
  private backupHistory: Map<string, BackupEntry[]> = new Map();
  private readonly MAX_BACKUPS_PER_FILE = 10;

  // Lock for file operations to prevent concurrent access
  private fileOperationLocks: Map<string, Promise<void>> = new Map();

  private constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ssh-lite');
    this.backupDir = path.join(this.tempDir, 'backups');
    this.ensureTempDir();
    this.ensureBackupDir();
    this.setupSaveListener();
    this.setupConfigListener();
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
    for (const [localPath, mapping] of this.fileMappings) {
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
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);

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
    for (const [localPath] of this.fileMappings) {
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

    for (const [localPath, mapping] of this.fileMappings) {
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

      vscode.window.showInformationMessage(
        `Reverted ${path.basename(remotePath)} to backup from ${new Date(backup.timestamp).toLocaleString()}`
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

      vscode.window.showInformationMessage(`Restored ${path.basename(remotePath)} from server backup`);
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
          vscode.window.showInformationMessage(`Cleared ${count} backup(s)`);
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

      // Update original content for next diff
      mapping.originalContent = newContent;
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
      await this.refreshOpenedFiles();
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
    const mappingsByConnection = new Map<string, Array<[string, FileMapping]>>();
    for (const [localPath, mapping] of this.fileMappings.entries()) {
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
   * Refresh a single file from remote
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
      const content = await connection.readFile(mapping.remotePath);
      const newContent = content.toString('utf-8');

      // Check if content actually changed
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
          mapping.lastSyncTime = Date.now();

          if (isFocused) {
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
          mapping.lastSyncTime = Date.now();
        }
      }
    } catch {
      // Ignore errors during refresh
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

      // Update mapping
      mapping.originalContent = newContent;
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
   * Open a remote file for editing
   * Downloads content first, then opens editor to avoid corruption issues
   */
  async openRemoteFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    // Check file size for large file handling
    if (remoteFile.size >= LARGE_FILE_THRESHOLD) {
      await this.handleLargeFile(connection, remoteFile);
      return;
    }

    // Generate unique temp file path
    const hash = crypto
      .createHash('md5')
      .update(`${connection.id}:${remoteFile.path}`)
      .digest('hex')
      .substring(0, 8);
    const ext = path.extname(remoteFile.name);
    const baseName = path.basename(remoteFile.name, ext);
    const localPath = path.join(this.tempDir, `${baseName}-${hash}${ext}`);

    // Check if document is already open in VS Code editor (quick check before acquiring lock)
    const existingDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
    if (existingDoc && this.fileMappings.has(localPath)) {
      // Document is open - just show it (user might have unsaved changes)
      // Use preview: false to ensure it stays open in edit mode
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

      // Show status bar message during download
      vscode.window.setStatusBarMessage(`$(sync~spin) Downloading ${remoteFile.name}...`, 10000);

      // Ensure temp directory exists
      this.ensureTempDir();

      // Download content FIRST before creating any files
      const content = await connection.readFile(remoteFile.path);
      const contentStr = content.toString('utf-8');

      // Write content to disk as Buffer (not string) to avoid encoding issues
      fs.writeFileSync(localPath, content);

      // Now open the document - content is already correct on disk
      // Use preview: false to open in edit mode (non-italic tab)
      const document = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(document, { preview: false });

      // Store mapping with original content for audit
      const mapping: FileMapping = {
        connectionId: connection.id,
        remotePath: remoteFile.path,
        localPath,
        lastSyncTime: Date.now(),
        lastRemoteModTime: remoteFile.modifiedTime,
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

      vscode.window.setStatusBarMessage(`$(check) Loaded ${remoteFile.name}`, 3000);
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
   * Download large file in background with progress
   */
  private async downloadLargeFileBackground(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const hash = crypto
      .createHash('md5')
      .update(`${connection.id}:${remoteFile.path}`)
      .digest('hex')
      .substring(0, 8);
    const ext = path.extname(remoteFile.name);
    const baseName = path.basename(remoteFile.name, ext);
    const localPath = path.join(this.tempDir, `${baseName}-${hash}${ext}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${remoteFile.name} (${formatFileSize(remoteFile.size)})...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // For very large files, we could implement chunked download
          // For now, use standard download with progress indication
          progress.report({ increment: 0, message: 'Starting download...' });

          const content = await connection.readFile(remoteFile.path);

          if (token.isCancellationRequested) {
            return;
          }

          progress.report({ increment: 80, message: 'Writing to disk...' });
          fs.writeFileSync(localPath, content);

          const contentStr = content.toString('utf-8');
          const mapping: FileMapping = {
            connectionId: connection.id,
            remotePath: remoteFile.path,
            localPath,
            lastSyncTime: Date.now(),
            lastRemoteModTime: remoteFile.modifiedTime,
            originalContent: contentStr,
          };
          this.fileMappings.set(localPath, mapping);

          progress.report({ increment: 100, message: 'Opening...' });

          const document = await vscode.workspace.openTextDocument(localPath);
          await vscode.window.showTextDocument(document);

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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${remoteFile.name}...`,
          cancellable: false,
        },
        async () => {
          const content = await connection.readFile(remoteFile.path);
          fs.writeFileSync(saveUri.fsPath, content);
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

      vscode.window.showInformationMessage(`Downloaded ${remoteFile.name} successfully`);
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
          title: `Downloading ${remoteFile.name}...`,
          cancellable: false,
        },
        async (progress) => {
          await this.downloadFolderRecursive(connection, remoteFile.path, targetDir, progress);
        }
      );

      vscode.window.showInformationMessage(`Downloaded ${remoteFile.name} successfully`);
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
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    // Create local directory
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
    }

    // List remote directory
    const files = await connection.listFiles(remotePath);

    for (const file of files) {
      const localFilePath = path.join(localPath, file.name);
      progress.report({ message: file.name });

      if (file.isDirectory) {
        await this.downloadFolderRecursive(connection, file.path, localFilePath, progress);
      } else {
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

      vscode.window.showInformationMessage(`Uploaded ${fileName} successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a remote file or folder
   */
  async deleteRemote(connection: SSHConnection, remoteFile: IRemoteFile): Promise<boolean> {
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${remoteFile.name}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return false;
    }

    try {
      if (remoteFile.isDirectory) {
        // Delete directory contents recursively
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

      vscode.window.showInformationMessage(`Deleted ${remoteFile.name} successfully`);
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

      vscode.window.showInformationMessage(`Created folder ${folderName}`);
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
   * Get frequently opened files for a connection
   */
  getFrequentFiles(connectionId: string, limit?: number): string[] {
    return this.folderHistoryService.getFrequentFiles(connectionId, limit);
  }

  /**
   * Preload frequently opened files for a connection
   * Downloads files in background to cache them locally
   */
  async preloadFrequentFiles(connection: SSHConnection, limit: number = 5): Promise<void> {
    const frequentFiles = this.folderHistoryService.getFrequentFiles(connection.id, limit);

    for (const filePath of frequentFiles) {
      // Generate the same temp file path as openRemoteFile
      const hash = crypto
        .createHash('md5')
        .update(`${connection.id}:${filePath}`)
        .digest('hex')
        .substring(0, 8);
      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const localPath = path.join(this.tempDir, `${baseName}-${hash}${ext}`);

      // Skip if already cached (file exists and has mapping)
      if (this.fileMappings.has(localPath) && fs.existsSync(localPath)) {
        continue;
      }

      // Skip if lock exists (already being loaded)
      if (this.fileOperationLocks.has(localPath)) {
        continue;
      }

      // Preload in background (non-blocking, silent errors)
      this.preloadFile(connection, filePath, localPath).catch(() => {
        /* Silently ignore preload errors */
      });
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
    for (const [localPath, mapping] of this.fileMappings) {
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
    for (const [localPath] of this.fileMappings) {
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
