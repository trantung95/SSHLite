import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import {
  ConnectionPortabilityService,
  ConnectionsExport,
} from '../services/ConnectionPortabilityService';
import { GoogleDriveSyncService } from '../services/GoogleDriveSyncService';
import { HostService, effectiveHostPort } from '../services/HostService';
import { CredentialService } from '../services/CredentialService';
import { ConnectionImportPanel, ImportSide, ImportDiffRow } from '../webviews/ConnectionImportPanel';
import { infoLog } from '../utils/diagnosticLog';

/** Stable connection id used for conflict detection and credential keying. */
function hostId(h: { host: string; port?: number; username: string; connectionType?: 'ssh' | 'ftp' }): string {
  return `${h.host}:${effectiveHostPort(h)}:${h.username}`;
}

/**
 * Wiring context for the connection import/export/sync commands (issue #11).
 */
export interface ConnectionSyncContext {
  /** SSH Lite version stamped into export files. */
  extensionVersion: string;
  /** Clock injection point (deterministic in tests). */
  now?: () => string;
}

const DEFAULT_EXPORT_FILENAME = 'sshlite-connections.json';

/**
 * Build the export payload and write it to a user-chosen JSON file.
 * Uses vscode.workspace.fs (URI-scheme-safe) — never raw fs on a dialog URI.
 */
async function exportConnections(ctx: ConnectionSyncContext): Promise<void> {
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  infoLog('connection-sync', 'export-start', {});

  const portability = ConnectionPortabilityService.getInstance();
  const payload = portability.buildExportPayload({
    extensionVersion: ctx.extensionVersion,
    exportedAt: now,
  });

  if (payload.hosts.length === 0 && Object.keys(payload.credentials).length === 0) {
    vscode.window.showInformationMessage('SSH Lite: no saved connections to export.');
    infoLog('connection-sync', 'export-empty', {});
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), DEFAULT_EXPORT_FILENAME)),
    filters: { 'JSON Files': ['json'] },
    saveLabel: 'Export',
  });
  if (!target) {
    infoLog('connection-sync', 'export-cancelled', {});
    return;
  }

  const json = portability.serialize(payload);
  await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));

  infoLog('connection-sync', 'export-done', { hosts: payload.hosts.length, uri: target.toString() });
  vscode.window.showInformationMessage(
    `SSH Lite: exported ${payload.hosts.length} connection(s) to ${target.fsPath}`
  );
}

/**
 * Read a connections JSON file, validate it, ask merge/replace, and apply it.
 * Uses vscode.workspace.fs (URI-scheme-safe) for reading.
 */
async function importConnections(): Promise<void> {
  infoLog('connection-sync', 'import-start', {});

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'JSON Files': ['json'] },
    openLabel: 'Import',
  });
  if (!picked || picked.length === 0) {
    infoLog('connection-sync', 'import-cancelled', {});
    return;
  }
  const uri = picked[0];
  const fileName = uri.path.split('/').pop() || 'import file';

  const portability = ConnectionPortabilityService.getInstance();
  let payload;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    payload = portability.parseAndValidate(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    infoLog('connection-sync', 'import-invalid', { message });
    vscode.window.showErrorMessage(`SSH Lite import failed: ${message}`);
    return;
  }

  await applyImportFlow(portability, payload, 'import', fileName);
}

/** Summarize the connection a host id currently resolves to (for the diff view). */
function existingSides(): Map<string, ImportSide> {
  const hostSvc = HostService.getInstance();
  const credSvc = CredentialService.getInstance();
  const map = new Map<string, ImportSide>();
  for (const h of hostSvc.getAllHosts()) {
    const creds = credSvc.listCredentials(h.id);
    map.set(h.id, {
      name: h.name,
      detail: `${h.username}@${h.host}:${h.port}`,
      keyPath: h.privateKeyPath,
      credentialCount: creds.length,
      pinnedCount: creds.reduce((n, c) => n + (c.pinnedFolders?.length || 0), 0),
    });
  }
  return map;
}

