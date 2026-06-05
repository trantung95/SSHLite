// @author hybr8
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * Messages posted from the support webview to the extension.
 * Mirrors the SearchPanel message-bridge shape so logging is uniform.
 */
type SupportMessage =
  | { type: 'action'; cmd?: unknown }
  | { type: 'setSetting'; key?: unknown; value?: unknown }
  | { type: 'installHooks' }
  | { type: 'uninstallHooks' }
  | { type: 'ready' }
  | { type: 'log'; level?: unknown; scope?: unknown; event?: unknown; payload?: unknown }
  | { type: 'webviewError'; message?: unknown; stack?: unknown };

/** A single AI tool's hook state, shown in the webview's settings panel. */
export interface HookToolState {
  id: string;
  name: string;
  present: boolean;
  installed: boolean;
  /** Home-shortened hook config path (shown dim under installed tools). */
  configPath?: string;
}

/**
 * Controls AI-hook install/remove for the settings panel. HookInstallerService
 * satisfies this structurally; injected so the provider stays decoupled.
 */
export interface HookController {
  status(): HookToolState[];
  installAll(): Array<{ id: string; ok: boolean; reason?: string }>;
  uninstallAll(): Array<{ id: string; ok: boolean; reason?: string }>;
}

/**
 * Source of a typing pulse, forwarded to the webview so it can flavour the
 * popup. `ai:<id>` is used for AI-assistant file activity.
 */
export type TypedSource = 'editor' | 'terminal-in' | 'terminal-out' | 'beacon' | 'window' | `ai:${string}`;

/**
 * SupportViewProvider — the extension's first WebviewView (note: View, not
 * Panel; SearchPanel is a WebviewPanel). It renders a small, stateless promo /
 * links panel at the TOP of the SSH LITE container, collapsed by default.
 *
 * LITE compliance: it resolves only when the user expands the (collapsed-by-
 * default) section, registers no timers/polling, fetches nothing remote (the
 * promo asset is bundled and served via asWebviewUri; CSP is default-src
 * 'none'), and touches no SSH/server state. With retainContextWhenHidden:false
 * the webview is dropped when collapsed and cheaply re-resolved on expand.
 *
 * The 5 link buttons map to real sshLite.* commands (palette-discoverable and
 * unit-testable). Clicking the promo coder recolours a part of it (handled in
 * the webview) — it does not open a link.
 */
