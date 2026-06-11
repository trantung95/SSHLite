/**
 * ConnectionImportPanel tests (issue #11 follow-up — two-column import review).
 * Two columns (Current vs From file) split by a vertical divider; conflicts
 * sort to the top; conflicts get a radio per side (default file), new rows get
 * a locked/dimmed file radio. Driven via the createWebviewPanel mock.
 */

import * as vscode from 'vscode';
import { ConnectionImportPanel, ImportDiffRow } from './ConnectionImportPanel';

const NEW_ROW: ImportDiffRow = {
  id: '2.2.2.2:22:b',
  incoming: { name: 'Alpha', detail: 'b@2.2.2.2:22', credentialCount: 0, pinnedCount: 0 },
};
const CONFLICT_ROW: ImportDiffRow = {
  id: '1.1.1.1:22:a',
  incoming: { name: 'Zeta', detail: 'a@1.1.1.1:22', keyPath: '~/.ssh/new', credentialCount: 2, pinnedCount: 1 },
  current: { name: 'Zeta', detail: 'a@1.1.1.1:22', keyPath: '~/.ssh/old', credentialCount: 1, pinnedCount: 0 },
};
const rows = [NEW_ROW, CONFLICT_ROW]; // intentionally unsorted
const lastPanel = () => (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value;
const html = () => lastPanel().webview.html as string;

describe('ConnectionImportPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('labels the two columns (current extension vs the import file) with a divider', () => {
    const p = ConnectionImportPanel.pick(rows, { title: 'Review import', sourceLabel: 'myfile.json' });
    expect(html()).toContain('Current (this extension)');
    expect(html()).toContain('From file: myfile.json');
    expect(html()).toContain('vline'); // vertical divider element
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('orders the toolbar to match the columns (Keep current left, Use file right)', () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    const h = html();
    expect(h.indexOf('Keep all current')).toBeLessThan(h.indexOf('Use all from file'));
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('wires a light highlight onto the selected side', () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    const h = html();
    expect(h).toContain('.side.sel'); // CSS for the selected-side highlight
    expect(h).toContain('classList.toggle'); // runtime sync of the highlight
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('sorts conflicts above non-conflicts (Zeta conflict before Alpha new)', () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    expect(html().indexOf('Zeta')).toBeLessThan(html().indexOf('Alpha'));
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('gives a conflict a radio on each side (default = file) and a new row a locked, checked file radio', () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    const h = html();
    expect(h).toContain('data-side="local"'); // conflict can choose current
    expect(h).toContain('data-side="file"');
    expect(h).toContain('checked'); // file side default-selected (stays filled, not greyed)
    expect(h).toContain('class="locked"'); // the new row's radio is locked on (not disabled)
    expect(h).not.toContain('disabled'); // must render as selected, never a greyed disabled control
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('highlights a changed field on the importing side', () => {
    const p = ConnectionImportPanel.pick([CONFLICT_ROW], { title: 't', sourceLabel: 'f' });
    expect(html()).toContain('chg'); // key path differs (~/.ssh/old -> ~/.ssh/new)
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });

  it('resolves with the selected ids on import', async () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    lastPanel()._fireMessage({ type: 'import', selectedIds: ['2.2.2.2:22:b'] });
    expect(await p).toEqual(['2.2.2.2:22:b']);
  });

  it('resolves undefined on cancel', async () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    lastPanel()._fireMessage({ type: 'cancel' });
    expect(await p).toBeUndefined();
  });

  it('resolves undefined when the panel is closed', async () => {
    const p = ConnectionImportPanel.pick(rows, { title: 't', sourceLabel: 'f' });
    lastPanel()._fireDispose();
    expect(await p).toBeUndefined();
  });

  it('escapes HTML in connection names and the source label (no injection)', () => {
    const p = ConnectionImportPanel.pick(
      [{ id: 'x', incoming: { name: '<img src=x onerror=alert(1)>', detail: 'd', credentialCount: 0, pinnedCount: 0 } }],
      { title: 't', sourceLabel: '<b>evil</b>' }
    );
    const h = html();
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img');
    expect(h).not.toContain('<b>evil</b>');
    lastPanel()._fireMessage({ type: 'cancel' });
    return p;
  });
});
