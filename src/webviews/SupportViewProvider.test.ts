/**
 * SupportViewProvider tests
 *
 * SupportViewProvider is the extension's first WebviewView. It is small and
 * stateless, so we test the two things that matter:
 *   1. getHtml() injects a per-load nonce, the locked-down CSP, and
 *      asWebviewUri'd asset URIs (bundled JS/CSS + the bundled promo asset).
 *   2. handleMessage() maps webview button actions to the right sshLite.*
 *      commands (or opens the promo URL), and forwards log messages.
 *
 * fs.readFileSync is stubbed so the test is hermetic (no dependence on a built
 * media/support/index.html on disk), mirroring SearchPanel.test's style.
 */

import * as fs from 'fs';
import { SupportViewProvider } from './SupportViewProvider';
import { commands, env, createMockWebviewView, Uri, workspace, ConfigurationTarget } from '../__mocks__/vscode';
import { infoLog, diagLog } from '../utils/diagnosticLog';

// Mock at the module-registry level so the provider's own `import * as fs`
// (a separate interop-wildcard copy under @swc/jest) sees the same stub.
// jest.spyOn(fs, ...) does NOT cross that interop boundary with this transpiler.
jest.mock('fs');

jest.mock('../utils/diagnosticLog', () => ({
  infoLog: jest.fn(),
  diagLog: jest.fn(),
}));

// Fixture HTML carrying every placeholder the provider substitutes.
const FIXTURE_HTML = [
  '<meta http-equiv="Content-Security-Policy" content="__CSP__">',
  '<link rel="stylesheet" href="__STYLES_URI__">',
  '<canvas id="promoCanvas"></canvas>',
  '<button data-cmd="reportIssue">bug</button>',
  '<script nonce="__NONCE__" src="__SCRIPT_URI__"></script>',
].join('\n');

function makeProvider(): SupportViewProvider {
  return new SupportViewProvider(Uri.file('/extension') as any, '/extension');
}

