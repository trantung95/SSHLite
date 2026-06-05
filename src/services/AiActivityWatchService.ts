// @author hybr8
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { infoLog, diagLog } from '../utils/diagnosticLog';
import { CreateWatcher } from './BeaconService';

/**
 * AiActivityWatchService — make the Support view NPC react when a popular AI
 * coding assistant is actively working.
 *
 * VS Code extensions can't observe other tools' UI or keystrokes, but most AI
 * assistants append/rewrite a transcript/history/session file on disk every turn.
 * We watch those files with `createFileSystemWatcher` (event-driven, no polling)
 * and, on a change, tell the webview which tool is active so it can show a
 * floating name label around the NPC.
 *
 * Privacy/LITE: we react ONLY to file change/create events — never read the
 * transcript contents. Watchers attach only while the setting is on AND the
 * Support view is visible, skip non-existent base directories, use the narrowest
 * root that still catches the file (never `${HOME}` with `**`), and are disposed
 * on hide / disable / deactivate.
 *
 * Granularity is per turn / per tool-call (the chat input is a webview — typed
 * characters aren't written to disk until submit), not per keystroke.
 */

export interface AiWatchCtx {
  /** os.homedir() */
  home: string;
  workspaceFolders: readonly vscode.WorkspaceFolder[];
  /** Parent of this extension's globalStorage, i.e. `.../User/globalStorage`. */
  globalStorageParent: vscode.Uri;
}

export interface AiRoot {
  base: vscode.Uri;
  glob: string;
}

export interface AiToolDescriptor {
  id: string;
  /** Display name shown as the floating label on the NPC. */
  name: string;
  roots(ctx: AiWatchCtx): AiRoot[];
}

const homeUri = (home: string, ...segs: string[]): vscode.Uri => vscode.Uri.file(path.join(home, ...segs));

/**
 * Built-in registry of watchable AI coding assistants. Paths are derived per
 * user (home), per project (workspace), and per VS Code variant (globalStorage
 * parent) — never hard-coded to one machine. Only tools that write a clean,
 * predictable transcript/history file are included; autocomplete-only or
 * opaque-DB tools (Tabnine, Codeium completion, Amazon Q, JetBrains, Zed-LMDB,
 * Cursor/Windsurf SQLite) are intentionally omitted as unreliable to watch.
 */
export const DEFAULT_AI_TOOLS: AiToolDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    // The cwd-encoded folder name can collide (anthropics/claude-code#7009), so
    // watch the whole tree rather than computing the exact folder.
    roots: (c) => [{ base: homeUri(c.home, '.claude', 'projects'), glob: '**/*.jsonl' }],
  },
  {
    id: 'codex',
    name: 'Codex',
    roots: (c) => [{ base: homeUri(c.home, '.codex', 'sessions'), glob: '**/*.jsonl' }],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    roots: (c) => [{ base: homeUri(c.home, '.gemini', 'tmp'), glob: '**/*.json' }],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    // Watch the JSONL transcript, never the SQLite state DB.
    roots: (c) => [{ base: homeUri(c.home, '.cursor', 'projects'), glob: '**/agent-transcripts/*.jsonl' }],
  },
  {
    id: 'aider',
    name: 'Aider',
    // Per-project: the history file lives in the repo root.
    roots: (c) => c.workspaceFolders.map((wf) => ({ base: wf.uri, glob: '.aider.chat.history.md' })),
  },
  {
    id: 'cline',
    name: 'Cline',
    roots: (c) => [{ base: vscode.Uri.joinPath(c.globalStorageParent, 'saoudrizwan.claude-dev', 'tasks'), glob: '**/ui_messages.json' }],
  },
  {
    id: 'roo',
    name: 'Roo Code',
    roots: (c) => [{ base: vscode.Uri.joinPath(c.globalStorageParent, 'rooveterinaryinc.roo-cline', 'tasks'), glob: '**/ui_messages.json' }],
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    roots: (c) => [{ base: vscode.Uri.joinPath(c.globalStorageParent, 'kilocode.kilo-code', 'tasks'), glob: '**/ui_messages.json' }],
  },
  {
    id: 'continue',
    name: 'Continue',
    roots: (c) => [
      { base: homeUri(c.home, '.continue', 'sessions'), glob: '*.json' },
      { base: homeUri(c.home, '.continue', 'dev_data'), glob: '**/*.jsonl' },
    ],
  },
  {
    id: 'github-copilot',
    name: 'Copilot',
    // Copilot Chat only — inline completions are not persisted to disk.
    roots: (c) => [{ base: vscode.Uri.joinPath(c.globalStorageParent, '..', 'workspaceStorage'), glob: '**/chatSessions/*.json' }],
  },
];

