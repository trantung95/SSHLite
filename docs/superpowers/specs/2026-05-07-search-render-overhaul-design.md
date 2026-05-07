# Search Webview Render Overhaul Design

**Date:** 2026-05-07
**Status:** Approved
**Target releases:** v0.8.1 (phase 1), v0.8.2 (phase 2), v0.8.3 (phase 3)

## Problem

Cross-server search has been the most-iterated feature in the project: six fix-driven releases (v0.4.4, 0.4.5, 0.4.6, 0.4.7, 0.5.3, 0.7.5). Three concrete user-facing pains remain:

1. **Stutter at high result counts.** Every `searchBatch` from the extension triggers `renderResults()`, which does a full group-by-file sweep over all accumulated results, builds a giant HTML string, and `innerHTML`-replaces the entire results container. With 2000 results (the default `searchMaxResults`), every batch and every expand/collapse rebuilds 2000 rows of HTML and re-parses them.
2. **List ↔ tree toggle feels frozen at high counts.** When the user clicks the list/tree toggle, the alternate view is built from scratch over all results, then `innerHTML`-swapped. There is no warm parallel state.
3. **Renderer is unmaintainable.** `src/webviews/SearchPanel.ts` is 4032 lines; 2535 of those lines are an inline HTML/JS template literal inside `getWebviewContent()`. There is no testable seam for the rendering logic.

## Goals

Apply Beck's "make it work, make it right, make it fast" loop to the search rendering path:

- **Right** — extract the webview renderer into real source files, built by a real bundler, so it can be reasoned about and tested in isolation.
- **Work** — keep list-grouped and tree-grouped state warm in parallel so the view toggle is a DOM remount, not a recomputation; new batches *append* rather than rebuild-the-world.
- **Fast** — virtualize list-view rows so DOM size is bounded by the viewport, not by result count.

## Non-goals

- No change to search semantics, the worker pool, cancellation contract, persistence, server-list UI, redundancy detection, or search options.
- No change to the extension-side `SearchPanel` state machine, message protocol, `performSearch`, throttling, or tab management.
- No change to existing chaos scenarios (search primitives are already covered).
- Tree-view virtualization is explicitly deferred to a future phase 4.

The blast radius is the webview render path inside the search panel, nothing else.

---

## Architecture

### Source layout (new)

```
webview-src/search/
  index.ts          entry: postMessage wiring + bootstrap
  ResultStore.ts    incremental state: list groups + tree, kept in sync per batch
  ListRenderer.ts   list view; uses VirtualList
  TreeRenderer.ts   tree view; incremental DOM updates, expand state
  VirtualList.ts    generic viewport-aware row container (~150 lines)
  dom.ts            small helpers (escapeHtml, createEl, etc.)
  log.ts            postMessage-based logger that routes to the SSH Lite Output channel
  styles.css        all webview CSS, lifted from the template literal
  index.html        skeleton (root container, header slot, results slot)
build/
  build-webview.js  esbuild script (~30 lines): bundles to media/search/{main.js,main.css,index.html}
media/search/       built artifacts (gitignored), shipped in .vsix
```

### Build pipeline

- New devDep: `esbuild`.
- New scripts in `package.json`:
  - `compile:webview` runs `node build/build-webview.js` once.
  - `watch:webview` runs the same with `--watch`.
  - `compile` (existing) gains a pre-step that runs `compile:webview`.
- `vsce package` includes `media/`. `.vscodeignore` is updated to allow `media/`. `.gitignore` excludes `media/` (built artifact).

### Webview load

`SearchPanel.getWebviewContent()` shrinks from 2535 lines to ~30:

1. Read `media/search/index.html` from disk.
2. Rewrite `<script src="…">` and `<link href="…">` URIs through `webview.asWebviewUri(...)`.
3. Inject a per-load nonce.
4. CSP tightens to `default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;`. The `'unsafe-inline'` for styles is kept only for theme-driven `style="…"` attributes already in templates; scripts no longer need it.

### Module boundaries

| Module | What it does | Public surface | Depends on |
|---|---|---|---|
| `SearchPanel.ts` (extension) | Controller — postMessage in/out, no rendering | unchanged externally | unchanged |
| `webview-src/search/index.ts` | Glue — listens for `searchBatch` etc., delegates to `ResultStore`, asks current renderer to apply, forwards renderer logs back to extension | none (entry) | the modules below |
| `ResultStore` | Pure data; maintains list groups and tree in parallel; emits deltas | `append`, `clear`, `snapshot`, `onDelta` | nothing (pure TS) |
| `ListRenderer` | List view: file-grouped, expand/collapse per group, viewport-virtualized rows | `mount`, `applyDelta`, `setExpanded`, `unmount` | `VirtualList`, `ResultStore.snapshot` |
| `TreeRenderer` | Tree view: directory tree, incremental DOM updates, expand state per node | `mount`, `applyDelta`, `setNodeExpanded`, `unmount` | `ResultStore.snapshot` |
| `VirtualList<T>` | Generic; only renders items inside `scrollTop ± buffer` | `setItems`, `appendItems`, `setRowHeight`, `scrollToIndex` | DOM only |

