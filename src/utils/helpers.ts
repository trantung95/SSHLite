import * as os from 'os';

/**
 * Normalize a local file path for consistent Map key lookups.
 *
 * On Windows, VS Code's document.uri.fsPath lowercases the drive letter (e.g., "c:\...")
 * but os.tmpdir() and path.join may return uppercase (e.g., "C:\...").
 * On macOS, HFS+/APFS is case-insensitive — paths from different APIs may differ in case.
 *
 * This function normalizes the drive letter on Windows/macOS to ensure Map<localPath> lookups
 * are consistent regardless of which API produced the path.
 */
export function normalizeLocalPath(filePath: string): string {
  if (filePath.length >= 2 && filePath[1] === ':') {
    // Windows drive letter: C:\foo → c:\foo
    return filePath[0].toLowerCase() + filePath.slice(1);
  }
  return filePath;
}

/**
 * Expand ~ to home directory in a path
 */
export function expandPath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return filePath.replace('~', os.homedir());
  }
  return filePath;
}

/**
 * Validate a port number string
 * Returns error message or null if valid
 */
export function validatePort(value: string): string | null {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return 'Please enter a valid port number (1-65535)';
  }
  return null;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format a timestamp as relative time (e.g., "2h ago", "3d ago")
 * Compact format suitable for tree view description
 * Uses local time for display
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  // Handle future timestamps (clock skew between machines)
  if (diff < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) {
    return 'just now';
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else if (days < 7) {
    return `${days}d ago`;
  } else if (weeks < 5) {
    return `${weeks}w ago`;
  } else if (months < 12) {
    return `${months}mo ago`;
  } else {
    return `${years}y ago`;
  }
}

/**
 * Format a timestamp for tooltip display
 * Full date/time in local timezone
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}