/** Narrow a payload to the chosen connection ids (hosts + their credentials). */
function filterPayload(payload: ConnectionsExport, chosen: Set<string>): ConnectionsExport {
  const hosts = payload.hosts.filter((h) => chosen.has(hostId(h)));
  const credentials: ConnectionsExport['credentials'] = {};
  for (const [id, creds] of Object.entries(payload.credentials || {})) {
    if (chosen.has(id)) {
      credentials[id] = creds;
    }
  }
  return { ...payload, hosts, credentials };
}

/**
 * Apply an import. If any imported connection already exists, the import review
 * UI (a git-diff-style current-vs-importing webview) opens immediately so the
 * user can choose which to import — no intermediate prompts. With no conflicts,
 * the file is merged in directly. Always merge semantics (additive + update).
 * Shared by file import and Drive pull. Returns true if data was applied.
 */
async function applyImportFlow(
  portability: ConnectionPortabilityService,
  payload: ConnectionsExport,
  source: 'import' | 'pull',
  sourceLabel: string
): Promise<boolean> {
  const existing = existingSides();
  const hasConflict = payload.hosts.some((h) => existing.has(hostId(h)));

  let toApply = payload;
  if (hasConflict) {
    const rows: ImportDiffRow[] = payload.hosts.map((h) => {
      const id = hostId(h);
      const creds = payload.credentials?.[id] || [];
      return {
        id,
        incoming: {
          name: h.name,
          detail: `${h.username}@${h.host}:${effectiveHostPort(h)}`,
          keyPath: h.privateKeyPath,
          credentialCount: creds.length,
          pinnedCount: creds.reduce((n, c) => n + (c.pinnedFolders?.length || 0), 0),
        },
        current: existing.get(id),
      };
    });

    const selected = await ConnectionImportPanel.pick(rows, {
      title: 'Review import — choose which connections to import',
      sourceLabel,
    });
    if (!selected || selected.length === 0) {
      infoLog('connection-sync', `${source}-selection-cancelled`, {});
      return false;
    }
    toApply = filterPayload(payload, new Set(selected));
  }

  const result = await portability.applyImport(toApply, 'merge');
  await vscode.commands.executeCommand('sshLite.refreshHosts');

  infoLog('connection-sync', `${source}-done`, {
    added: result.hosts.added,
    updated: result.hosts.updated,
    credentialHosts: result.credentialHosts,
    reviewed: hasConflict,
  });
  vscode.window.showInformationMessage(
    `SSH Lite: imported connections (${result.hosts.added} added, ${result.hosts.updated} updated).`
  );
  return true;
}

/** Resolve the openExternal callback the loopback OAuth flow needs. */
async function openInBrowser(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Sign in to Google Drive (interactive OAuth consent). */
async function connectGoogleDrive(): Promise<void> {
  const drive = GoogleDriveSyncService.getInstance();
  if (!drive.isConfigured()) {
    vscode.window.showWarningMessage(
      'Google Drive sync is not configured in this build of SSH Lite. Use Export / Import to a Drive-synced folder instead.'
    );
    return;
  }
  if (await drive.isSignedIn()) {
    vscode.window.showInformationMessage('SSH Lite is already connected to Google Drive.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Connecting to Google Drive…' },
    async () => {
      await drive.signIn(openInBrowser);
    }
  );
  vscode.window.showInformationMessage('SSH Lite is now connected to Google Drive.');
}

/** Sign out of Google Drive and forget the stored tokens. */
async function disconnectGoogleDrive(): Promise<void> {
  const drive = GoogleDriveSyncService.getInstance();
  if (!(await drive.isSignedIn())) {
    vscode.window.showInformationMessage('SSH Lite is not connected to Google Drive.');
    return;
  }
  await drive.signOut();
  vscode.window.showInformationMessage('Disconnected SSH Lite from Google Drive.');
}

/** Offer to connect when a sync action runs while signed out. Returns true if connected. */
async function ensureSignedIn(drive: GoogleDriveSyncService): Promise<boolean> {
  if (!drive.isConfigured()) {
    vscode.window.showWarningMessage(
      'Google Drive sync is not configured in this build of SSH Lite. Use Export / Import to a Drive-synced folder instead.'
    );
    return false;
  }
  if (await drive.isSignedIn()) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    'Connect SSH Lite to Google Drive first?',
    'Connect',
    'Cancel'
  );
  if (choice !== 'Connect') {
    return false;
  }
  await connectGoogleDrive();
  return await drive.isSignedIn();
}