`ResultStore` has no DOM dependency and is testable with vanilla jest. Renderers are DOM-only and test under jsdom. `VirtualList` knows nothing about search and is reusable.

---

## Components & contracts

### `ResultStore`

```ts
type SearchMatch = {
  path: string;
  line?: number;
  match?: string;
  size?: number;
  modified?: number;
  permissions?: string;
  connectionId: string;
  connectionName: string;
};

type FileGroup = {
  key: string;              // connectionId + ':' + path
  path: string;
  connectionId: string;
  connectionName: string;
  matches: SearchMatch[];
  size?: number;
  modified?: number;
};

type TreeNode = {
  name: string;
  children: Map<string, TreeNode>;
  files: FileGroup[];
  depth: number;
};

type Delta = {
  newGroups: FileGroup[];
  growGroups: { key: string; addedMatches: SearchMatch[] }[];
};

class ResultStore {
  append(batch: SearchMatch[]): Delta;
  snapshot(): { groups: FileGroup[]; tree: Map<string, TreeNode> };
  clear(): void;
  onDelta(cb: (d: Delta) => void): { dispose(): void };
}
```

Both list and tree state are updated atomically inside `append`. Cost is O(batch.length), not O(total). Malformed entries (missing `path`, NaN `line`) are filtered at the boundary; `append` is total over its input and never throws.

### `VirtualList<T>`

Fixed row height (CSS variable `--sshlite-row-h`, default 22px). On scroll, `start = floor(scrollTop / rowH) - buffer`, `end = start + viewportRows + 2 * buffer`; render that slice into an absolutely-positioned inner div, set spacer height to `total * rowH`. Scroll handler is throttled via `requestAnimationFrame` (one update per frame).

### `ListRenderer`

Items are flattened into a row array: `[GroupHeaderRow, MatchRow, MatchRow, ..., GroupHeaderRow, ...]`. Expand/collapse rewrites the slice for the affected group; VirtualList re-slices. New batch = append rows for new groups; insert rows under existing groups in their right position.

### `TreeRenderer`

Round one: incremental DOM updates only (no virtualization). New nodes are inserted into existing parents; growing groups append matches under their existing file node. Tree-view virtualization is a phase-4 follow-up.

### Extension side

`SearchPanel.ts` shrinks: `getWebviewContent()` becomes a 30-line HTML loader. The 2535-line template literal is gone. State, postMessage handling, `performSearch`, throttling, tab management — all unchanged.

---

## Data flow

### A `searchBatch` round trip

```
SSHConnection.searchFiles ─┐
                           │  results[]
                           ▼
SearchPanel (extension)  ── postMessage('searchBatch', {results, totalResults, hitLimit, ...}) ──▶
                                                                                                  │
                                                                                                  ▼
                                                              webview index.ts onMessage('searchBatch')
                                                                                                  │
                                                                                                  ▼
                                                              store.append(batch) ──▶ Delta {newGroups, growGroups}
                                                                                                  │
                                                              ┌───────────────────────────────────┘
                                                              ▼
                                                  activeRenderer.applyDelta(delta)
                                                              │
                                                  ┌───────────┴───────────┐
                                                  ▼                       ▼
                                          ListRenderer            TreeRenderer
                                          (flatten + virtualize)  (incremental DOM patch)
```

### View toggle

```
user clicks ☰/tree button
        │
        ▼
index.ts: oldRenderer.unmount() → newRenderer.mount(container)
        │
        ▼
newRenderer reads store.snapshot() — already populated, no recompute
        │
        ▼
DOM remount only — O(visibleRows) for list, O(visibleNodes) for tree
```

Today's path is O(totalResults) regroup + O(totalResults) `innerHTML` build. After: O(viewport) for list, O(visible-tree) for tree. At 2000 results in list view, that is roughly a 50× drop in work per toggle.

### Render coalescing

Multiple `searchBatch` arrivals within 16ms collapse into a single `applyDelta` via `requestAnimationFrame`. Today's 100ms debounce in `renderResults` goes away — rAF gives smoother coalescing without the user-perceptible delay.

