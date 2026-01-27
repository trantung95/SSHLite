/**
 * Pure utility functions extracted from extension.ts for testability
 *
 * These functions handle orphaned SSH file detection and
 * SSH temp file path parsing.
 */

/**
 * Parse host info from an SSH temp file path.
 * Path format: {tempDir}/{hostHash}/[SSH] filename
 *
 * @param filePath - The file path to parse
 * @param sshTempDir - The SSH temp directory root
 * @returns Parsed host hash and filename, or null if not an SSH file
 */
export function parseHostInfoFromPath(
  filePath: string,
  sshTempDir: string
): { hostHash: string; fileName: string } | null {
  if (!filePath.includes(sshTempDir) && !filePath.includes('ssh-lite')) {
    return null;
  }

  // Split by forward or back slashes to handle both Unix and Windows
  const pathParts = filePath.split(/[/\\]/);
  const sshIndex = pathParts.findIndex((p) => p.includes('[SSH]'));
  if (sshIndex > 0) {
    const hostHash = pathParts[sshIndex - 1];
    const fileName = pathParts[sshIndex].replace('[SSH] ', '');
    return { hostHash, fileName };
  }
  return null;
}

/**
 * Check if a file path is inside the SSH temp directory.
 *
 * @param fsPath - The file path to check
 * @param sshTempDir - The SSH temp directory root
 * @returns true if the path is in the SSH temp directory
 */
export function isInSshTempDir(fsPath: string, sshTempDir: string): boolean {
  return fsPath.includes(sshTempDir) || fsPath.includes('ssh-lite');
}

/**
 * Check if a file path has the [SSH] prefix in its filename.
 *
 * @param fsPath - The file path to check
 * @returns true if the path contains [SSH] prefix
 */
export function hasSshPrefix(fsPath: string): boolean {
  return fsPath.includes('[SSH]');
}
