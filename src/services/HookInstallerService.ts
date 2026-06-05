// @author hybr8
import * as fs from 'fs';
import * as path from 'path';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * HookInstallerService — opt-in, user-triggered installer that adds a tiny
 * "prompt-submit" hook into the AI coding tools the user already has, so the
 * Support-view NPC can fly the user's actual prompt text instead of reading
 * transcript files. Each tool runs a small bundled Node script (`npc-beacon.js`)
 * that overwrites one tiny beacon file SSH Lite watches (see HookBeaconService).
 *
 * SAFETY (do not break the user's config) — every write goes through these rules:
 *   - Parse-or-abort: if an existing config file is not valid JSON, we DO NOT
 *     touch it (no overwrite, no data loss) and report the reason.
 *   - Append-only merge: we only add our single hook entry; all other keys and
 *     the user's existing hooks are preserved untouched.
 *   - Idempotent: re-running install never duplicates our entry (dedup by the
 *     `npc-beacon.js` marker in the command string).
 *   - Backup + atomic: the prior file is copied to `<file>.sshlite.bak`, then we
 *     write a temp sibling and rename it over the target (no half-written file).
 *   - Presence-gated: we only write into a tool's config when that tool is
 *     actually present (its home dir exists) — never create configs for tools the
 *     user does not use.
 *   - Uninstall removes ONLY our entry (matched by the marker); Copilot uses its
 *     own dedicated file, so removing it can never affect the user's other hooks.
 *
 * Each AI tool has a different hook schema, so the registry below encodes the
 * exact shape per tool (verified against each tool's official hooks docs).
 */

/** The marker that identifies our hook entry inside any tool's config. */
const MARKER = 'npc-beacon.js';

const containsMarker = (s: unknown): boolean => typeof s === 'string' && s.includes(MARKER);

/** Minimal sync fs surface (injectable for tests). */
export interface HookFsApi {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(p: string): void;
}

const defaultFs: HookFsApi = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  renameSync: (a, b) => fs.renameSync(a, b),
  mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
  copyFileSync: (a, b) => fs.copyFileSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
};

/** Paths/command bits resolved by the extension at runtime. */
export interface HookInstallCtx {
  /** Bundled source of the beacon script (`<extension>/assets/hooks/npc-beacon.js`). */
  assetScriptPath: string;
  /** Stable copy location that survives extension updates (under globalStorage). */
  scriptPath: string;
  /** The single beacon file SSH Lite watches (under globalStorage). */
  beaconPath: string;
  /** Node launcher to invoke in the hook (default `node`). */
  nodeCmd?: string;
}

type ConfigObject = Record<string, unknown>;

/** A watchable AI tool whose hook config we can safely write. */
export interface HookTool {
  id: string;
  name: string;
  /** Directory whose existence means the tool is installed for this user. */
  homeDir(home: string): string;
  /** The config file we read/modify (or, for `ownFile`, the dedicated file we own). */
  configPath(home: string): string;
  /** True when we own the whole file (Copilot) — install overwrites, uninstall deletes. */
  ownFile?: boolean;
  /** Merge our hook into a parsed config; idempotent. */
  apply(config: ConfigObject, command: string): ConfigObject;
  /** True if our hook is already present in a parsed config. */
  has(config: ConfigObject): boolean;
  /** Remove our hook from a parsed config; return `null` to signal "delete the file". */
  remove(config: ConfigObject): ConfigObject | null;
}

// ── schema-family helpers ────────────────────────────────────────────────────
// Nested family (Claude Code, Codex, Gemini): hooks → <event> → [{ hooks: [{ type, command }] }]
function applyNested(config: ConfigObject, event: string, command: string): ConfigObject {
  const c: ConfigObject = config && typeof config === 'object' ? config : {};
  const hooks = (c.hooks && typeof c.hooks === 'object' ? c.hooks : (c.hooks = {})) as Record<string, unknown>;
  const arr = (Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = [])) as unknown[];
  if (!hasNested(c, event)) {
    arr.push({ hooks: [{ type: 'command', command }] });
  }
  return c;
}
function hasNested(config: ConfigObject, event: string): boolean {
  const arr = (config?.hooks as Record<string, unknown>)?.[event];
  if (!Array.isArray(arr)) {
    return false;
  }
  return arr.some(
    (g) =>
      g && typeof g === 'object' && Array.isArray((g as { hooks?: unknown }).hooks) &&
      ((g as { hooks: unknown[] }).hooks).some((h) => containsMarker((h as { command?: unknown })?.command))
  );
}
function removeNested(config: ConfigObject, event: string): ConfigObject {
  const hooks = config?.hooks as Record<string, unknown> | undefined;
  const arr = hooks?.[event];
  if (!hooks || !Array.isArray(arr)) {
    return config;
  }
  const pruned = (arr as unknown[])
    .map((g) => {
      if (g && typeof g === 'object' && Array.isArray((g as { hooks?: unknown }).hooks)) {
        (g as { hooks: unknown[] }).hooks = (g as { hooks: unknown[] }).hooks.filter(
          (h) => !containsMarker((h as { command?: unknown })?.command)
        );
      }
      return g;
    })
    .filter((g) => !(g && typeof g === 'object') || !Array.isArray((g as { hooks?: unknown }).hooks) || (g as { hooks: unknown[] }).hooks.length > 0);
  if (pruned.length > 0) {
    hooks[event] = pruned;
  } else {
    delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
  }
  return config;
}

