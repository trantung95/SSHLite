// @author hybr8
import * as vscode from 'vscode';
import { infoLog, diagLog } from '../utils/diagnosticLog';
import { BeaconFsApi, CreateWatcher } from './BeaconService';
import { HOOK_TOOLS } from './HookInstallerService';

/**
 * HookBeaconService — the read side of the opt-in AI-hook feature. When the user
 * installs prompt-submit hooks (HookInstallerService), each AI tool runs the
 * bundled `npc-beacon.js`, which OVERWRITES one tiny beacon file in globalStorage
 * with the latest event `{ v, ts, id, event, tool, prompt }`. We watch that single
 * small file (event-driven, no polling) and forward the event so the NPC can fly
 * the user's actual prompt text.
 *
 * LITE: reads only this one tiny file we own (never the AI tools' transcripts);
 * the watcher runs only while the Support view is visible; stale and duplicate
 * events are dropped.
 */

interface HookBeaconPayload {
  v: 1;
  ts: number;
  id: string;
  event?: string;
  tool?: string;
  prompt?: string;
}

export interface HookBeaconEvent {
  id: string;
  name: string;
  /** Bounded prompt snippet the user just submitted (may be undefined). */
  prompt?: string;
}

const STALE_MS = 10_000;

function isHookBeacon(p: unknown): p is HookBeaconPayload {
  if (!p || typeof p !== 'object') {
    return false;
  }
  const o = p as Record<string, unknown>;
  return o.v === 1 && typeof o.ts === 'number' && typeof o.id === 'string';
}

export class HookBeaconService {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly watcherDisposables: vscode.Disposable[] = [];
  private visible = false;
  private lastTs = 0;
  private readonly dirUri: vscode.Uri;
  private readonly fileName: string;
  private readonly names: Map<string, string>;

  constructor(
    private readonly beaconUri: vscode.Uri,
    private readonly onEvent: (e: HookBeaconEvent) => void,
    private readonly fsApi: BeaconFsApi = vscode.workspace.fs,
    private readonly createWatcher: CreateWatcher = (p) => vscode.workspace.createFileSystemWatcher(p)
  ) {
    this.dirUri = vscode.Uri.joinPath(beaconUri, '..');
    this.fileName = beaconUri.path.split('/').pop() || 'npc-ai-hook-beacon.json';
    this.names = new Map(HOOK_TOOLS.map((t) => [t.id, t.name]));
  }

  /** The watcher runs only while the Support view is visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible && !this.watcher) {
      this.startWatch();
    } else if (!visible && this.watcher) {
      this.stopWatch();
    }
  }

  private startWatch(): void {
    const pattern = new vscode.RelativePattern(this.dirUri, this.fileName);
    this.watcher = this.createWatcher(pattern);
    this.watcherDisposables.push(
      this.watcher.onDidChange(() => void this.onChange()),
      this.watcher.onDidCreate(() => void this.onChange())
    );
    infoLog('npc-hook-beacon', 'watch-start', {});
  }

  private stopWatch(): void {
    this.watcherDisposables.forEach((d) => d.dispose());
    this.watcherDisposables.length = 0;
    this.watcher?.dispose();
    this.watcher = undefined;
    infoLog('npc-hook-beacon', 'watch-stop', {});
  }

  private async onChange(): Promise<void> {
    if (!this.visible) {
      return;
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
      return; // half-written file — the next event will re-fire
    }
    if (!isHookBeacon(parsed)) {
      return;
    }
    if (parsed.ts <= this.lastTs) {
      return; // duplicate watcher event for the same write
    }
    if (Date.now() - parsed.ts > STALE_MS) {
      this.lastTs = parsed.ts;
      return; // leftover from a previous session
    }
    this.lastTs = parsed.ts;
    const name = this.names.get(parsed.id) || parsed.id;
    const prompt = typeof parsed.prompt === 'string' && parsed.prompt ? parsed.prompt : undefined;
    diagLog('npc-hook-beacon', 'event', { id: parsed.id, hasPrompt: !!prompt });
    this.onEvent({ id: parsed.id, name, prompt });
  }

  dispose(): void {
    this.visible = false;
    this.stopWatch();
  }
}
