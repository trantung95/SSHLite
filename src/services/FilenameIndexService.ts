import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { SSHConnection } from '../connection/SSHConnection';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * Client-side filename snapshot index.
 *
 * Unlike server indexes (plocate), this lives entirely on the CLIENT — zero
 * footprint on the remote, works on ANY server including busybox. A user
 * explicitly indexes a folder ("Index folder for fast filename search"); we run
 * ONE remote listing, gzip the path list into the extension's globalStorage, and
 * later filename filters in that folder match LOCALLY — 0 round-trips, instant.
 *
 * Like any index it is a point-in-time SNAPSHOT and goes stale; the UI always
 * shows the snapshot age and offers a rebuild, and live search remains the
 * default. LITE: the build is user-triggered, never automatic; a build that
 * would exceed the entry cap is REFUSED rather than silently truncated (a
 * truncated filename index would miss files — a "true data, no missing" break).
 */

interface SnapshotMeta {
  /** Stable host signature `host:port:user` (survives reconnects). */
  hostKey: string;
  basePath: string;
  /** Epoch ms the snapshot was built. */
  timestamp: number;
  count: number;
  /** gz filename under the index dir. */
  file: string;
}

interface IndexManifest {
  [key: string]: SnapshotMeta;
}

const MANIFEST_KEY = 'sshLite.filenameIndex';
const INDEX_DIRNAME = 'filename-index';

export class FilenameIndexService {
  private static _instance: FilenameIndexService;
  private context: vscode.ExtensionContext | null = null;

  private constructor() {}