export interface AiActivityWatchOptions {
  tools?: AiToolDescriptor[];
  fsExists?: (fsPath: string) => boolean;
  createWatcher?: CreateWatcher;
}

export class AiActivityWatchService {
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly watcherDisposables: vscode.Disposable[] = [];
  private enabled = false;
  private visible = false;
  private toolFilter: string[] = []; // empty = all

  private readonly tools: AiToolDescriptor[];
  private readonly fsExists: (fsPath: string) => boolean;
  private readonly createWatcher: CreateWatcher;

  constructor(
    private readonly ctx: AiWatchCtx,
    private readonly onToolActive: (id: string, name: string) => void,
    opts: AiActivityWatchOptions = {}
  ) {
    this.tools = opts.tools ?? DEFAULT_AI_TOOLS;
    this.fsExists = opts.fsExists ?? ((p) => fs.existsSync(p));
    this.createWatcher = opts.createWatcher ?? ((p) => vscode.workspace.createFileSystemWatcher(p));
  }

  /** Driven by `sshLite.npcAiActivity`. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.rebuild();
  }

  /** Driven by `sshLite.npcAiActivityTools` ([] = all known tools). */
  setToolFilter(ids: string[]): void {
    const next = Array.isArray(ids) ? ids : [];
    if (next.length === this.toolFilter.length && next.every((id, i) => id === this.toolFilter[i])) {
      return;
    }
    this.toolFilter = next;
    if (this.enabled && this.visible) {
      this.rebuild(true);
    }
  }

  /** Driven by Support-view visibility. Watchers only run while visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    this.rebuild();
  }

  private selectedTools(): AiToolDescriptor[] {
    if (this.toolFilter.length === 0) {
      return this.tools;
    }
    const set = new Set(this.toolFilter);
    return this.tools.filter((t) => set.has(t.id));
  }

  private rebuild(force = false): void {
    const shouldWatch = this.enabled && this.visible;
    if (!shouldWatch) {
      this.stop();
      return;
    }
    if (this.watchers.length > 0 && !force) {
      return; // already watching, nothing changed
    }
    this.stop();
    this.start();
  }

  private start(): void {
    let count = 0;
    for (const tool of this.selectedTools()) {
      let roots: AiRoot[];
      try {
        roots = tool.roots(this.ctx);
      } catch {
        continue;
      }
      for (const root of roots) {
        // Normalize bases that contain `..` (e.g. the Copilot workspaceStorage
        // path derived from globalStorage's parent) so the existence check and
        // the watcher pattern use a canonical path — a non-normalized URI can
        // make createFileSystemWatcher miss events on some VS Code versions.
        const needsNorm = root.base.fsPath.includes('..');
        const baseFsPath = needsNorm ? path.normalize(root.base.fsPath) : root.base.fsPath;
        const baseUri = needsNorm ? vscode.Uri.file(baseFsPath) : root.base;
        // Skip non-existent base dirs to avoid wasted recursive watchers.
        if (!this.fsExists(baseFsPath)) {
          continue;
        }
        try {
          const watcher = this.createWatcher(new vscode.RelativePattern(baseUri, root.glob));
          const handler = () => this.handleActivity(tool.id, tool.name);
          this.watcherDisposables.push(watcher.onDidChange(handler), watcher.onDidCreate(handler));
          this.watchers.push(watcher);
          count++;
        } catch (err) {
          diagLog('npc-ai', 'watch-error', { tool: tool.id, error: (err as Error).message });
        }
      }
    }
    infoLog('npc-ai', 'watch-start', { watchers: count });
  }

  private stop(): void {
    if (this.watchers.length === 0 && this.watcherDisposables.length === 0) {
      return;
    }
    this.watcherDisposables.forEach((d) => d.dispose());
    this.watcherDisposables.length = 0;
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    infoLog('npc-ai', 'watch-stop', {});
  }

  private handleActivity(id: string, name: string): void {
    diagLog('npc-ai', 'activity', { tool: id });
    this.onToolActive(id, name);
  }

  dispose(): void {
    this.stop();
  }
}