export class SupportViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sshLite.support';

  /** Allowlist of webview button actions → real `sshLite.<cmd>` commands. */
  private static readonly ACTION_COMMANDS = new Set([
    'reportIssue',
    'donate',
    'starGithub',
    'rateMarketplace',
    'shareExtension',
  ]);

  /** Allowlist of boolean settings the webview's settings panel may flip. */
  private static readonly BOOL_SETTING_KEYS = new Set(['npcAiActivity', 'npcCrossWindowBeacon']);

  /** Allowlist of string settings the webview may set (clamped + trimmed server-side). */
  private static readonly STRING_SETTING_KEYS = new Set(['npcBannerText']);

  /** Allowlist of enum settings the webview may set, with their permitted values. */
  private static readonly ENUM_SETTING_KEYS = new Map<string, Set<string>>([
    ['npcBannerMode', new Set(['occasional', 'always', 'never'])],
  ]);

  /** Valid cheering-banner visibility modes (mirror of package.json enum). */
  public static readonly BANNER_MODES = ['occasional', 'always', 'never'] as const;

  /** Coerce an arbitrary value to a valid banner mode, defaulting to 'never'. */
  public static bannerMode(value: unknown): string {
    return typeof value === 'string' && (SupportViewProvider.BANNER_MODES as readonly string[]).includes(value)
      ? value
      : 'never';
  }

  /** Max length of the cheering-banner text (mirror of package.json maxLength). */
  public static readonly BANNER_TEXT_MAX = 5;

  /** Injected AI-hook controller (set by extension.ts); undefined → hooks UI disabled. */
  private hookController: HookController | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  /** The currently-resolved view, or undefined when collapsed/disposed. */
  private view: vscode.WebviewView | undefined;

  /** Throttle for typing pulses (coalesces paste / programmatic bursts). */
  private lastTypeNotify = 0;

  /** Per-source throttle for activity pulses (keyed by `src`). */
  private readonly lastNotifyBySrc = new Map<string, number>();

  /** Last time an AI tool was reported active; used to not attribute the AI's edits to the user. */
  private lastAiActiveAt = 0;

  /** Window during which editor changes are treated as AI edits (matches the AI label TTL). */
  private static readonly AI_ACTIVE_MS = 2000;

  /**
   * Fires when the view becomes visible (true) or hidden/disposed (false).
   * External activity watchers (AI activity, cross-window beacon) gate their
   * file watchers on this so they do no work while the NPC is not on screen.
   */
  private readonly _onDidChangeVisible = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeVisible: vscode.Event<boolean> = this._onDidChangeVisible.event;

  /** Whether the view is currently resolved and visible. */
  public get isVisible(): boolean {
    return !!this.view && this.view.visible;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionPath: string,
    /** Display name shown on the "you are working" label (OS/git user name). */
    private readonly userName: string = 'You'
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    infoLog('support-view', 'resolve', { visible: webviewView.visible });

    // Defensive: VS Code may re-resolve this view (e.g. after it was hidden with
    // retainContextWhenHidden:false). Signal "not visible" so any watchers tied
    // to the previous view stop before we re-wire, then tear down prior
    // subscriptions so listeners don't accumulate across show/hide cycles.
    this._onDidChangeVisible.fire(false);
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'support')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: SupportMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    webviewView.onDidChangeVisibility(
      () => {
        infoLog('support-view', 'visibility', { visible: webviewView.visible });
        this._onDidChangeVisible.fire(webviewView.visible);
      },
      undefined,
      this.disposables
    );

    webviewView.onDidDispose(
      () => {
        infoLog('support-view', 'dispose', {});
        if (this.view === webviewView) {
          this.view = undefined;
        }
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
        this._onDidChangeVisible.fire(false);
      },
      undefined,
      this.disposables
    );

    // Announce the initial visibility so gated watchers can attach on first resolve.
    this._onDidChangeVisible.fire(webviewView.visible);
  }

  /**
   * Pulse the promo coder's hands. Called from `onDidChangeTextDocument` so the
   * pixel coder "types" whenever the user types in an editor. Cheap and guarded:
   * only posts when the view is actually visible (collapsed → no work), and
   * coalesces bursts so a paste / multi-cursor edit is one tap, not hundreds.
   */
  public notifyTyped(src: TypedSource = 'editor', text?: string, isUserInput = false): void {
    const view = this.view;
    if (!view || !view.visible) {
      return;
    }
    const now = Date.now();
    // Server output (and AI file churn) is high-volume, so throttle it harder
    // than real user typing. Throttle per-source so a noisy source can't starve
    // a quiet one.
    const minGap = src === 'terminal-out' || src.startsWith('ai:') ? 150 : 30;
    const last = this.lastNotifyBySrc.get(src) ?? 0;
    if (now - last < minGap) {
      return;
    }
    this.lastNotifyBySrc.set(src, now);
    this.lastTypeNotify = now;
    // Decide whether this is the LOCAL USER (show the "you" label + the typed
    // characters) or some other source (plain pulse, no name). `onDidChangeText
    // Document` fires identically for the user typing and for another extension
    // (Claude, a formatter) editing a file, so the caller passes `isUserInput`,
    // derived from intrinsic signals it CAN trust: a keystroke-shaped change
    // (single ≤2-char edit) for document edits, or a Keyboard/Mouse selection
    // kind for cursor moves. SSH Lite's own terminal input is always the user.
    // An AI being active in the same window is an extra guard for editor edits.
    let attributeToUser = false;
    if (src === 'terminal-in') {
      attributeToUser = true;
    } else if (src === 'editor') {
      const aiActive = now - this.lastAiActiveAt < SupportViewProvider.AI_ACTIVE_MS;
      attributeToUser = isUserInput && !aiActive;
    }
    if (attributeToUser) {
      const snippet = typeof text === 'string' && text ? text.slice(0, 24) : undefined;
      void view.webview.postMessage(
        snippet
          ? { type: 'typed', src, user: this.userName, text: snippet }
          : { type: 'typed', src, user: this.userName }
      );
      diagLog('support-view', 'typed', { src, hasText: !!snippet });
    } else {
      void view.webview.postMessage({ type: 'typed', src });
      diagLog('support-view', 'typed', { src, user: false });
    }
  }

  /** Wire the AI-hook controller (install/remove/status). */
  public setHookController(controller: HookController): void {
    this.hookController = controller;
  }

  /**
   * Tell the webview an AI coding assistant is currently active so it can show a
   * floating name label around the NPC. The label is removed by the webview once
   * no further activity arrives for a few seconds (TTL). Carries the tool's id +
   * display name, and — when the user installed prompt hooks — the bounded
   * `prompt` snippet so the NPC can fly the actual typed text. Never read from a
   * transcript; the prompt is pushed by the tool's own hook.
   */
  public notifyAiActive(id: string, name: string, prompt?: string): void {
    const view = this.view;
    if (!view || !view.visible) {
      return;
    }
    const now = Date.now();
    // Mark AI as active so a near-simultaneous editor change (the AI editing a
    // file) is not misattributed to the local user. Set before the throttle so
    // even coalesced pulses keep the window fresh.
    this.lastAiActiveAt = now;
    const key = `ai:${id}`;
    const last = this.lastNotifyBySrc.get(key) ?? 0;
    // A prompt-carrying hook event bypasses the throttle (it is rare and the
    // real content we most want to show); plain activity pulses stay throttled.
    if (!prompt && now - last < 150) {
      return;
    }
    this.lastNotifyBySrc.set(key, now);
    this.lastTypeNotify = now;
    void view.webview.postMessage(
      prompt ? { type: 'aiActive', id, name, prompt } : { type: 'aiActive', id, name }
    );
    diagLog('support-view', 'ai-active', { id, hasPrompt: !!prompt });
  }

  /**
   * Reflect the NPC settings (`npcAiActivity`, `npcCrossWindowBeacon`) on the
   * webview's settings-panel toggles. Sent on the `ready` handshake and whenever
   * a setting changes (panel or Settings UI) so the panel stays in sync.
   */
  public postSettings(settings: {
    npcAiActivity: boolean;
    npcCrossWindowBeacon: boolean;
    npcBannerText: string;
    npcBannerMode: string;
  }): void {
    const view = this.view;
    if (!view) {
      return;
    }
    void view.webview.postMessage({ type: 'settings', ...settings });
    // Log the banner text's length only, never its content.
    diagLog('support-view', 'settings', { ...settings, npcBannerText: settings.npcBannerText.length });
  }

  /** Push the AI-hook install state to the webview's settings panel. */
  public postHookStatus(message?: string): void {
    const view = this.view;
    if (!view || !this.hookController) {
      return;
    }
    let tools: HookToolState[] = [];
    try {
      tools = this.hookController.status();
    } catch (err) {
      infoLog('support-view', 'hook-status-failed', { error: (err as Error).message });
    }
    void view.webview.postMessage({ type: 'hookStatus', tools, message });
    diagLog('support-view', 'hook-status', { count: tools.length });
  }

  /** Dispose provider-level resources (the visibility event emitter). */
  public dispose(): void {
    this._onDidChangeVisible.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }

  /** Generate a CSP nonce per webview load. */
  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  /**
   * Build the webview HTML. Mirrors SearchPanel.getWebviewContent: identical
   * CSP and a per-load nonce, with asWebviewUri for the bundled JS/CSS. The
   * promo is a pixel-art animation drawn on a <canvas> by the bundled script,
   * so there is no image asset to reference. CSP keeps `img-src ${cspSource}
   * data:` for parity with SearchPanel — no relaxation, no remote origins.
   */
  private getHtml(webview: vscode.Webview): string {
    const nonce = SupportViewProvider.makeNonce();
    const cspSource = webview.cspSource;

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'support');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));

    const csp = [
      `default-src 'none'`,
      `script-src ${cspSource} 'nonce-${nonce}'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data:`,
      `font-src ${cspSource}`,
    ].join('; ');

    const htmlPath = path.join(this.extensionPath, 'media', 'support', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace('__CSP__', csp)
      .replace('__STYLES_URI__', stylesUri.toString())
      .replace('__SCRIPT_URI__', scriptUri.toString())
      .replace('__NONCE__', nonce);

    diagLog('support-view', 'load-html', { htmlPath, nonceLen: nonce.length, bytes: html.length });
    return html;
  }

  /** Handle messages posted from the webview. */
  private async handleMessage(message: SupportMessage): Promise<void> {
    diagLog('support-view', 'recv', { type: typeof message?.type === 'string' ? message.type : 'unknown' });
    switch (message.type) {
      case 'log': {
        const level = message.level === 'diag' ? 'diag' : 'info';
        const scope = typeof message.scope === 'string' ? message.scope : 'support-webview';
        const event = typeof message.event === 'string' ? message.event : 'unknown';
        const payload = message.payload && typeof message.payload === 'object'
          ? (message.payload as Record<string, unknown>)
          : undefined;
        if (level === 'info') {
          infoLog(scope, event, payload);
        } else {
          diagLog(scope, event, payload);
        }
        break;
      }

      case 'webviewError': {
        infoLog('support-view', 'webview-error', {
          message: typeof message.message === 'string' ? message.message : '(no message)',
          stack: typeof message.stack === 'string' ? message.stack.slice(0, 1000) : undefined,
        });
        break;
      }

      case 'action': {
        const cmd = typeof message.cmd === 'string' ? message.cmd : '';
        infoLog('support-view', 'action', { cmd });
        if (SupportViewProvider.ACTION_COMMANDS.has(cmd)) {
          await vscode.commands.executeCommand(`sshLite.${cmd}`);
        } else {
          infoLog('support-view', 'action-unknown', { cmd });
        }
        break;
      }

      case 'setSetting': {
        const key = typeof message.key === 'string' ? message.key : '';
        if (SupportViewProvider.BOOL_SETTING_KEYS.has(key)) {
          const value = !!message.value;
          infoLog('support-view', 'set-setting', { key, value });
          await vscode.workspace
            .getConfiguration('sshLite')
            .update(key, value, vscode.ConfigurationTarget.Global);
        } else if (SupportViewProvider.STRING_SETTING_KEYS.has(key)) {
          // Clamp + trim defensively (the webview maxlength is not authoritative).
          const raw = typeof message.value === 'string' ? message.value : '';
          const value = raw.trim().slice(0, SupportViewProvider.BANNER_TEXT_MAX);
          infoLog('support-view', 'set-setting', { key, len: value.length });
          await vscode.workspace
            .getConfiguration('sshLite')
            .update(key, value, vscode.ConfigurationTarget.Global);
        } else if (SupportViewProvider.ENUM_SETTING_KEYS.has(key)) {
          // Only accept one of the declared enum values.
          const allowed = SupportViewProvider.ENUM_SETTING_KEYS.get(key)!;
          const value = typeof message.value === 'string' ? message.value : '';
          if (allowed.has(value)) {
            infoLog('support-view', 'set-setting', { key, value });
            await vscode.workspace
              .getConfiguration('sshLite')
              .update(key, value, vscode.ConfigurationTarget.Global);
          } else {
            infoLog('support-view', 'set-setting-invalid', { key });
          }
        } else {
          infoLog('support-view', 'set-setting-unknown', { key });
        }
        break;
      }

      case 'installHooks':
      case 'uninstallHooks': {
        if (!this.hookController) {
          break;
        }
        const installing = message.type === 'installHooks';
        infoLog('support-view', installing ? 'hooks-install' : 'hooks-uninstall', {});
        let results: Array<{ id: string; ok: boolean; reason?: string }> = [];
        try {
          results = installing ? this.hookController.installAll() : this.hookController.uninstallAll();
        } catch (err) {
          infoLog('support-view', 'hooks-op-failed', { error: (err as Error).message });
        }
        const ok = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        const verb = installing ? 'Installed' : 'Removed';
        let summary = results.length === 0 ? 'No AI tools found to set up.' : `${verb} hooks for ${ok} tool(s).`;
        if (failed.length) {
          summary += ` ${failed.length} skipped.`;
        }
        this.postHookStatus(summary);
        break;
      }

      case 'ready': {
        // Webview just wired its listeners — echo current settings + hook state so
        // the panel renders correctly.
        const cfg = vscode.workspace.getConfiguration('sshLite');
        this.postSettings({
          npcAiActivity: cfg.get<boolean>('npcAiActivity', true),
          npcCrossWindowBeacon: cfg.get<boolean>('npcCrossWindowBeacon', true),
          npcBannerText: (cfg.get<string>('npcBannerText', 'VN') ?? 'VN')
            .trim()
            .slice(0, SupportViewProvider.BANNER_TEXT_MAX),
          npcBannerMode: SupportViewProvider.bannerMode(cfg.get<string>('npcBannerMode', 'never')),
        });
        this.postHookStatus();
        break;
      }

      default:
        break;
    }
  }
}