describe('SupportViewProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.readFileSync as jest.Mock).mockReturnValue(FIXTURE_HTML);
  });

  describe('getHtml (via resolveWebviewView)', () => {
    it('injects a 32-char nonce, the locked-down CSP, and bundled asset URIs', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();

      provider.resolveWebviewView(view as any, {} as any, {} as any);

      const html = view.webview.html;

      // CSP — default-src none, nonce'd scripts, img allows the webview origin + data:
      expect(html).toContain("default-src 'none'");
      expect(html).toContain('script-src vscode-webview://test');
      expect(html).toContain('img-src vscode-webview://test data:');

      // Nonce is 32 chars and the same value lands in both CSP and <script nonce>.
      const m = html.match(/nonce-([A-Za-z0-9]{32})/);
      expect(m).not.toBeNull();
      expect(html).toContain(`nonce="${m![1]}"`);

      // Bundled asset URIs (the promo is canvas-drawn by main.js — no image asset).
      expect(html).toContain('media/support/main.js');
      expect(html).toContain('media/support/main.css');

      // No unsubstituted placeholders remain.
      expect(html).not.toContain('__CSP__');
      expect(html).not.toContain('__NONCE__');
      expect(html).not.toContain('__SCRIPT_URI__');
    });

    it('enables scripts and scopes localResourceRoots to media/support', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();

      provider.resolveWebviewView(view as any, {} as any, {} as any);

      const opts = view.webview.options as { enableScripts: boolean; localResourceRoots: Array<{ path: string }> };
      expect(opts.enableScripts).toBe(true);
      const roots = opts.localResourceRoots.map((u) => u.path);
      expect(roots.some((p) => p.includes('media/support'))).toBe(true);
    });
  });

  describe('handleMessage — action buttons', () => {
    const cases: Array<[string, string]> = [
      ['reportIssue', 'sshLite.reportIssue'],
      ['donate', 'sshLite.donate'],
      ['starGithub', 'sshLite.starGithub'],
      ['rateMarketplace', 'sshLite.rateMarketplace'],
      ['shareExtension', 'sshLite.shareExtension'],
    ];

    it.each(cases)('action "%s" runs command %s', (cmd, expected) => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      view._fireMessage({ type: 'action', cmd });

      expect(commands.executeCommand).toHaveBeenCalledWith(expected);
    });

    it('ignores an unknown action cmd (no command, no external open)', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      view._fireMessage({ type: 'action', cmd: 'sudo rm -rf /' });

      expect(commands.executeCommand).not.toHaveBeenCalled();
      expect(env.openExternal).not.toHaveBeenCalled();
      expect(infoLog).toHaveBeenCalledWith('support-view', 'action-unknown', { cmd: 'sudo rm -rf /' });
    });
  });

  describe('handleMessage — webviewError', () => {
    it('forwards a webview error to infoLog with a truncated stack', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      (infoLog as jest.Mock).mockClear();
      view._fireMessage({ type: 'webviewError', message: 'boom', stack: 'at foo:1' });

      expect(infoLog).toHaveBeenCalledWith('support-view', 'webview-error', {
        message: 'boom',
        stack: 'at foo:1',
      });
    });
  });

  describe('handleMessage — log bridge', () => {
    it('forwards an info log to infoLog', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      (infoLog as jest.Mock).mockClear();
      view._fireMessage({ type: 'log', level: 'info', scope: 'support-webview', event: 'ready' });

      expect(infoLog).toHaveBeenCalledWith('support-webview', 'ready', undefined);
    });

    it('forwards a diag log to diagLog', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      (diagLog as jest.Mock).mockClear();
      view._fireMessage({ type: 'log', level: 'diag', scope: 'support-webview', event: 'tick', payload: { n: 1 } });

      expect(diagLog).toHaveBeenCalledWith('support-webview', 'tick', { n: 1 });
    });
  });

  describe('notifyTyped — activity pulse', () => {
    it('shows the user name for a keystroke-shaped editor edit (isUserInput)', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('editor', undefined, true);

      expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'typed', src: 'editor', user: 'You' });
    });

    it('does NOT show the user name for a non-keystroke editor change (e.g. Claude/formatter edit)', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('editor', 'a whole block Claude wrote', false);

      expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'typed', src: 'editor' });
    });

    it('does NOT show the user name for an editor edit while an AI tool is active', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      provider.notifyAiActive('claude-code', 'Claude Code'); // AI just became active
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('editor', 'x', true); // even a keystroke-shaped change

      expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'typed', src: 'editor' });
    });

    it('terminal input is always attributed to the local user', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('terminal-in');

      expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'typed', src: 'terminal-in', user: 'You' });
    });

    it('forwards the actual inserted text (bounded) so the coder flies real keys', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('editor', 'h', true);

      expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'typed', src: 'editor', user: 'You', text: 'h' });
    });

    it('bounds the forwarded text (a big paste is truncated)', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyTyped('editor', 'x'.repeat(500), true);

      const msg = (view.webview.postMessage as jest.Mock).mock.calls[0][0];
      expect(msg.text.length).toBe(24);
    });

    it('throttles server output (terminal-out) harder than editor typing', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      provider.notifyTyped('terminal-out');
      now += 60; // within the 150ms terminal-out gap
      provider.notifyTyped('terminal-out');
      expect(view.webview.postMessage).toHaveBeenCalledTimes(1);

      now += 100; // total 160ms → past the gap
      provider.notifyTyped('terminal-out');
      expect(view.webview.postMessage).toHaveBeenCalledTimes(2);

      jest.restoreAllMocks();
    });

    it('is a no-op when the view is collapsed (not visible)', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();
      view.visible = false;

      provider.notifyTyped();

      expect(view.webview.postMessage).not.toHaveBeenCalled();
    });

    it('is a no-op before the view is resolved', () => {
      const provider = makeProvider();
      expect(() => provider.notifyTyped()).not.toThrow();
    });
  });

  describe('notifyAiActive — AI assistant label', () => {
    it('posts {type:"aiActive", id, name} when visible', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyAiActive('claude-code', 'Claude Code');

      expect(view.webview.postMessage).toHaveBeenCalledWith({
        type: 'aiActive',
        id: 'claude-code',
        name: 'Claude Code',
      });
    });

    it('forwards the prompt text when an installed hook provides it', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyAiActive('claude-code', 'Claude Code', 'hello world');

      expect(view.webview.postMessage).toHaveBeenCalledWith({
        type: 'aiActive',
        id: 'claude-code',
        name: 'Claude Code',
        prompt: 'hello world',
      });
    });

    it('is a no-op when not visible', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      view.visible = false;
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.notifyAiActive('codex', 'Codex');

      expect(view.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage — setSetting (settings panel)', () => {
    it('updates an allow-listed setting (npcAiActivity) globally', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      const update = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(workspace, 'getConfiguration').mockReturnValue({
        get: <T>(_k: string, d?: T) => d,
        update,
        has: () => false,
        inspect: () => undefined,
      } as any);

      view._fireMessage({ type: 'setSetting', key: 'npcAiActivity', value: false });

      expect(update).toHaveBeenCalledWith('npcAiActivity', false, ConfigurationTarget.Global);
      jest.restoreAllMocks();
    });

    it('ignores a key that is not on the allow-list', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      const update = jest.fn();
      jest.spyOn(workspace, 'getConfiguration').mockReturnValue({
        get: <T>(_k: string, d?: T) => d,
        update,
        has: () => false,
        inspect: () => undefined,
      } as any);

      view._fireMessage({ type: 'setSetting', key: 'someEvilKey', value: true });

      expect(update).not.toHaveBeenCalled();
      expect(infoLog).toHaveBeenCalledWith('support-view', 'set-setting-unknown', { key: 'someEvilKey' });
      jest.restoreAllMocks();
    });
  });

  describe('handleMessage — ready handshake', () => {
    it('echoes current settings and hook status', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.setHookController({
        status: () => [{ id: 'claude-code', name: 'Claude Code', present: true, installed: false }],
        installAll: () => [],
        uninstallAll: () => [],
      });
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      jest.spyOn(workspace, 'getConfiguration').mockReturnValue({
        get: <T>(_k: string, d?: T) => d, // settings default to their fallback
        update: jest.fn(),
        has: () => false,
        inspect: () => undefined,
      } as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      view._fireMessage({ type: 'ready' });

      expect(view.webview.postMessage).toHaveBeenCalledWith({
        type: 'settings',
        npcAiActivity: true,
        npcCrossWindowBeacon: true,
      });
      expect(view.webview.postMessage).toHaveBeenCalledWith({
        type: 'hookStatus',
        tools: [{ id: 'claude-code', name: 'Claude Code', present: true, installed: false }],
        message: undefined,
      });
      jest.restoreAllMocks();
    });
  });

  describe('handleMessage — installHooks / uninstallHooks', () => {
    it('installs via the controller and posts an updated hook status', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      const installAll = jest.fn(() => [{ id: 'claude-code', ok: true }]);
      provider.setHookController({
        status: () => [{ id: 'claude-code', name: 'Claude Code', present: true, installed: true }],
        installAll,
        uninstallAll: () => [],
      });
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      view._fireMessage({ type: 'installHooks' });

      expect(installAll).toHaveBeenCalled();
      expect(view.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'hookStatus', message: 'Installed hooks for 1 tool(s).' })
      );
    });

    it('does nothing without a hook controller', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      expect(() => view._fireMessage({ type: 'installHooks' })).not.toThrow();
      expect(view.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('postSettings', () => {
    it('posts {type:"settings", ...} to the webview', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      (view.webview.postMessage as jest.Mock).mockClear();

      provider.postSettings({ npcAiActivity: false, npcCrossWindowBeacon: true });

      expect(view.webview.postMessage).toHaveBeenCalledWith({
        type: 'settings',
        npcAiActivity: false,
        npcCrossWindowBeacon: true,
      });
    });
  });

  describe('onDidChangeVisible', () => {
    it('fires with the initial visibility on resolve', () => {
      const provider = makeProvider();
      const view = createMockWebviewView();
      const seen: boolean[] = [];
      provider.onDidChangeVisible((v) => seen.push(v));

      provider.resolveWebviewView(view as any, {} as any, {} as any);

      expect(seen).toContain(true);
    });
  });
});