// Flat family (Cursor): version:1, hooks → <event> → [{ command }]
function applyFlat(config: ConfigObject, event: string, command: string): ConfigObject {
  const c: ConfigObject = config && typeof config === 'object' ? config : {};
  if (c.version === undefined) {
    c.version = 1;
  }
  const hooks = (c.hooks && typeof c.hooks === 'object' ? c.hooks : (c.hooks = {})) as Record<string, unknown>;
  const arr = (Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = [])) as unknown[];
  if (!hasFlat(c, event)) {
    arr.push({ command });
  }
  return c;
}
function hasFlat(config: ConfigObject, event: string): boolean {
  const arr = (config?.hooks as Record<string, unknown>)?.[event];
  return Array.isArray(arr) && arr.some((h) => containsMarker((h as { command?: unknown })?.command));
}
function removeFlat(config: ConfigObject, event: string): ConfigObject {
  const hooks = config?.hooks as Record<string, unknown> | undefined;
  const arr = hooks?.[event];
  if (!hooks || !Array.isArray(arr)) {
    return config;
  }
  const pruned = (arr as unknown[]).filter((h) => !containsMarker((h as { command?: unknown })?.command));
  if (pruned.length > 0) {
    hooks[event] = pruned;
  } else {
    delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
  }
  return config;
}

const j = (home: string, ...segs: string[]): string => path.join(home, ...segs);

/**
 * Registry of tools whose hook config we can write safely (verified schemas).
 * Cline is UI-only (script-in-directory + in-app toggle, macOS/Linux only) so it
 * is intentionally excluded; Aider / Roo Code ship no hooks.
 */
export const HOOK_TOOLS: HookTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    homeDir: (h) => j(h, '.claude'),
    configPath: (h) => j(h, '.claude', 'settings.json'),
    apply: (c, cmd) => applyNested(c, 'UserPromptSubmit', cmd),
    has: (c) => hasNested(c, 'UserPromptSubmit'),
    remove: (c) => removeNested(c, 'UserPromptSubmit'),
  },
  {
    id: 'codex',
    name: 'Codex',
    homeDir: (h) => j(h, '.codex'),
    configPath: (h) => j(h, '.codex', 'hooks.json'),
    apply: (c, cmd) => applyNested(c, 'UserPromptSubmit', cmd),
    has: (c) => hasNested(c, 'UserPromptSubmit'),
    remove: (c) => removeNested(c, 'UserPromptSubmit'),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    homeDir: (h) => j(h, '.gemini'),
    configPath: (h) => j(h, '.gemini', 'settings.json'),
    // Gemini's prompt-submit event is BeforeAgent (no UserPromptSubmit event).
    apply: (c, cmd) => applyNested(c, 'BeforeAgent', cmd),
    has: (c) => hasNested(c, 'BeforeAgent'),
    remove: (c) => removeNested(c, 'BeforeAgent'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    homeDir: (h) => j(h, '.cursor'),
    configPath: (h) => j(h, '.cursor', 'hooks.json'),
    apply: (c, cmd) => applyFlat(c, 'beforeSubmitPrompt', cmd),
    has: (c) => hasFlat(c, 'beforeSubmitPrompt'),
    remove: (c) => removeFlat(c, 'beforeSubmitPrompt'),
  },
  {
    id: 'github-copilot',
    name: 'Copilot',
    ownFile: true,
    homeDir: (h) => j(h, '.copilot'),
    // Dedicated file we own entirely — never shares space with the user's hooks.
    configPath: (h) => j(h, '.copilot', 'hooks', 'ssh-lite-npc.json'),
    apply: (_c, cmd) => ({
      version: 1,
      hooks: { userPromptSubmitted: [{ type: 'command', bash: cmd, powershell: cmd }] },
    }),
    has: (c) => !!c && JSON.stringify(c).includes(MARKER),
    remove: () => null, // signal: delete the file
  },
];

