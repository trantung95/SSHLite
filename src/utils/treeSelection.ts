/**
 * Tree-selection argument resolution (issue #10).
 *
 * VS Code passes tree-item arguments only for context-menu invocations:
 * - context menu on one item:      (item, undefined)
 * - context menu with multi-select: (item, items[])
 * - keybinding / command palette:   (undefined, undefined)
 *
 * For the keybinding case the command must fall back to the TreeView's
 * current selection, otherwise hotkeys like Ctrl/Cmd+C silently do nothing
 * ("SSH clipboard is empty" follow-up on issue #10).
 */

/**
 * Resolve the effective target items of a tree command.
 * Priority: explicit multi-select args > explicit single arg > tree selection.
 */
export function resolveTreeSelection<T>(
  item: T | undefined,
  items: readonly T[] | undefined,
  selection: readonly T[] | undefined
): T[] {
  if (items && items.length > 0) {
    return [...items];
  }
  if (item) {
    return [item];
  }
  return selection ? [...selection] : [];
}
