import * as vscode from 'vscode';

/**
 * Folder visit entry
 */
interface FolderVisit {
  path: string;
  visitCount: number;
  lastVisit: number;
}

/**
 * File visit entry
 */
interface FileVisit {
  path: string;
  visitCount: number;
  lastVisit: number;
}

/**
 * Folder history per connection
 */
interface ConnectionFolderHistory {
  [connectionId: string]: FolderVisit[];
}

/**
 * File history per connection
 */
interface ConnectionFileHistory {
  [connectionId: string]: FileVisit[];
}

/**
 * Service to track frequently used folders and files for smart preloading
 */
export class FolderHistoryService {
  private static _instance: FolderHistoryService;
  private history: ConnectionFolderHistory = {};
  private fileHistory: ConnectionFileHistory = {};
  private readonly MAX_FOLDERS_PER_CONNECTION = 10;
  private readonly MAX_FILES_PER_CONNECTION = 10;
  private readonly STORAGE_KEY = 'sshLite.folderHistory';
  private readonly FILE_STORAGE_KEY = 'sshLite.fileHistory';
  private readonly MAX_AGE_DAYS = 30; // Clean up entries older than 30 days
  private context: vscode.ExtensionContext | null = null;

  private constructor() {}

  static getInstance(): FolderHistoryService {
    if (!FolderHistoryService._instance) {
      FolderHistoryService._instance = new FolderHistoryService();
    }
    return FolderHistoryService._instance;
  }

  /**
   * Initialize with extension context for persistence
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.loadHistory();
    this.loadFileHistory();
    this.cleanupOldEntries();
    this.cleanupOldFileEntries();
  }

  /**
   * Load folder history from storage
   */
  private loadHistory(): void {
    if (this.context) {
      const stored = this.context.globalState.get<ConnectionFolderHistory>(this.STORAGE_KEY);
      if (stored) {
        this.history = stored;
      }
    }
  }

  /**
   * Load file history from storage
   */
  private loadFileHistory(): void {
    if (this.context) {
      const stored = this.context.globalState.get<ConnectionFileHistory>(this.FILE_STORAGE_KEY);
      if (stored) {
        this.fileHistory = stored;
      }
    }
  }

  /**
   * Save folder history to storage
   */
  private async saveHistory(): Promise<void> {
    if (this.context) {
      await this.context.globalState.update(this.STORAGE_KEY, this.history);
    }
  }

  /**
   * Save file history to storage
   */
  private async saveFileHistory(): Promise<void> {
    if (this.context) {
      await this.context.globalState.update(this.FILE_STORAGE_KEY, this.fileHistory);
    }
  }

  /**
   * Record a folder visit
   */
  async recordVisit(connectionId: string, folderPath: string): Promise<void> {
    // Skip special paths
    if (folderPath === '~' || folderPath === '/') {
      return;
    }

    if (!this.history[connectionId]) {
      this.history[connectionId] = [];
    }

    const folders = this.history[connectionId];
    const existing = folders.find((f) => f.path === folderPath);

    if (existing) {
      existing.visitCount++;
      existing.lastVisit = Date.now();
    } else {
      folders.push({
        path: folderPath,
        visitCount: 1,
        lastVisit: Date.now(),
      });
    }

    // Sort by visit count (descending), then by last visit (descending)
    folders.sort((a, b) => {
      if (b.visitCount !== a.visitCount) {
        return b.visitCount - a.visitCount;
      }
      return b.lastVisit - a.lastVisit;
    });

    // Keep only top N folders
    if (folders.length > this.MAX_FOLDERS_PER_CONNECTION) {
      this.history[connectionId] = folders.slice(0, this.MAX_FOLDERS_PER_CONNECTION);
    }

    await this.saveHistory();
  }

  /**
   * Get frequently used folders for a connection
   * Returns folders sorted by frequency (most used first)
   */
  getFrequentFolders(connectionId: string, limit?: number): string[] {
    const folders = this.history[connectionId] || [];
    const paths = folders.map((f) => f.path);
    return limit ? paths.slice(0, limit) : paths;
  }

  /**
   * Get all folder history for a connection (with stats)
   */
  getFolderHistory(connectionId: string): FolderVisit[] {
    return this.history[connectionId] || [];
  }

  /**
   * Clear history for a specific connection (folders and files)
   */
  async clearHistory(connectionId: string): Promise<void> {
    delete this.history[connectionId];
    delete this.fileHistory[connectionId];
    await this.saveHistory();
    await this.saveFileHistory();
  }

  /**
   * Clear all history (folders and files)
   */
  async clearAllHistory(): Promise<void> {
    this.history = {};
    this.fileHistory = {};
    await this.saveHistory();
    await this.saveFileHistory();
  }

