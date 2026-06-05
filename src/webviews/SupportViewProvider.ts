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
  | { type: 'log'; level?: unknown; scope?: unknown; event?: unknown; payload?: unknown }
  | { type: 'webviewError'; message?: unknown; stack?: unknown };

/**
 * Source of a typing pulse, forwarded to the webview so it can flavour the
 * popup. `ai:<id>` is used for AI-assistant file activity.
 */
export type TypedSource = 'editor' | 'terminal-in' | 'terminal-out' | 'beacon' | `ai:${string}`;

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

  private readonly disposables: vscode.Disposable[] = [];

  /** The currently-resolved view, or undefined when collapsed/disposed. */
  private view: vscode.WebviewView | undefined;

  /** Throttle for typing pulses (coalesces paste / programmatic bursts). */
  private lastTypeNotify = 0;

  /** Per-source throttle for activity pulses (keyed by `src`). */
  private readonly lastNotifyBySrc = new Map<string, number>();

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
  public notifyTyped(src: TypedSource = 'editor'): void {
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
    // `user` lets the webview show a "you are working" label (mirrors the AI
    // name labels) when the source is the local user (editor / own terminal).
    void view.webview.postMessage({ type: 'typed', src, user: this.userName });
    diagLog('support-view', 'typed', { src });
  }

  /**
   * Tell the webview an AI coding assistant is currently active so it can show a
   * floating name label around the NPC. The label is removed by the webview once
   * no further activity arrives for a few seconds (TTL). Carries only the tool's
   * id + display name — never any transcript content.
   */
  public notifyAiActive(id: string, name: string): void {
    const view = this.view;
    if (!view || !view.visible) {
      return;
    }
    const now = Date.now();
    const key = `ai:${id}`;
    const last = this.lastNotifyBySrc.get(key) ?? 0;
    if (now - last < 150) {
      return;
    }
    this.lastNotifyBySrc.set(key, now);
    this.lastTypeNotify = now;
    void view.webview.postMessage({ type: 'aiActive', id, name });
    diagLog('support-view', 'ai-active', { id });
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

      default:
        break;
    }
  }
}
