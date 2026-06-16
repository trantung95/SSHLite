/**
 * Tree expand/collapse helpers.
 *
 * The "Expand All" toolbar button drove `list.expandRecursively`, a built-in
 * workbench command that only exists in VS Code 1.94+. This extension's
 * `engines.vscode` floor is 1.85, so on older hosts the command rejects with
 * `command 'list.expandRecursively' not found` (issue #16). These helpers run
 * the native command when present and degrade to a first-level expand (using
 * `TreeView.reveal`, available since 1.40) otherwise — so the button never
 * throws regardless of VS Code version.
 *
 * Kept as a pure module (no direct `vscode` import) so the fallback logic is
 * unit-testable without the full extension host.
 */

/** Minimal shape of a tree view we need to expand its top-level items. */
export interface ExpandableTreeView {
  view:
    | {
        reveal(
          item: unknown,
          options?: { expand?: boolean | number; select?: boolean; focus?: boolean },
        ): Thenable<void>;
      }
    | undefined;
  provider: { getChildren(element?: unknown): unknown };
}

/**
 * Expand only the top-level items of each view by revealing them one level deep.
 * Every step is defensive: a missing view, a throwing provider, or an
 * unrevealable item is skipped rather than aborting the whole operation.
 */
export async function expandFirstLevelInViews(views: ExpandableTreeView[]): Promise<void> {
  for (const { view, provider } of views) {
    if (!view) {
      continue; // tree view may have failed to register (see safeStep at activate)
    }
    try {
      const topItems = await Promise.resolve(provider.getChildren());
      if (Array.isArray(topItems)) {
        for (const item of topItems) {
          try {
            await view.reveal(item, { expand: 1, select: false, focus: false });
          } catch {
            /* item may not be revealable */
          }
        }
      }
    } catch {
      /* provider may fail */
    }
  }
}

/**
 * Expand all nodes recursively. Prefers the native `list.expandRecursively`
 * (VS Code 1.94+) and falls back to a first-level expand on older versions
 * where that command does not exist (issue #16).
 */
export async function expandAllInViews(
  executeCommand: (command: string) => Thenable<unknown>,
  views: ExpandableTreeView[],
): Promise<void> {
  try {
    await executeCommand('list.expandRecursively');
  } catch (err) {
    // Only fall back for the "command not found" case (VS Code < 1.94). A
    // mid-run failure on a version that HAS the command already expanded part
    // of the tree, so a first-level fallback would double-expand — swallow it.
    const message = (err as Error)?.message || '';
    if (/not found/i.test(message)) {
      await expandFirstLevelInViews(views);
    }
  }
}