  /**
   * Remove a specific folder from history
   */
  async removeFolder(connectionId: string, folderPath: string): Promise<void> {
    if (this.history[connectionId]) {
      this.history[connectionId] = this.history[connectionId].filter(
        (f) => f.path !== folderPath
      );
      await this.saveHistory();
    }
  }

  // ==================== FILE HISTORY METHODS ====================

  /**
   * Record a file open
   */
  async recordFileOpen(connectionId: string, filePath: string): Promise<void> {
    if (!this.fileHistory[connectionId]) {
      this.fileHistory[connectionId] = [];
    }

    const files = this.fileHistory[connectionId];
    const existing = files.find((f) => f.path === filePath);

    if (existing) {
      existing.visitCount++;
      existing.lastVisit = Date.now();
    } else {
      files.push({
        path: filePath,
        visitCount: 1,
        lastVisit: Date.now(),
      });
    }

    // Sort by visit count (descending), then by last visit (descending)
    files.sort((a, b) => {
      if (b.visitCount !== a.visitCount) {
        return b.visitCount - a.visitCount;
      }
      return b.lastVisit - a.lastVisit;
    });

    // Keep only top N files
    if (files.length > this.MAX_FILES_PER_CONNECTION) {
      this.fileHistory[connectionId] = files.slice(0, this.MAX_FILES_PER_CONNECTION);
    }

    await this.saveFileHistory();
  }

  /**
   * Get frequently opened files for a connection
   * Returns files sorted by frequency (most used first)
   */
  getFrequentFiles(connectionId: string, limit?: number): string[] {
    const files = this.fileHistory[connectionId] || [];
    const paths = files.map((f) => f.path);
    return limit ? paths.slice(0, limit) : paths;
  }

  /**
   * Get all file history for a connection (with stats)
   */
  getFileHistory(connectionId: string): FileVisit[] {
    return this.fileHistory[connectionId] || [];
  }

  /**
   * Remove a specific file from history
   */
  async removeFile(connectionId: string, filePath: string): Promise<void> {
    if (this.fileHistory[connectionId]) {
      this.fileHistory[connectionId] = this.fileHistory[connectionId].filter(
        (f) => f.path !== filePath
      );
      await this.saveFileHistory();
    }
  }

  /**
   * Clean up old file entries that haven't been visited in MAX_AGE_DAYS
   */
  private async cleanupOldFileEntries(): Promise<void> {
    const maxAge = this.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let cleaned = false;

    for (const connectionId of Object.keys(this.fileHistory)) {
      const files = this.fileHistory[connectionId];
      const originalLength = files.length;

      this.fileHistory[connectionId] = files.filter((f) => {
        return now - f.lastVisit < maxAge;
      });

      if (this.fileHistory[connectionId].length !== originalLength) {
        cleaned = true;
      }

      if (this.fileHistory[connectionId].length === 0) {
        delete this.fileHistory[connectionId];
      }
    }

    if (cleaned) {
      await this.saveFileHistory();
    }
  }

  /**
   * Clean up old folder entries that haven't been visited in MAX_AGE_DAYS
   */
  private async cleanupOldEntries(): Promise<void> {
    const maxAge = this.MAX_AGE_DAYS * 24 * 60 * 60 * 1000; // Convert to milliseconds
    const now = Date.now();
    let cleaned = false;

    for (const connectionId of Object.keys(this.history)) {
      const folders = this.history[connectionId];
      const originalLength = folders.length;

      // Filter out entries older than MAX_AGE_DAYS
      this.history[connectionId] = folders.filter((f) => {
        return now - f.lastVisit < maxAge;
      });

      if (this.history[connectionId].length !== originalLength) {
        cleaned = true;
      }

      // Remove connection entry if no folders left
      if (this.history[connectionId].length === 0) {
        delete this.history[connectionId];
      }
    }

    if (cleaned) {
      await this.saveHistory();
    }
  }

  /**
   * Decay visit counts over time (reduce counts for entries not visited recently)
   * This helps newer frequently visited folders to rise in priority
   */
  async decayVisitCounts(): Promise<void> {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let changed = false;

    for (const connectionId of Object.keys(this.history)) {
      for (const folder of this.history[connectionId]) {
        // If not visited in the last week, reduce visit count by half (min 1)
        if (folder.lastVisit < oneWeekAgo && folder.visitCount > 1) {
          folder.visitCount = Math.max(1, Math.floor(folder.visitCount / 2));
          changed = true;
        }
      }

      // Re-sort after decay
      this.history[connectionId].sort((a, b) => {
        if (b.visitCount !== a.visitCount) {
          return b.visitCount - a.visitCount;
        }
        return b.lastVisit - a.lastVisit;
      });
    }

    if (changed) {
      await this.saveHistory();
    }
  }

  dispose(): void {
    // Nothing to dispose
  }
}
