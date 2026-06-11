import * as vscode from 'vscode';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * One side (Current or Importing) of a connection in the diff view.
 */
export interface ImportSide {
  name: string;
  /** `username@host:port`. */
  detail: string;
  keyPath?: string;
  credentialCount: number;
  pinnedCount: number;
}

/**
 * A connection row in the import review (issue #11 follow-up). Shown as a
 * two-column row: `current` (left, what the extension has now) vs `incoming`
 * (right, from the import file). `current` is undefined for a brand-new
 * connection.
 */
export interface ImportDiffRow {
  /** Stable id: host:port:username. */
  id: string;
  incoming: ImportSide;
  current?: ImportSide;
}

interface ImportMessage {
  type?: string;
  selectedIds?: unknown;
  level?: string;
  scope?: string;
  event?: string;
  payload?: unknown;
  message?: string;
  stack?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Webview panel that reviews an import as a two-column "Current (this extension)"
 * vs "From <file>" table, split by a vertical divider. Conflicting connections
 * sort to the top (alphabetical) and get a radio per side (default: import from
 * file); non-conflicting connections show a single, always-on, dimmed radio.
 * Resolves with the connection ids the user chose to import from the file, or
 * undefined if cancelled / closed.
 */
export class ConnectionImportPanel {
  static readonly viewType = 'sshLiteConnectionImport';

  static pick(rows: ImportDiffRow[], opts: { title: string; sourceLabel: string }): Promise<string[] | undefined> {
    // Conflicts first, then new — each group sorted alphabetically by name.
    const sorted = rows.slice().sort((a, b) => {
      const ca = a.current ? 0 : 1;
      const cb = b.current ? 0 : 1;
      if (ca !== cb) {
        return ca - cb;
      }
      return a.incoming.name.toLowerCase().localeCompare(b.incoming.name.toLowerCase());
    });

    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        ConnectionImportPanel.viewType,
        'Import Connections',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: false }
      );