### Expand / collapse

Today: full re-render. After: list view rewrites the flat row array (O(group size)) and tells VirtualList to re-slice; tree view toggles `display` on existing children. No HTML rebuild, no `innerHTML` swap.

### Boundary stability

Extension → webview is unchanged: same message names, same payload shapes. Webview → extension gains one new message type (`'log'`, see below), but no existing message changes. The extension-side state machine in `SearchPanel.ts` is untouched. This keeps blast radius surgical and lets phase 1 ship as a pure refactor with byte-equal observable behavior.

---

## Logging

All logs land in the single `SSH Lite` Output channel (created in `extension.ts:144`). One collection point so a user reporting an issue does:

1. Settings → enable `sshLite.diagnosticLogging`.
2. Reproduce the issue.
3. View → Output → select "SSH Lite" → Select All → Copy.

No second channel, no `console.log`, no DevTools-only logging. The webview cannot directly write to the channel, so it posts `{type: 'log', level: 'info' | 'diag', scope, event, payload}` messages back to the extension, which forwards via `infoLog` / `diagLog`.

### Levels

- `infoLog(scope, event, payload)` — always emits. Lifecycle and state-change events: mount, unmount, view switch, errors, batch boundaries.
- `diagLog(scope, event, payload)` — gated on `sshLite.diagnosticLogging`. Hot or per-iteration paths.

`scope` is a stable kebab-case identifier. `event` is a verb-noun. `payload` is a structured object — never a formatted string, never raw user/result text. `fmtData` already truncates string fields to 200 chars.

### Extension-side logs (new)

| Site | Level | Scope / event |
|---|---|---|
| `SearchPanel.show` / `dispose` | infoLog | `'search-panel'` / `'show'`, `'dispose'` |
| `SearchPanel.postMessage` outbound | diagLog | `'search-panel'` / `'post'` (type, sizes only — never raw matches) |
| Webview-error handler | infoLog | `'search-panel'` / `'webview-error'` (message, stack) |
| Webview log forwarder | passthrough | webview-supplied level/scope/event |
| `getWebviewContent` HTML loader | diagLog | `'search-panel'` / `'load-html'` (uri, nonce-len) |

### Webview-side logs (new, routed via forwarder)

| Site | Level | Scope / event |
|---|---|---|
| `index.ts` bootstrap | info | `'search-webview'` / `'ready'` (build-id, dom-ready-ms) |
| `ResultStore.append` | diag | `'result-store'` / `'append'` (batch-size, new-groups, grow-groups, total) |
| `ResultStore.clear` | info | `'result-store'` / `'clear'` |
| `ListRenderer.mount` / `unmount` | info | `'list-renderer'` / `'mount'`, `'unmount'` (snapshot-size) |
| `ListRenderer.applyDelta` | diag | `'list-renderer'` / `'delta'` (rows-added, total-rows, scroll-top) |
| `ListRenderer.setExpanded` | diag | `'list-renderer'` / `'expand'` (key, open) |
| `TreeRenderer.*` | same shape | `'tree-renderer'` |
| `VirtualList` scroll window | diag, **rate-limited ≤4Hz** | `'virtual-list'` / `'window'` (start, end, total) |
| View toggle | info | `'search-webview'` / `'view-switch'` (from, to, total, ms) |
| Render error try/catch | info | `'search-webview'` / `'render-error'` |

CLAUDE.md's "don't log in loops" rule is respected: the only per-iteration logger is `VirtualList` scroll, which is gated *and* rate-limited.

---

## Error handling

A thrown error during `applyDelta` would freeze the panel. Three guards:

- `index.ts` wraps every store/renderer call in try/catch, posts `{type: 'webviewError', message, stack}` to the extension on failure, and shows a single `<div class="render-error">Render error — see Output</div>` overlay.
- Extension side: `SearchPanel.ts` registers a `'webviewError'` handler that pipes through `infoLog('search-panel', 'webview-error', payload)`. No silent swallowing.
- `ResultStore.append` is total over its input; malformed entries are filtered at the boundary. `escapeHtml` is the only path from result text to DOM.

---

## Testing

Three layers.

| Layer | Scope | How |
|---|---|---|
| Unit (jest, no DOM) | `ResultStore` | append/clear/snapshot semantics; delta correctness; tree shape; idempotence on duplicate keys; 10k-row fuzz where random batches → snapshot equals one-shot rebuild. |
| Unit (jest + jsdom) | `VirtualList`, `ListRenderer`, `TreeRenderer` | mount/unmount; viewport math at simulated `scrollTop`; expand/collapse delta; batch-append doesn't disturb scroll. A specific assertion: after mounting 2000 synthetic results, `container.querySelectorAll('.result-row').length` is bounded by `viewportRows + 2 * buffer` (~30) — proves virtualization. |
| Integration (existing) | `SearchPanel.test.ts` | Extension-side state, postMessage contract — must remain green. Phase 1 ships only if these pass byte-equal. |

