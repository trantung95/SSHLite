import * as vscode from 'vscode';
import { infoLog, diagLog } from '../utils/diagnosticLog';
import { DONATE, DonateChain } from '../donate/donateInfo';

/**
 * DonatePanel: a "Send me a Banh Mi" easter-egg webview, opened by
 * `sshLite.donate`. It plays a short pixel-emoji cooking animation (styled after
 * CleanBinAndObj's SendMeABanhMi) and then reveals SSH Lite's real donate info
 * (QR codes, addresses, and Copy buttons).
 *
 * All donate content comes from the single source of truth
 * `donate/donateInfo.ts` (the same data the README mirrors, kept in sync by
 * `donateInfo.test.ts`).
 *
 * Conventions match the other webviews: locked-down CSP plus a per-load nonce,
 * assets via `asWebviewUri` (the QR PNGs under images/donate/), and a
 * `{type:'log'}` bridge to the one SSH Lite Output channel. Copy buttons post
 * `{type:'copy', id}`; the extension maps the id to an address from the trusted
 * source so the webview can never make it copy arbitrary text.
 */
export class DonatePanel {
  public static readonly viewType = 'sshLiteDonate';
  private static instance: DonatePanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly extensionUri: vscode.Uri) {}

  public static show(extensionUri: vscode.Uri): void {
    if (!DonatePanel.instance) {
      DonatePanel.instance = new DonatePanel(extensionUri);
    }
    DonatePanel.instance.reveal();
  }

  private reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    infoLog('donate-panel', 'open', {});
    this.panel = vscode.window.createWebviewPanel(
      DonatePanel.viewType,
      '\u{1F956} Bánh Mì',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'images', 'donate')],
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m), undefined, this.disposables);
    this.panel.onDidDispose(
      () => {
        infoLog('donate-panel', 'dispose', {});
        this.panel = undefined;
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
        // Clear the singleton so a later show() builds a fresh instance
        // (mirrors SearchPanel). Without this, reopening creates a panel on a
        // torn-down instance.
        DonatePanel.instance = undefined;
      },
      undefined,
      this.disposables
    );
  }

  private async handleMessage(message: { type?: unknown; id?: unknown; level?: unknown; scope?: unknown; event?: unknown; payload?: unknown }): Promise<void> {
    diagLog('donate-panel', 'recv', { type: typeof message?.type === 'string' ? message.type : 'unknown' });
    switch (message.type) {
      case 'copy': {
        const id = typeof message.id === 'string' ? message.id : '';
        // Map the id to an address from the trusted source. A garbled / spoofed
        // id is rejected, so the webview can never copy arbitrary text.
        const chain = DONATE.chains.find((c) => c.id === id);
        if (!chain) {
          infoLog('donate-panel', 'copy-rejected', { id });
          return;
        }
        infoLog('donate-panel', 'copy', { id: chain.id });
        await vscode.env.clipboard.writeText(chain.address);
        vscode.window.showInformationMessage(`${chain.network} address copied. Thank you for keeping SSH Lite independent! \u{1F956}`);
        break;
      }
      case 'log': {
        const level = message.level === 'diag' ? 'diag' : 'info';
        const scope = typeof message.scope === 'string' ? message.scope : 'donate-webview';
        const event = typeof message.event === 'string' ? message.event : 'unknown';
        const payload = message.payload && typeof message.payload === 'object' ? (message.payload as Record<string, unknown>) : undefined;
        if (level === 'info') {
          infoLog(scope, event, payload);
        } else {
          diagLog(scope, event, payload);
        }
        break;
      }
      default:
        break;
    }
  }

  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  private static esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private chainCard(webview: vscode.Webview, c: DonateChain): string {
    const qr = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'images', 'donate', c.qrFile)).toString();
    const E = DonatePanel.esc;
    return [
      '<div class="card">',
      `  <img class="qr" src="${E(qr)}" alt="${E(c.network)} QR" width="150" height="150">`,
      `  <div class="coins">${E(c.coins)}</div>`,
      `  <div class="chain">via ${E(c.chain)}</div>`,
      `  <div class="note">${E(c.note)}</div>`,
      `  <code class="addr">${E(c.address)}</code>`,
      `  <button class="copy-btn" data-id="${E(c.id)}">Copy address</button>`,
      '</div>',
    ].join('\n');
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = DonatePanel.makeNonce();
    const cspSource = webview.cspSource;
    const E = DonatePanel.esc;

    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource}`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');

    const cards = DONATE.chains.map((c) => this.chainCard(webview, c)).join('\n');
    const tips = DONATE.tips.map((t) => `<p class="tip">${E(t)}</p>`).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Bánh Mì</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
         color: var(--vscode-editor-foreground); margin: 0; min-height: 100vh; display: flex;
         flex-direction: column; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .wrap { max-width: 560px; width: 100%; text-align: center; }
  h1 { margin: 0 0 4px; font-size: 2rem; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
  .cooking { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .step-icon { font-size: 3rem; animation: bounce 0.5s ease infinite; }
  .step-vn { font-size: 1.1rem; font-weight: 600; }
  .step-en { font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
  .bar { width: 80%; max-width: 360px; height: 10px; border-radius: 5px;
         background: var(--vscode-input-background); overflow: hidden; margin-top: 8px; }
  .fill { height: 100%; width: 0%; transition: width 0.4s ease;
          background: linear-gradient(90deg, #ff6b6b, #feca57, #48dbfb, #1dd1a1); }
  .art { font-family: monospace; line-height: 1.15; margin: 10px 0; opacity: 0; transform: scale(0.85);
         transition: all 0.5s ease; }
  .art.show { opacity: 1; transform: scale(1); }
  .reveal { opacity: 0; transform: translateY(18px); transition: all 0.5s ease; }
  .reveal.show { opacity: 1; transform: translateY(0); }
  .celebrate { font-size: 2rem; animation: celebrate 0.5s ease infinite; }
  .flag { display: inline-block; animation: wave 1s ease-in-out infinite; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; margin: 16px 0; }
  .card { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-input-border, transparent);
          border-radius: 8px; padding: 12px; width: 220px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .qr { image-rendering: pixelated; background: #fff; border-radius: 4px; }
  .coins { font-weight: 700; }
  .chain { font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
  .note { font-size: 0.75rem; color: var(--vscode-descriptionForeground); }
  .addr { font-size: 0.7rem; word-break: break-all; background: var(--vscode-input-background);
          padding: 4px 6px; border-radius: 4px; }
  .copy-btn { cursor: pointer; border: 0; border-radius: 4px; padding: 6px 10px; font-family: inherit;
              background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .copy-btn:hover { background: var(--vscode-button-hoverBackground); }
  .tip { font-size: 0.8rem; color: var(--vscode-descriptionForeground); margin: 4px 0; }
  .footer { margin-top: 16px; color: var(--vscode-descriptionForeground); }
  @keyframes bounce { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-10px);} }
  @keyframes celebrate { 0%,100% { transform: scale(1) rotate(0);} 25% { transform: scale(1.1) rotate(-6deg);} 75% { transform: scale(1.1) rotate(6deg);} }
  @keyframes wave { 0%,100% { transform: rotate(-8deg);} 50% { transform: rotate(8deg);} }
  @media (prefers-reduced-motion: reduce) { .step-icon,.celebrate,.flag { animation: none; } .art,.reveal { transition: none; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>\u{1F956} ${E(DONATE.title)}</h1>
  <p class="subtitle">${E(DONATE.subtitle)}</p>

  <div class="cooking" id="cooking">
    <div class="step-icon" id="icon">\u{1F6D2}</div>
    <div class="step-vn" id="vn">Đi chợ...</div>
    <div class="step-en" id="en">Going to market...</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
  </div>

  <div class="art" id="art">
    <div>\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}</div>
    <div>+-------------+</div>
    <div>| \u{1F969}\u{1F952}\u{1F955}\u{1F33F}\u{1F9C8} |</div>
    <div>+-------------+</div>
    <div>\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}\u{1F956}</div>
  </div>

  <div class="reveal" id="reveal">
    <div class="celebrate" id="celebrate">\u{1F389}</div>
    <h2>Your Bánh Mì is ready! <span class="flag">\u{1F1FB}\u{1F1F3}</span></h2>
    <div class="cards">
${cards}
    </div>
${tips}
    <p class="footer">\u{1FAB7} ${E(DONATE.footer)}</p>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  try { vscode.postMessage({ type: 'log', level: 'info', scope: 'donate-webview', event: 'ready' }); } catch (e) {}

  var steps = [
    { icon: '\u{1F6D2}', vn: 'Đi chợ...', en: 'Going to market...' },
    { icon: '\u{1F956}', vn: 'Mua bánh mì giòn...', en: 'Buying crispy baguette...' },
    { icon: '\u{1F969}', vn: 'Chọn thịt ngon...', en: 'Selecting good meat...' },
    { icon: '\u{1F525}', vn: 'Nướng thịt...', en: 'Grilling the pork...' },
    { icon: '\u{1F952}', vn: 'Cắt dưa chuột...', en: 'Slicing cucumber...' },
    { icon: '\u{1F955}', vn: 'Thêm đồ chua...', en: 'Adding pickled carrots...' },
    { icon: '\u{1F33F}', vn: 'Rắc rau thơm...', en: 'Sprinkling fresh herbs...' },
    { icon: '\u{1F336}', vn: 'Thêm ớt...', en: 'Adding chili...' },
    { icon: '\u{1F9C8}', vn: 'Phết pa-tê...', en: 'Spreading pate...' },
    { icon: '\u{1FAD7}', vn: 'Xịt nước tương...', en: 'Drizzling soy sauce...' },
    { icon: '✨', vn: 'Hoàn thành!', en: 'Complete!' }
  ];
  var celebrateEmojis = ['\u{1F389}', '\u{1F38A}', '\u{1F973}', '\u{1F1FB}\u{1F1F3}', '\u{1F956}', '\u{1F35C}', '☕'];
  var i = 0;
  var icon = document.getElementById('icon');
  var vn = document.getElementById('vn');
  var en = document.getElementById('en');
  var fill = document.getElementById('fill');

  function step() {
    if (i < steps.length) {
      var s = steps[i];
      icon.textContent = s.icon; vn.textContent = s.vn; en.textContent = s.en;
      fill.style.width = ((i + 1) / steps.length * 100) + '%';
      i++;
      setTimeout(step, 600);
    } else {
      setTimeout(function () {
        document.getElementById('cooking').style.display = 'none';
        document.getElementById('art').classList.add('show');
        setTimeout(function () {
          document.getElementById('reveal').classList.add('show');
          var c = document.getElementById('celebrate');
          var j = 0;
          setInterval(function () { c.textContent = celebrateEmojis[j]; j = (j + 1) % celebrateEmojis.length; }, 420);
        }, 450);
      }, 300);
    }
  }
  setTimeout(step, 400);

  var btns = document.querySelectorAll('.copy-btn');
  for (var b = 0; b < btns.length; b++) {
    btns[b].addEventListener('click', function (ev) {
      var el = ev.currentTarget;
      vscode.postMessage({ type: 'copy', id: el.getAttribute('data-id') });
      var old = el.textContent; el.textContent = 'Copied! \u{1F956}';
      setTimeout(function () { el.textContent = old; }, 1500);
    });
  }
})();
</script>
</body>
</html>`;
  }
}