export interface HookToolStatus {
  id: string;
  name: string;
  present: boolean;
  installed: boolean;
  /** Home-shortened path of the tool's hook config file (for display). */
  configPath: string;
}

export interface HookOpResult {
  id: string;
  ok: boolean;
  reason?: string;
}

type ReadResult = { status: 'ok'; value: ConfigObject } | { status: 'absent' } | { status: 'unparseable' };

export class HookInstallerService {
  constructor(
    private readonly home: string,
    private readonly ctx: HookInstallCtx,
    private readonly fsApi: HookFsApi = defaultFs,
    private readonly tools: HookTool[] = HOOK_TOOLS
  ) {}

  /** The exact command string the hook runs: `node "<script>" "<beacon>" <toolId>`. */
  private command(toolId: string): string {
    const node = this.ctx.nodeCmd || 'node';
    return `${node} "${this.ctx.scriptPath}" "${this.ctx.beaconPath}" ${toolId}`;
  }

  private present(tool: HookTool): boolean {
    try {
      return this.fsApi.existsSync(tool.homeDir(this.home));
    } catch {
      return false;
    }
  }

  private safeRead(p: string): ReadResult {
    if (!this.fsApi.existsSync(p)) {
      return { status: 'absent' };
    }
    let txt: string;
    try {
      txt = this.fsApi.readFileSync(p);
    } catch {
      return { status: 'absent' };
    }
    if (!txt || txt.trim() === '') {
      return { status: 'absent' };
    }
    try {
      // Strip __proto__/constructor keys defensively so a hand-edited or hostile
      // config can never round-trip a polluting key back through our write.
      const v = JSON.parse(txt, (k, val) => (k === '__proto__' || k === 'constructor' ? undefined : val));
      return { status: 'ok', value: v && typeof v === 'object' ? (v as ConfigObject) : {} };
    } catch {
      return { status: 'unparseable' };
    }
  }

  /** Backup → temp-write → rename. Never leaves a half-written config behind. */
  private atomicWrite(p: string, obj: ConfigObject): void {
    this.fsApi.mkdirSync(path.dirname(p));
    if (this.fsApi.existsSync(p)) {
      try {
        this.fsApi.copyFileSync(p, p + '.sshlite.bak');
      } catch {
        /* backup is best-effort */
      }
    }
    const tmp = p + '.sshlite.tmp';
    this.fsApi.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    this.fsApi.renameSync(tmp, p);
  }

  /** Copy the bundled beacon script to its stable location (survives ext updates). */
  private ensureScript(): boolean {
    try {
      this.fsApi.mkdirSync(path.dirname(this.ctx.scriptPath));
      this.fsApi.copyFileSync(this.ctx.assetScriptPath, this.ctx.scriptPath);
      return true;
    } catch (err) {
      infoLog('npc-hooks', 'script-copy-failed', { error: (err as Error).message });
      return false;
    }
  }

  /** Display a path with the home dir collapsed to `~`. */
  private displayPath(p: string): string {
    return p.startsWith(this.home) ? '~' + p.slice(this.home.length) : p;
  }

  /** Present + installed state for every known tool (drives the webview UI). */
  status(): HookToolStatus[] {
    return this.tools.map((tool) => {
      const cfgPath = tool.configPath(this.home);
      const present = this.present(tool);
      let installed = false;
      if (present) {
        const r = this.safeRead(cfgPath);
        installed = r.status === 'ok' && tool.has(r.value);
      }
      return { id: tool.id, name: tool.name, present, installed, configPath: this.displayPath(cfgPath) };
    });
  }

  private byId(id: string): HookTool | undefined {
    return this.tools.find((t) => t.id === id);
  }