  static getInstance(): FilenameIndexService {
    if (!FilenameIndexService._instance) {
      FilenameIndexService._instance = new FilenameIndexService();
    }
    return FilenameIndexService._instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /** Stable per-host key so a snapshot survives reconnects (id changes each connect). */
  static hostKey(conn: SSHConnection): string {
    return `${conn.host.host}:${conn.host.port || 22}:${conn.host.username}`;
  }

  private snapshotKey(conn: SSHConnection, basePath: string): string {
    return `${FilenameIndexService.hostKey(conn)}::${basePath}`;
  }

  private getManifest(): IndexManifest {
    if (!this.context) return {};
    return this.context.globalState.get<IndexManifest>(MANIFEST_KEY, {});
  }

  private async setManifest(manifest: IndexManifest): Promise<void> {
    if (!this.context) return;
    await this.context.globalState.update(MANIFEST_KEY, manifest);
  }

  private indexDir(): string | null {
    if (!this.context) return null;
    return path.join(this.context.globalStorageUri.fsPath, INDEX_DIRNAME);
  }

  private fileFor(key: string): string {
    return crypto.createHash('sha1').update(key).digest('hex') + '.gz';
  }

  private maxEntries(): number {
    return vscode.workspace.getConfiguration('sshLite').get<number>('filenameIndexMaxEntries', 2_000_000);
  }

  /**
   * Build (or rebuild) a snapshot for `basePath` on `conn`. Runs one remote
   * listing (fd/find via the native-tools path), gzips it to globalStorage, and
   * records the manifest. Returns `{ count, timestamp }` on success, or
   * `{ refused: 'too-large' | 'no-storage', limit }` when it cannot store a
   * complete index.
   */
  async buildIndex(
    conn: SSHConnection,
    basePath: string,
    signal?: AbortSignal,
  ): Promise<{ count: number; timestamp: number } | { refused: 'too-large' | 'no-storage' | 'aborted'; limit: number }> {
    const dir = this.indexDir();
    if (!dir) return { refused: 'no-storage', limit: 0 };

    const cap = this.maxEntries();
    const t0 = Date.now();
    infoLog('filename-index', 'build-start', { hostKey: FilenameIndexService.hostKey(conn), basePath, cap });

    // List everything under basePath (files + dirs). Cap+1 so we can DETECT an
    // overflow (== cap means possibly truncated → refuse rather than ship a
    // partial index). Empty pattern → match-all (-iname '**').
    const rows = await conn.searchFiles(basePath, '', {
      searchContent: false,
      findType: 'both',
      maxResults: cap,
      nativeTools: vscode.workspace.getConfiguration('sshLite').get<'auto' | 'off'>('searchNativeTools', 'auto'),
      signal,
    });

    if (signal?.aborted) {
      infoLog('filename-index', 'build-aborted', { basePath });
      return { refused: 'aborted', limit: cap }; // caller no-ops silently
    }

    if (rows.length >= cap) {
      infoLog('filename-index', 'build-rejected', { basePath, reason: 'too-large', count: rows.length, cap });
      return { refused: 'too-large', limit: cap };
    }

    const paths = rows.map((r) => r.path);
    const blob = zlib.gzipSync(Buffer.from(paths.join('\n'), 'utf8'));
    fs.mkdirSync(dir, { recursive: true });
    const key = this.snapshotKey(conn, basePath);
    const file = this.fileFor(key);
    fs.writeFileSync(path.join(dir, file), blob);

    const timestamp = Date.now();
    const manifest = this.getManifest();
    manifest[key] = { hostKey: FilenameIndexService.hostKey(conn), basePath, timestamp, count: paths.length, file };
    await this.setManifest(manifest);

    infoLog('filename-index', 'build-done', {
      basePath, count: paths.length, gzipBytes: blob.length, durationMs: Date.now() - t0,
    });
    return { count: paths.length, timestamp };
  }

  /** Manifest lookup (does NOT load the gz). Null when no snapshot exists. */
  getSnapshotMeta(conn: SSHConnection, basePath: string): { timestamp: number; count: number } | null {
    const meta = this.getManifest()[this.snapshotKey(conn, basePath)];
    return meta ? { timestamp: meta.timestamp, count: meta.count } : null;
  }

  /**
   * Match `pattern` against a folder's snapshot LOCALLY (basename contains, like
   * the live `find -iname '*pattern*'`). Returns null when there is no snapshot
   * (caller falls back to a live/indexed search) — distinct from an empty match.
   */
  search(
    conn: SSHConnection,
    basePath: string,
    pattern: string,
    caseSensitive: boolean,
    maxResults = 0,
  ): { results: Array<{ path: string }>; timestamp: number; count: number } | null {
    const dir = this.indexDir();
    if (!dir) return null;
    const key = this.snapshotKey(conn, basePath);
    const meta = this.getManifest()[key];
    if (!meta) return null;

    let text: string;
    try {
      text = zlib.gunzipSync(fs.readFileSync(path.join(dir, meta.file))).toString('utf8');
    } catch (err) {
      // Corrupt / missing blob — drop the stale manifest entry and fall back.
      diagLog('filename-index', 'read-error', { basePath, errorMessage: (err as Error).message });
      return null;
    }

    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const results: Array<{ path: string }> = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const base = line.slice(line.lastIndexOf('/') + 1);
      if ((caseSensitive ? base : base.toLowerCase()).includes(needle)) {
        results.push({ path: line });
        if (maxResults > 0 && results.length >= maxResults) break;
      }
    }
    infoLog('filename-index', 'used', {
      basePath, ageMs: Date.now() - meta.timestamp, matchCount: results.length, total: meta.count,
    });
    return { results, timestamp: meta.timestamp, count: meta.count };
  }

  /** Remove a snapshot (manifest entry + gz file). */
  async remove(conn: SSHConnection, basePath: string): Promise<void> {
    const manifest = this.getManifest();
    const key = this.snapshotKey(conn, basePath);
    const meta = manifest[key];
    if (!meta) return;
    const dir = this.indexDir();
    if (dir) {
      try { fs.unlinkSync(path.join(dir, meta.file)); } catch { /* already gone */ }
    }
    delete manifest[key];
    await this.setManifest(manifest);
    infoLog('filename-index', 'removed', { basePath });
  }

  /** All snapshots for a host (for management UI / status). */
  listForHost(conn: SSHConnection): SnapshotMeta[] {
    const hk = FilenameIndexService.hostKey(conn);
    return Object.values(this.getManifest()).filter((m) => m.hostKey === hk);
  }
}
