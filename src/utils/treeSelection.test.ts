/**
 * Issue #10 regression tests — tree command argument resolution.
 *
 * Bug: keybinding invocations (Ctrl/Cmd+C, Ctrl/Cmd+X, Ctrl/Cmd+V, F2) pass
 * NO tree-item argument, so copy/cut silently did nothing and paste then
 * reported "SSH clipboard is empty". The handlers must fall back to the
 * TreeView's current selection.
 */

import { resolveTreeSelection } from './treeSelection';

describe('resolveTreeSelection (issue #10)', () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  const c = { name: 'c' };

  it('prefers the explicit multi-select args (context menu, multi-select)', () => {
    expect(resolveTreeSelection(a, [b, c], [a])).toEqual([b, c]);
  });

  it('uses the single item arg when no multi-select args (context menu, single item)', () => {
    expect(resolveTreeSelection(a, undefined, [b, c])).toEqual([a]);
    expect(resolveTreeSelection(a, [], [b, c])).toEqual([a]);
  });

  it('falls back to the tree selection when no args (keybinding — the issue #10 bug)', () => {
    expect(resolveTreeSelection(undefined, undefined, [b, c])).toEqual([b, c]);
  });

  it('returns empty when nothing is available', () => {
    expect(resolveTreeSelection(undefined, undefined, undefined)).toEqual([]);
    expect(resolveTreeSelection(undefined, undefined, [])).toEqual([]);
  });

  it('returns a mutable copy, never the original readonly arrays', () => {
    const selection = [a, b];
    const result = resolveTreeSelection(undefined, undefined, selection);
    expect(result).toEqual(selection);
    expect(result).not.toBe(selection);

    const items = [b, c];
    const fromItems = resolveTreeSelection(a, items, selection);
    expect(fromItems).not.toBe(items);
  });
});