  install(id: string): HookOpResult {
    const tool = this.byId(id);
    if (!tool) {
      return { id, ok: false, reason: 'unknown tool' };
    }
    if (!this.present(tool)) {
      return { id, ok: false, reason: 'tool not installed on this machine' };
    }
    if (!this.ensureScript()) {
      return { id, ok: false, reason: 'could not stage the hook script' };
    }
    const cfgPath = tool.configPath(this.home);
    const read = this.safeRead(cfgPath);
    if (read.status === 'unparseable') {
      // Never clobber a config we cannot safely parse.
      return { id, ok: false, reason: `${cfgPath} is not valid JSON — left untouched` };
    }
    const base: ConfigObject = read.status === 'ok' ? read.value : {};
    if (read.status === 'ok' && tool.has(base)) {
      // Already installed (e.g. the button was clicked again): the script was
      // refreshed above, but do NOT rewrite the config — that would clobber the
      // original `.sshlite.bak` with the already-modified config. No-op.
      return { id, ok: true };
    }
    try {
      const next = tool.apply(base, this.command(id));
      this.atomicWrite(cfgPath, next);
      infoLog('npc-hooks', 'install', { id, cfg: cfgPath });
      return { id, ok: true };
    } catch (err) {
      return { id, ok: false, reason: (err as Error).message };
    }
  }

  uninstall(id: string): HookOpResult {
    const tool = this.byId(id);
    if (!tool) {
      return { id, ok: false, reason: 'unknown tool' };
    }
    const cfgPath = tool.configPath(this.home);
    const read = this.safeRead(cfgPath);
    if (read.status === 'absent') {
      return { id, ok: true }; // nothing to remove
    }
    if (read.status === 'unparseable') {
      return { id, ok: false, reason: `${cfgPath} is not valid JSON — left untouched` };
    }
    if (!tool.has(read.value)) {
      // Our hook isn't there (e.g. Remove clicked twice) — nothing to do, and we
      // avoid a needless rewrite/backup of the user's config.
      return { id, ok: true };
    }
    try {
      const next = tool.remove(read.value);
      if (next === null) {
        // Own-file tool (Copilot): back up then delete our dedicated file.
        try {
          this.fsApi.copyFileSync(cfgPath, cfgPath + '.sshlite.bak');
        } catch {
          /* best-effort */
        }
        this.fsApi.unlinkSync(cfgPath);
      } else {
        this.atomicWrite(cfgPath, next);
      }
      infoLog('npc-hooks', 'uninstall', { id, cfg: cfgPath });
      return { id, ok: true };
    } catch (err) {
      return { id, ok: false, reason: (err as Error).message };
    }
  }

  /** Install into every present tool. Returns a per-tool result list. */
  installAll(): HookOpResult[] {
    return this.tools.filter((t) => this.present(t)).map((t) => this.install(t.id));
  }

  /**
   * Remove our hook from every tool that currently has it. Once nothing is left
   * installed, also delete the staged beacon script + beacon file from
   * globalStorage — the housekeeper never sweeps globalStorage (it only handles
   * `sshlite-diff-*` temp dirs), so removal cleans up its own artifacts here.
   */
  uninstallAll(): HookOpResult[] {
    const results = this.status()
      .filter((s) => s.installed)
      .map((s) => this.uninstall(s.id));
    // Clean up the staged script + beacon once every removal succeeded (an empty
    // results list means nothing was installed → orphaned artifacts can still go).
    // Derive from the results we already have rather than re-reading every config.
    if (results.every((r) => r.ok)) {
      this.cleanupStagedArtifacts();
    }
    return results;
  }

  private removeQuietly(p: string): void {
    try {
      if (this.fsApi.existsSync(p)) {
        this.fsApi.unlinkSync(p);
      }
    } catch (err) {
      diagLog('npc-hooks', 'cleanup-failed', { path: p, error: (err as Error).message });
    }
  }

  /** Delete the staged beacon script + beacon file (and any stale temp sibling). */
  private cleanupStagedArtifacts(): void {
    this.removeQuietly(this.ctx.scriptPath);
    this.removeQuietly(this.ctx.beaconPath);
    this.removeQuietly(this.ctx.beaconPath + '.tmp');
    infoLog('npc-hooks', 'cleanup-artifacts', {});
  }
}
