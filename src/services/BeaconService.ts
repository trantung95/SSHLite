// @author hybr8
import * as vscode from 'vscode';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * BeaconService — a tiny, privacy-safe cross-VS-Code-window activity channel for
 * the Support view NPC.
 *
 * VS Code extensions are sandboxed to their own window: there is no API to see
 * activity in another window. But every window of the same VS Code install
 * shares `context.globalStorageUri`, so we use a single small "beacon" file
 * there as an activity heartbeat. When this window is active it (debounced)
 * writes the beacon; other windows watch the file (event-driven, no polling) and
 * pulse their NPC.
 *
 * Privacy: the beacon carries ONLY `{ v, ts, kind, from }` — a timestamp, a
 * coarse category ('editor' | 'terminal'), and the writer's instance id. It
 * never contains keystrokes, file paths, or host names. The NPC popup uses
 * random keys/words, so no real content is needed.
 *
 * LITE: opt-in via setting; debounced writes (max one per 250ms); the watcher is
 * event-driven and only runs while the Support view is visible; self-writes are
 * suppressed; stale beacons are ignored; everything is disposed and the beacon
 * deleted on shutdown.
 */

export type BeaconKind = 'editor' | 'terminal';

interface BeaconPayload {
  v: 1;
  ts: number;
  kind: BeaconKind;
  from: string;
}

/** Minimal slice of `vscode.workspace.fs` used here (injectable for tests). */
export interface BeaconFsApi {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
  createDirectory(uri: vscode.Uri): Thenable<void>;
}

export type CreateWatcher = (pattern: vscode.RelativePattern) => vscode.FileSystemWatcher;

const WRITE_DEBOUNCE_MS = 250;
const STALE_MS = 10_000;
const BEACON_FILE = 'npc-beacon.json';

function isBeaconPayload(p: unknown): p is BeaconPayload {
  if (!p || typeof p !== 'object') {
    return false;
  }
  const o = p as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.ts === 'number' &&
    (o.kind === 'editor' || o.kind === 'terminal') &&
    typeof o.from === 'string'
  );
}

export class BeaconService {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly watcherDisposables: vscode.Disposable[] = [];
  private lastWriteAt = 0;
  private dirEnsured = false;
  private enabled = false;
  private visible = false;
  private readonly instanceId: string;
  private readonly dirUri: vscode.Uri;

  constructor(
    private readonly beaconUri: vscode.Uri,
    private readonly onRemoteActivity: (kind: BeaconKind) => void,
    private readonly fsApi: BeaconFsApi = vscode.workspace.fs,
    instanceId?: string,
    private readonly createWatcher: CreateWatcher = (p) => vscode.workspace.createFileSystemWatcher(p)
  ) {
    this.instanceId = instanceId ?? BeaconService.makeInstanceId();
    this.dirUri = vscode.Uri.joinPath(beaconUri, '..');
  }

  /** Process-unique id. PID alone is reused, so add a time+random suffix. */
  static makeInstanceId(): string {
    return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Enable/disable the whole feature (driven by the setting). Idempotent. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    infoLog('npc-beacon', enabled ? 'enabled' : 'disabled', {});
    this.updateWatcher();
  }

  /** Track Support-view visibility. The reader watcher only runs while visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    this.updateWatcher();
  }

  /**
   * Record activity for OTHER windows to see. No-op unless enabled; debounced so
   * a paste/typing storm produces at most ~4 writes/sec. Writer is independent
   * of visibility (other windows may have their NPC open even when this one's is
   * collapsed).
   */
  async writeActivity(kind: BeaconKind): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const now = Date.now();
    if (now - this.lastWriteAt < WRITE_DEBOUNCE_MS) {
      return;
    }
    this.lastWriteAt = now;
    try {
      if (!this.dirEnsured) {
        this.dirEnsured = true; // optimistic: avoid a concurrent double-create
        await this.fsApi.createDirectory(this.dirUri);
      }
      const body: BeaconPayload = { v: 1, ts: now, kind, from: this.instanceId };
      await this.fsApi.writeFile(this.beaconUri, Buffer.from(JSON.stringify(body), 'utf8'));
      diagLog('npc-beacon', 'write', { kind });
    } catch (err) {
      diagLog('npc-beacon', 'write-failed', { error: (err as Error).message });
    }
  }

  private updateWatcher(): void {
    const shouldWatch = this.enabled && this.visible;
    if (shouldWatch && !this.watcher) {
      this.startWatch();
    } else if (!shouldWatch && this.watcher) {
      this.stopWatch();
    }
  }

  private startWatch(): void {
    const pattern = new vscode.RelativePattern(this.dirUri, BEACON_FILE);
    this.watcher = this.createWatcher(pattern);
    // A write can surface as create OR change depending on platform — wire both.
    this.watcherDisposables.push(
      this.watcher.onDidChange(() => void this.onChange()),
      this.watcher.onDidCreate(() => void this.onChange())
    );
    infoLog('npc-beacon', 'watch-start', {});
  }

  private stopWatch(): void {
    this.watcherDisposables.forEach((d) => d.dispose());
    this.watcherDisposables.length = 0;
    this.watcher?.dispose();
    this.watcher = undefined;
    infoLog('npc-beacon', 'watch-stop', {});
  }

  private async onChange(): Promise<void> {
    if (!this.enabled || !this.visible) {
      return; // a watcher event queued before stop/dispose — ignore
    }
    let raw: Uint8Array;
    try {
      raw = await this.fsApi.readFile(this.beaconUri);
    } catch {
      return; // file vanished mid-event
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      diagLog('npc-beacon', 'parse-bad', {});
      return;
    }
    if (!isBeaconPayload(parsed)) {
      diagLog('npc-beacon', 'shape-bad', {});
      return;
    }
    if (parsed.from === this.instanceId) {
      return; // our own write — don't echo
    }
    if (Date.now() - parsed.ts > STALE_MS) {
      return; // leftover from a crashed/old window
    }
    diagLog('npc-beacon', 'remote-activity', { kind: parsed.kind });
    this.onRemoteActivity(parsed.kind);
  }

  dispose(): void {
    // Flip flags first so any watcher event already queued before stopWatch()
    // sees a disabled service and does nothing.
    this.enabled = false;
    this.visible = false;
    this.stopWatch();
    // Best-effort: remove the beacon so a stale file does not linger after the
    // last window closes. Other live windows recreate it on next activity.
    void Promise.resolve(this.fsApi.delete(this.beaconUri)).then(undefined, () => {});
  }
}
