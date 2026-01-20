import type { SSHConnection } from '../connection/SSHConnection';
import * as vscode from 'vscode';

/**
 * State of a progressive file download
 */
export type DownloadStatus = 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled';

/**
 * Progress callback for chunked file downloads
 */
export type ProgressCallback = (transferred: number, total: number) => void;

/**
 * Abort signal for cancellable operations
 */
export interface AbortSignal {
  aborted: boolean;
}

/**
 * State tracking for an active download
 */
export interface DownloadState {
  /** Unique identifier for this download */
  id: string;
  /** Remote file path */
  remotePath: string;
  /** Connection ID */
  connectionId: string;
  /** Total file size in bytes */
  totalBytes: number;
  /** Bytes downloaded so far */
  downloadedBytes: number;
  /** Current status */
  status: DownloadStatus;
  /** Local file path (once download starts) */
  localPath?: string;
  /** URI of the preview document */
  previewUri?: vscode.Uri;
  /** Cancellation token source */
  cancelTokenSource?: vscode.CancellationTokenSource;
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Timestamp when download started */
  startTime: number;
  /** Reference to the connection */
  connection?: SSHConnection;
}

/**
 * Configuration for progressive downloads
 */
export interface ProgressiveConfig {
  /** File size threshold for progressive download (default: 1MB) */
  threshold: number;
  /** Number of lines to show in preview (default: 1000) */
  previewLines: number;
  /** Enable live tail following during preview (default: true) */
  tailFollowEnabled: boolean;
  /** Interval for tail polling in ms (default: 1000) */
  tailPollInterval: number;
  /** SFTP chunk size for progress reporting (default: 64KB) */
  chunkSize: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_PROGRESSIVE_CONFIG: ProgressiveConfig = {
  threshold: 1 * 1024 * 1024, // 1MB
  previewLines: 1000,
  tailFollowEnabled: true,
  tailPollInterval: 1000,
  chunkSize: 64 * 1024, // 64KB
};

/**
 * URI scheme for progressive file preview
 */
export const PROGRESSIVE_PREVIEW_SCHEME = 'ssh-lite-preview';

/**
 * Parse a preview URI to extract connection ID and remote path
 */
export function parsePreviewUri(uri: vscode.Uri): { connectionId: string; remotePath: string; lines: number } | null {
  if (uri.scheme !== PROGRESSIVE_PREVIEW_SCHEME) {
    return null;
  }

  const connectionId = uri.authority;
  // Path includes leading slash, decode it
  const remotePath = decodeURIComponent(uri.path);

  // Parse query string for lines parameter with validation
  const queryParams = new URLSearchParams(uri.query);
  const parsedLines = parseInt(queryParams.get('lines') || '1000', 10);
  // Validate: min 1, max 10000, default to 1000 if invalid
  const lines = isNaN(parsedLines) ? 1000 : Math.max(1, Math.min(10000, parsedLines));

  return { connectionId, remotePath, lines };
}

/**
 * Create a preview URI for a remote file
 * Format: ssh-lite-preview://connectionId/encoded-path?lines=N
 */
export function createPreviewUri(connectionId: string, remotePath: string, lines: number = 1000): vscode.Uri {
  // Ensure path starts with / for proper URI structure
  const normalizedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  const encodedPath = encodeURIComponent(normalizedPath);
  // Add slash between authority and path for proper URI parsing
  return vscode.Uri.parse(`${PROGRESSIVE_PREVIEW_SCHEME}://${connectionId}/${encodedPath}?lines=${lines}`);
}

/**
 * Load progressive download configuration from VSCode settings
 * Shared function to avoid duplication across providers and managers
 */
export function loadProgressiveConfig(): ProgressiveConfig {
  const config = vscode.workspace.getConfiguration('sshLite');
  return {
    threshold: config.get<number>('progressiveDownloadThreshold', DEFAULT_PROGRESSIVE_CONFIG.threshold),
    previewLines: config.get<number>('progressivePreviewLines', DEFAULT_PROGRESSIVE_CONFIG.previewLines),
    tailFollowEnabled: config.get<boolean>('progressiveTailFollow', DEFAULT_PROGRESSIVE_CONFIG.tailFollowEnabled),
    tailPollInterval: config.get<number>('progressiveTailPollInterval', DEFAULT_PROGRESSIVE_CONFIG.tailPollInterval),
    chunkSize: config.get<number>('progressiveChunkSize', DEFAULT_PROGRESSIVE_CONFIG.chunkSize),
  };
}

/**
 * Events emitted by the progressive download system
 */
export interface ProgressiveDownloadEvents {
  /** Emitted when download progress updates */
  onProgress: (state: DownloadState) => void;
  /** Emitted when download status changes */
  onStatusChange: (state: DownloadState) => void;
  /** Emitted when download completes successfully */
  onComplete: (state: DownloadState, localPath: string) => void;
  /** Emitted when download fails */
  onError: (state: DownloadState, error: Error) => void;
}

/**
 * File type detection for preview optimization
 */
export const BINARY_EXTENSIONS = new Set([
  '.bin', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
  '.sqlite', '.db', '.mdb',
  '.class', '.pyc', '.o', '.obj',
]);

/**
 * Check if a file is likely binary based on extension
 */
export function isLikelyBinary(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return BINARY_EXTENSIONS.has(ext);
}