/** Build the export payload and upload it to Google Drive. */
async function syncPushToDrive(ctx: ConnectionSyncContext): Promise<void> {
  const drive = GoogleDriveSyncService.getInstance();
  if (!(await ensureSignedIn(drive))) {
    return;
  }
  const portability = ConnectionPortabilityService.getInstance();
  const payload = portability.buildExportPayload({
    extensionVersion: ctx.extensionVersion,
    exportedAt: ctx.now ? ctx.now() : new Date().toISOString(),
  });
  if (payload.hosts.length === 0 && Object.keys(payload.credentials).length === 0) {
    vscode.window.showInformationMessage('SSH Lite: no saved connections to sync.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pushing connections to Google Drive…' },
    async () => {
      await drive.push(portability.serialize(payload));
    }
  );
  infoLog('connection-sync', 'push-drive-done', { hosts: payload.hosts.length });
  vscode.window.showInformationMessage(
    `SSH Lite: pushed ${payload.hosts.length} connection(s) to Google Drive.`
  );
}

/** Download the connections file from Google Drive, validate, and apply it. */
async function syncPullFromDrive(): Promise<void> {
  const drive = GoogleDriveSyncService.getInstance();
  if (!(await ensureSignedIn(drive))) {
    return;
  }
  const portability = ConnectionPortabilityService.getInstance();

  let json: string | undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pulling connections from Google Drive…' },
    async () => {
      json = await drive.pull();
    }
  );
  if (!json) {
    vscode.window.showInformationMessage('SSH Lite: no connections file found on Google Drive yet.');
    return;
  }

  let payload: ConnectionsExport;
  try {
    payload = portability.parseAndValidate(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`SSH Lite Drive sync failed: ${message}`);
    return;
  }
  const driveFile = vscode.workspace
    .getConfiguration('sshLite')
    .get<string>('googleDrive.fileName', 'sshlite-connections.json');
  await applyImportFlow(portability, payload, 'pull', `${driveFile} (Google Drive)`);
}

/**
 * Register the connection import/export commands (issue #11, Phase A).
 * Drive-sync commands are added in a later phase.
 */
export function registerConnectionSyncCommands(ctx: ConnectionSyncContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('sshLite.exportConnections', async () => {
      try {
        await exportConnections(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'export-error', { message });
        vscode.window.showErrorMessage(`SSH Lite export failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sshLite.importConnections', async () => {
      try {
        await importConnections();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'import-error', { message });
        vscode.window.showErrorMessage(`SSH Lite import failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sshLite.connectGoogleDrive', async () => {
      try {
        await connectGoogleDrive();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'connect-drive-error', { message });
        vscode.window.showErrorMessage(`Google Drive connect failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sshLite.disconnectGoogleDrive', async () => {
      try {
        await disconnectGoogleDrive();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'disconnect-drive-error', { message });
        vscode.window.showErrorMessage(`Google Drive disconnect failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sshLite.syncPushToDrive', async () => {
      try {
        await syncPushToDrive(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'push-drive-error', { message });
        vscode.window.showErrorMessage(`Google Drive sync (push) failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sshLite.syncPullFromDrive', async () => {
      try {
        await syncPullFromDrive();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        infoLog('connection-sync', 'pull-drive-error', { message });
        vscode.window.showErrorMessage(`Google Drive sync (pull) failed: ${message}`);
      }
    }),
  ];
}