### Performance benchmark (verify-or-revert gate)

A new headless benchmark in `tests/bench/searchRender.bench.ts` (puppeteer is already a devDep) loads the built webview, drives synthetic batches, and measures:

| Metric | Budget |
|---|---|
| Time-to-first-paint after first batch | < 50ms (current ~150–300ms at 500 results) |
| Time per subsequent batch (rAF-coalesced) | < 8ms at 2000 cumulative results |
| List ↔ tree toggle at 2000 results | < 30ms (current hundreds of ms — the user-reported pain) |
| Expand/collapse a 50-match group | < 5ms |

If a phase-2 or phase-3 PR misses its budget, it does not merge — fix or revert. No "ship and watch."

### Chaos & e2e

No new chaos scenarios needed. The Docker e2e search suite continues to run unchanged; it exercises the extension-side path which is untouched.

---

## Phasing & ship plan

Three phases, each shippable independently. Each phase ends in a release tag.

| Phase | Beck | Scope | Ship gate |
|---|---|---|---|
| **1** | Right | esbuild + lift webview JS/HTML/CSS into `webview-src/search/` → `media/search/`. Add `compile:webview` / `watch:webview` scripts, hook into `compile`. Webview load via `asWebviewUri` + nonce. Logging added: every postMessage in/out, mount, unmount. Zero behavior change. | All 1445 existing tests green (current v0.8.0 baseline); `vsce package` ships; new packaging smoke test passes; manual smoke: search a few hosts, list/tree both work like before. |
| **2** | Work | Introduce `ResultStore` with parallel list+tree. `ListRenderer` and `TreeRenderer` consume deltas. Append-not-rebuild on each batch. View toggle = remount, no recompute. Logging: every `append` (diag), every `view-switch` (info, with ms). | Unit tests for `ResultStore` (10k fuzz). DOM tests for renderers. Bench: list↔tree toggle at 2000 results < 30ms. |
| **3** | Fast | `VirtualList` for list view; rAF coalescing replaces the 100ms debounce. Logging: rate-limited `virtual-list/window` (diag, ≤4Hz). Tree-view virtualization is explicitly deferred to a future phase 4. | Bench: time-per-batch < 8ms at 2000 results; visible row count bounded. |

### Files touched per phase (estimate)

- **Phase 1.** `package.json` (devDep + scripts), new `build/build-webview.js`, new `webview-src/search/*` (~2700 lines moved out of `SearchPanel.ts`), `src/webviews/SearchPanel.ts` (-2535 +~30 lines), `.gitignore` (`media/`), `.vscodeignore` (don't ignore `media/`), `tests/integration/searchPackage.test.ts` (new — verifies `media/search/main.js` is in the .vsix).
- **Phase 2.** New `webview-src/search/ResultStore.ts`, `ListRenderer.ts`, `TreeRenderer.ts`; `index.ts` rewires; new unit + DOM tests.
- **Phase 3.** New `VirtualList.ts`; `ListRenderer.ts` adapts; `tests/bench/searchRender.bench.ts` (new).

### Version bumps

- Phase 1 → `v0.8.1`.
- Phase 2 → `v0.8.2`.
- Phase 3 → `v0.8.3`.

Each phase follows the 5-location version-bump checklist in `CLAUDE.md`.

### Doc updates per `.adn/` mapping

- All three phases update `.adn/features/search-system.md` (architecture/flow).
- Phase 1 also updates `.adn/architecture/overview.md` (new build pipeline) and `.adn/architecture/project-structure.md` (new `webview-src/`, `media/`, `build/`).
- Phase 3 updates `.adn/testing/testing-strategy.md` (bench harness).

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Build pipeline regression breaks `vsce package` | Phase 1 includes a packaging smoke test that builds, runs `vsce package`, and asserts `media/search/main.js` is present in the resulting `.vsix`. |
| CSP breakage in older VS Code | Nonce-based CSP is supported back to VS Code 1.50; the extension's minimum is already higher. |
| Hidden inline `<script>` in the current template that leaks behavior | Phase 1 is byte-for-byte refactor; integration tests catch any drift. |
| jsdom can't simulate scroll perfectly | VirtualList unit tests stub `scrollTop` / `clientHeight`; the real perf gate is the puppeteer bench in phase 3. |
