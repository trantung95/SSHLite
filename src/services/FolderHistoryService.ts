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
 * Folder history per connection
 */
interface ConnectionFolderHistory {
  [connectionId: string]: FolderVisit[];
}

/**
 * Service to track frequently used folders for smart preloading
 */
export class FolderHistoryService {
  private static _instance: FolderHistoryService;
  private history: ConnectionFolderHistory = {};
  private readonly MAX_FOLDERS_PER_CONNECTION = 10;
  private readonly STORAGE_KEY = 'sshLite.folderHistory';
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
    this.cleanupOldEntries();
  }

  /**
   * Load history from storage
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
   * Save history to storage
   */
  private async saveHistory(): Promise<void> {
    if (this.context) {
      await this.context.globalState.update(this.STORAGE_KEY, this.history);
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
   * Clear history for a specific connection
   */
  async clearHistory(connectionId: string): Promise<void> {
    delete this.history[connectionId];
    await this.saveHistory();
  }

  /**
   * Clear all history
   */
  async clearAllHistory(): Promise<void> {
    this.history = {};
    await this.saveHistory();
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

  /**
   * Clean up old entries that haven't been visited in MAX_AGE_DAYS
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
