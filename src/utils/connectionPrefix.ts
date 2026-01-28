/**
 * Shared tab label / connection prefix logic.
 * Used by both FileService and ProgressiveDownloadManager to produce
 * consistent filenames like [tabLabel] file.ts or [user@host] file.ts.
 */

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
