import * as os from 'os';

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