      let settled = false;
      const finish = (value: string[] | undefined): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
        try {
          panel.dispose();
        } catch {
          // already disposed
        }
      };

      panel.webview.onDidReceiveMessage((raw: ImportMessage) => {
        switch (raw?.type) {
          case 'import': {
            const ids = Array.isArray(raw.selectedIds)
              ? (raw.selectedIds as unknown[]).filter((x): x is string => typeof x === 'string')
              : [];
            infoLog('connection-import-panel', 'import', { count: ids.length });
            finish(ids);
            break;
          }
          case 'cancel': {
            infoLog('connection-import-panel', 'cancel', {});
            finish(undefined);
            break;
          }
          case 'log': {
            const scope = typeof raw.scope === 'string' ? raw.scope : 'connection-import-webview';
            const event = typeof raw.event === 'string' ? raw.event : 'unknown';
            const payload =
              raw.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : undefined;
            if (raw.level === 'diag') {
              diagLog(scope, event, payload);
            } else {
              infoLog(scope, event, payload);
            }
            break;
          }
          case 'webviewError': {
            infoLog('connection-import-webview', 'error', {
              message: typeof raw.message === 'string' ? raw.message : 'unknown',
              stack: typeof raw.stack === 'string' ? raw.stack : undefined,
            });
            break;
          }
          default:
            break;
        }
      });

      panel.onDidDispose(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      });

      panel.webview.html = ConnectionImportPanel.getHtml(panel.webview, sorted, opts);
      infoLog('connection-import-panel', 'open', {
        rows: sorted.length,
        conflicts: sorted.filter((r) => r.current).length,
      });
    });
  }

  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  /** Render one side's inner content; `other` (the opposite side) drives change highlighting. */
  private static sideHtml(side: ImportSide, other: ImportSide | undefined, kind: 'current' | 'incoming'): string {
    const chg = (a: unknown, b: unknown): string => (other && a !== b && kind === 'incoming' ? ' chg' : '');
    const lines: string[] = [];
    lines.push(`<div class="name${chg(side.name, other?.name)}">${escapeHtml(side.name)}</div>`);
    lines.push(`<div class="f${chg(side.detail, other?.detail)}">${escapeHtml(side.detail)}</div>`);
    if (side.keyPath) {
      lines.push(`<div class="f mono${chg(side.keyPath, other?.keyPath)}">🔑 ${escapeHtml(side.keyPath)}</div>`);
    }
    const chips: string[] = [];
    if (side.credentialCount > 0) {
      chips.push(`<span class="chip${chg(side.credentialCount, other?.credentialCount)}">${side.credentialCount} credential${side.credentialCount > 1 ? 's' : ''}</span>`);
    }
    if (side.pinnedCount > 0) {
      chips.push(`<span class="chip${chg(side.pinnedCount, other?.pinnedCount)}">${side.pinnedCount} pinned</span>`);
    }
    if (chips.length) {
      lines.push(`<div class="chips">${chips.join('')}</div>`);
    }
    return `<div class="content">${lines.join('')}</div>`;
  }

  private static getHtml(webview: vscode.Webview, rows: ImportDiffRow[], opts: { title: string; sourceLabel: string }): string {
    const nonce = ConnectionImportPanel.makeNonce();
    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource}`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');

    const conflicts = rows.filter((r) => r.current).length;

    // Each row is two equal halves split by the divider; the radio sits at the
    // START of its own half so header + radio + content all line up per side.
    const rowsHtml = rows
      .map((r, i) => {
        const isConflict = !!r.current;
        const id = escapeHtml(r.id);
        const currentSide = isConflict
          ? `<label for="r${i}l" class="side current"><span class="radio"><input type="radio" id="r${i}l" name="row${i}" data-side="local" data-id="${id}" /></span>${ConnectionImportPanel.sideHtml(r.current as ImportSide, r.incoming, 'current')}</label>`
          : `<div class="side current empty">Not currently saved</div>`;
        // File side is the default choice. New connections have a single (locked)
        // radio that stays checked — a lone radio can't be unticked.
        const fileSide = `<label for="r${i}f" class="side incoming"><span class="radio"><input type="radio" id="r${i}f" name="row${i}" data-side="file" data-id="${id}" checked${isConflict ? '' : ' class="locked"'} /></span>${ConnectionImportPanel.sideHtml(r.incoming, r.current, 'incoming')}</label>`;
        return `<div class="trow${isConflict ? ' is-conflict' : ''}">${currentSide}<div class="vline"></div>${fileSide}</div>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; }
  .wrap { display: flex; flex-direction: column; height: 100vh; }
  header { padding: 16px 20px 8px; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .summary { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; }
  .toolbar .spacer { flex: 1; }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
  button { font-family: inherit; font-size: 0.85rem; border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; }
  .link-btn { background: transparent; color: var(--vscode-textLink-foreground); padding: 4px 6px; }
  .link-btn:hover { text-decoration: underline; }
  .scroll { flex: 1; overflow: auto; }
  .thead { display: flex; position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25)); }
  .thead .h { flex: 1; padding: 8px 16px; color: var(--vscode-descriptionForeground); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .vline { width: 1px; flex: none; background: var(--vscode-panel-border, var(--vscode-input-border, #555)); }
  .trow { display: flex; align-items: stretch; }
  .side { flex: 1; display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--vscode-input-border, rgba(128,128,128,0.18)); cursor: pointer; min-width: 0; }
  .side.sel { background: var(--vscode-list-inactiveSelectionBackground, rgba(120,170,255,0.10)); }
  .side:hover { background: var(--vscode-list-hoverBackground); }
  .side.empty { color: var(--vscode-descriptionForeground); font-style: italic; align-items: center; cursor: default; }
  .side.empty:hover { background: none; }
  .radio { display: flex; align-items: center; padding-top: 1px; }
  .radio input { width: 16px; height: 16px; cursor: pointer; }
  .radio input.locked { cursor: default; }
  .content { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .name { font-weight: 600; }
  .f { font-size: 0.82rem; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .chg { background: var(--vscode-diffEditor-insertedTextBackground, rgba(155,185,85,0.25)); border-radius: 3px; padding: 0 3px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 1px 8px; font-size: 0.72rem; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--vscode-input-border, transparent); }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(opts.title)}</h1>
      <div class="summary">${rows.length} connection${rows.length === 1 ? '' : 's'} in the file${conflicts ? ` · <strong>${conflicts}</strong> already exist (shown at the top). For each conflict, pick the current or the file version.` : ''}</div>
    </header>
    <div class="toolbar">
      <button class="link-btn" id="none">Keep all current</button>
      <span class="spacer"></span>
      <span class="count" id="count"></span>
      <button class="link-btn" id="all">Use all from file</button>
    </div>
    <div class="scroll">
      <div class="thead">
        <div class="h">Current (this extension)</div>
        <div class="vline"></div>
        <div class="h">From file: ${escapeHtml(opts.sourceLabel)}</div>
      </div>
      ${rowsHtml}
    </div>
    <footer>
      <button class="secondary" id="cancel">Cancel</button>
      <button class="primary" id="import">Import selected</button>
    </footer>
  </div>
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    try { vscode.postMessage({ type: 'log', level: 'info', scope: 'connection-import-webview', event: 'ready', payload: { rows: ${rows.length} } }); } catch (e) {}
    var fileRadios = Array.prototype.slice.call(document.querySelectorAll('input[data-side="file"]'));
    var localRadios = Array.prototype.slice.call(document.querySelectorAll('input[data-side="local"]'));
    var allRadios = Array.prototype.slice.call(document.querySelectorAll('input[type=radio]'));
    var countEl = document.getElementById('count');
    function selectedIds() { return fileRadios.filter(function (r) { return r.checked; }).map(function (r) { return r.getAttribute('data-id'); }); }
    // Light-highlight whichever side is currently selected.
    function syncHighlights() { allRadios.forEach(function (r) { var s = r.closest('.side'); if (s) { s.classList.toggle('sel', r.checked); } }); }
    function refresh() { syncHighlights(); countEl.textContent = selectedIds().length + ' of ' + fileRadios.length + ' will be imported'; }
    allRadios.forEach(function (r) { r.addEventListener('change', refresh); });
    document.getElementById('all').addEventListener('click', function () { fileRadios.forEach(function (r) { r.checked = true; }); refresh(); });
    document.getElementById('none').addEventListener('click', function () { localRadios.forEach(function (r) { r.checked = true; }); refresh(); });
    document.getElementById('cancel').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
    document.getElementById('import').addEventListener('click', function () { vscode.postMessage({ type: 'import', selectedIds: selectedIds() }); });
    window.addEventListener('error', function (e) { try { vscode.postMessage({ type: 'webviewError', message: String(e.message), stack: e.error && e.error.stack }); } catch (x) {} });
    refresh();
  </script>
</body>
</html>`;
  }
}
