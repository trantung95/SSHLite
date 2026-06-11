import { HostService } from './HostService';
import { CredentialService, SavedCredential } from './CredentialService';
import { infoLog } from '../utils/diagnosticLog';

/**
 * A saved host as it appears in an export file (no secrets).
 */
export interface ExportedHost {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  tabLabel?: string;
}

/**
 * The connections-export envelope (issue #11). Versioned so future formats can
 * be migrated. Contains ONLY non-secret data: host metadata plus credential
 * labels/types/key-paths and pinned folders. Passwords and passphrases stay in
 * VS Code SecretStorage and are never written here.
 */
export interface ConnectionsExport {
  /** Format marker — must equal {@link ConnectionPortabilityService.SCHEMA}. */
  schema: string;
  /** Format version — see {@link ConnectionPortabilityService.VERSION}. */
  version: number;
  /** ISO timestamp the export was produced. */
  exportedAt: string;
  /** SSH Lite version that produced the export. */
  extensionVersion: string;
  /** Saved hosts (unexpanded key paths for portability). */
  hosts: ExportedHost[];
  /** Non-secret credential metadata keyed by `host:port:username`. */
  credentials: { [hostId: string]: SavedCredential[] };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportResult {
  hosts: { added: number; updated: number };
  credentialHosts: number;
}

/**
 * Single source of truth for the connections import/export file format
 * (issue #11). Builds and validates the {@link ConnectionsExport} payload and
 * applies an import by delegating storage to {@link HostService} and
 * {@link CredentialService}. Network-free and fully unit-testable.
 */
export class ConnectionPortabilityService {
  private static _instance: ConnectionPortabilityService;

  /** Format marker written into every export. */
  static readonly SCHEMA = 'sshlite-connections';
  /** Highest format version this build can read/write. */
  static readonly VERSION = 1;

  private constructor() {}

  static getInstance(): ConnectionPortabilityService {
    if (!ConnectionPortabilityService._instance) {
      ConnectionPortabilityService._instance = new ConnectionPortabilityService();
    }
    return ConnectionPortabilityService._instance;
  }

  /**
   * Assemble the export payload from the current saved hosts and credential
   * metadata. `exportedAt`/`extensionVersion` are injected by the caller so
   * this stays deterministic and testable.
   */
  buildExportPayload(opts: { extensionVersion: string; exportedAt: string }): ConnectionsExport {
    // Export EVERY connection the user sees (saved + ~/.ssh/config), not just
    // saved hosts — see issue #11 follow-up (a 19-saved / 82-ssh-config user got
    // an export of only 19). getAllHostsForExport dedupes and keeps ~ paths.
    const hosts = HostService.getInstance().getAllHostsForExport();
    const credentials = CredentialService.getInstance().exportMetadata();
    infoLog('connection-portability', 'build-export', {
      hosts: hosts.length,
      credentialHosts: Object.keys(credentials).length,
    });
    return {
      schema: ConnectionPortabilityService.SCHEMA,
      version: ConnectionPortabilityService.VERSION,
      exportedAt: opts.exportedAt,
      extensionVersion: opts.extensionVersion,
      hosts,
      credentials,
    };
  }

  /** Serialize a payload to pretty JSON for writing to a file/Drive. */
  serialize(payload: ConnectionsExport): string {
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Parse and validate raw JSON into a {@link ConnectionsExport}. Throws a
   * user-facing Error on malformed input, a wrong format marker, an
   * unsupported (newer) version, or a non-array `hosts`.
   */
  parseAndValidate(json: string): ConnectionsExport {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('This file is not valid JSON.');
    }

    if (!data || typeof data !== 'object') {
      throw new Error('This file is not a valid SSH Lite connections export.');
    }
    const obj = data as Record<string, unknown>;

    if (obj.schema !== ConnectionPortabilityService.SCHEMA) {
      throw new Error('This file is not an SSH Lite connections export (unrecognized format).');
    }

    const version = typeof obj.version === 'number' ? obj.version : 0;
    if (version > ConnectionPortabilityService.VERSION) {
      throw new Error(
        `This export was made by a newer version of SSH Lite (format version ${version}). Please update the extension.`
      );
    }

    if (!Array.isArray(obj.hosts)) {
      throw new Error('This export is corrupt: "hosts" is missing or not a list.');
    }

    const credentials =
      obj.credentials && typeof obj.credentials === 'object' && !Array.isArray(obj.credentials)
        ? (obj.credentials as { [hostId: string]: SavedCredential[] })
        : {};

    return {
      schema: ConnectionPortabilityService.SCHEMA,
      version,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
      extensionVersion: typeof obj.extensionVersion === 'string' ? obj.extensionVersion : '',
      hosts: obj.hosts as ExportedHost[],
      credentials,
    };
  }

  /**
   * Apply a validated payload to local storage. Hosts go through
   * {@link HostService.importSavedHosts}; credential metadata through
   * {@link CredentialService.importCredentialMetadata}. SecretStorage is never
   * touched.
   */
  async applyImport(payload: ConnectionsExport, mode: ImportMode): Promise<ImportResult> {
    const hostService = HostService.getInstance();
    const credentialService = CredentialService.getInstance();

    const hosts = await hostService.importSavedHosts(payload.hosts || [], mode);

    const credEntries = Object.entries(payload.credentials || {});
    for (const [hostId, creds] of credEntries) {
      await credentialService.importCredentialMetadata(hostId, creds || [], mode);
    }

    infoLog('connection-portability', 'apply-import', {
      mode,
      hostsAdded: hosts.added,
      hostsUpdated: hosts.updated,
      credentialHosts: credEntries.length,
    });

    return { hosts, credentialHosts: credEntries.length };
  }
}
