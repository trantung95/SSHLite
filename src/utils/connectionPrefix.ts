/**
 * Shared tab label / connection prefix logic.
 * Used by both FileService and ProgressiveDownloadManager to produce
 * consistent filenames like [tabLabel] file.ts or [user@host] file.ts.
 */

import * as path from 'path';
import * as crypto from 'crypto';

// connectionId -> tabLabel (registered when opening files)
const connectionTabLabels = new Map<string, string>();

/**
 * Register a tab label for a connection (from IHostConfig.tabLabel).
 */
export function registerTabLabel(connectionId: string, tabLabel: string): void {
  connectionTabLabels.set(connectionId, tabLabel);
}

/**
 * Get the filename prefix for a connection.
 * Returns tabLabel if registered, otherwise user@host derived from connectionId.
 */
export function getConnectionPrefix(connectionId: string): string {
  const tabLabel = connectionTabLabels.get(connectionId);
  if (tabLabel) {
    return tabLabel;
  }
  // connectionId format: host:port:username
  const parts = connectionId.split(':');
  if (parts.length >= 3) {
    return `${parts[2]}@${parts[0]}`;
  }
  return 'SSH';
}

/** Short, stable hex digest used for collision-free temp subdirectories. */
function md5Short(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').substring(0, 8);
}

/**
 * Sanitize a remote folder name into a single path segment that is safe on
 * Windows, macOS and Linux. Removes a trailing space or dot (illegal as a
 * Windows folder name), replaces reserved characters and whitespace with
 * underscores (hyphens are kept for readability; uniqueness comes from the
 * hash suffix the caller appends), caps the length, and falls back to 'root'
 * when nothing usable remains (e.g. the filesystem root, whose basename is
 * empty).
 */
function sanitizeFolderSegment(name: string): string {
  const cleaned = name
    .replace(/[\s.]+$/g, '')
    .replace(/[<>:"/\\|?*\s]/g, '_')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'root';
}

/**
 * Build the local temp file path for a remote file.
 *
 * Layout: <tempDir>/<connHash>/<dirLabel>_<dirHash>/[prefix] <basename>
 *
 * The per-directory subfolder (derived from the remote folder, not just the
 * basename) is what prevents two files that share a basename but live in
 * different remote folders — e.g. /var/www/a/index.php and /var/www/b/index.php —
 * from mapping to the same local temp file (which previously caused one to open
 * the other's content and risked saving edits to the wrong remote file).
 *
 * Deterministic: the same (connectionId, remotePath) always yields the same
 * path, so "already open" detection and re-open reuse keep working.
 *
 * Returns both the directory (caller is responsible for mkdir) and the full
 * file path. The caller applies any path normalization it needs.
 */
export function buildLocalTempPath(
  tempDir: string,
  connectionId: string,
  remotePath: string
): { dir: string; filePath: string } {
  const connHash = md5Short(connectionId);
  // Remote paths are always POSIX, so dirname/basename must use path.posix
  // regardless of the host OS running the extension.
  const remoteDir = path.posix.dirname(remotePath);
  const dirHash = md5Short(remoteDir);
  const subDir = `${sanitizeFolderSegment(path.posix.basename(remoteDir))}_${dirHash}`;
  const dir = path.join(tempDir, connHash, subDir);

  const prefix = getConnectionPrefix(connectionId);
  const fileName = `[${prefix}] ${path.posix.basename(remotePath)}`;
  return { dir, filePath: path.join(dir, fileName) };
}

/**
 * Build a collision-free filename for an AUXILIARY temp file — one that is
 * written then immediately opened read-only or fed to vscode.diff (file view,
 * large-file preview, server/local backup compare, upload diff, remote diff).
 *
 * Unlike buildLocalTempPath (the editable mirror of a remote file), these live
 * flat in tempDir and are transient, but they STILL must be unique per
 * (connectionId, remotePath, kind): without the hash, viewing /a/index.php then
 * /b/index.php — or the same path on two different servers — reused one temp
 * file and showed the wrong content (the issue #6 class of bug). A readable
 * basename is kept as the suffix for nicer editor tabs.
 *
 * Returns just the filename; the caller joins it onto its temp dir.
 */
export function buildAuxTempFileName(kind: string, connectionId: string, remotePath: string): string {
  const hash = md5Short(`${connectionId}:${remotePath}`);
  return `${kind}-${hash}-${path.posix.basename(remotePath)}`;
}
