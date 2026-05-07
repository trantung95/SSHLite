# Lessons Learned

AI assistants must read this file at the start of every session and apply all lessons.
Add new entries as bugs are found, mistakes are made, or better approaches are discovered.

---

## 2026-05-07 — Tab state defaults must be overwritten by every payload that carries the value

**What happened**: User configured `sshLite.searchMaxResults: 10000`. The search correctly returned 10000 results (extension-side cap was honored), but the UI banner read "⚠️ Limit 2000 reached" instead of 10000. The displayed value did not match the configured setting.

**Root cause**: `createTabState()` initializes `tab.limit: 2000` as a hardcoded default. The `'searchBatch'` message handler (and its kept-tab branch) updated `results`, `hitLimit`, and `searching` on each batch but never assigned `tab.limit = message.limit`, even though every batch payload carries the extension's `maxResults` value. So `tab.limit` stayed at 2000 forever, and `renderResults()` read `tab.limit || limit` and rendered "2000" in the warning text. Behavior was correct (10000 results stopped the search at the right point); only the displayed cap value was stale. The `'results'` handler (a different message path) did update `tab.limit`, which is why the bug was inconsistent and easy to miss.

**Lesson**:
- When a tab/state object has fields with hardcoded defaults (`limit: 2000`, `viewMode: 'list'`, etc.), audit every message handler that produces or refreshes that state. Each handler must overwrite every default-bearing field whose canonical value is in the payload — not just `results`/`hitLimit`/`searching`. A field that's only set in *one* of several handlers will display the default everywhere else.
- For settings that surface in user-visible text (limit warnings, banner counts), the source of truth should be the live payload, not a tab-state default. Default fields should be invariant skeletons, not values used as fallbacks.
- When a config value flows extension→webview, run a focused check: search for everywhere `tab.<field>` is read in the renderer, and confirm every message handler that affects that tab updates `<field>` from the payload.

## 2026-05-07 — `vsce package --no-dependencies` strips ssh2 and breaks activation

**What happened**: The Phase 1 `scripts/verify-package.js` ran `vsce package --no-dependencies`. The flag tells vsce to omit `node_modules/` from the .vsix. The 4-entry `REQUIRED_ENTRIES` check verified `media/search/*` and `out/extension.js` were present and reported success. But the shipped .vsix was missing the entire `node_modules/` tree — including `ssh2` and `ssh-config`, both runtime dependencies. On install, `require('ssh2')` failed at module load, `activate()` never ran, and every tree view showed "no data provider registered for this view." The user had to surface the error from the DevTools console; the verify-package smoke test gave a green light.

**Root cause**:
- `--no-dependencies` is appropriate ONLY when an extension uses a bundler (esbuild/webpack) to inline all runtime deps into a single output file. SSH Lite does not bundle the extension itself — only the search webview is bundled. The extension's `out/extension.js` still does `require('ssh2')` at runtime.
- The verify script's required-entries list checked the webview bundle but not runtime deps. A green check on the webview said nothing about activation viability.
- The shipped .vsix was 1 MB instead of the expected ~5 MB. A size sanity check would have caught this immediately.

**Lesson**:
- `vsce package` (no flags) is the correct release command for SSH Lite. The standard behavior bundles `dependencies` from `package.json` (not `devDependencies`) and that is exactly what we want.
- Any packaging-smoke script must verify production deps ship: include `extension/node_modules/<runtime-dep>/package.json` in REQUIRED_ENTRIES for every entry in `package.json`'s `dependencies`. Currently: `ssh2`, `ssh-config`.
- A .vsix sanity-size check is cheap and effective: SSH Lite's expected size is ≥ 4 MB. Anything substantially smaller indicates missing deps.
- Reviewers cannot catch packaging bugs by reading code — they manifest only at install/runtime. The packaging-smoke script IS the test; its assertions must be specific enough to fail on broken artifacts.

## 2026-05-07 — Lifting JS out of a template literal needs a THREE-step unescape, not two

**What happened**: Phase 1 of the search-render-overhaul (v0.8.1) lifted the inline `<script>` body from `SearchPanel.getWebviewContent()` (a template literal) into `webview-src/search/index.ts`. The unescape pass handled `` \` → ` `` and `\${ → ${` but missed `\\u → \u` (and `\\u{` → `\u{`). After the lift, every emoji and special character (server status icons 🔄 ❌ 🟢 ⚡ ⚫, path icons 📄 📁, warning ⚠️, remove/close ×, sort ↑, tooltip em-dashes —) rendered as literal escape text like `\u{1F504}` in the UI. Three reviewers (Task 6 spec + quality, then a holistic Phase 1 review) examined the lift; only the holistic final review caught this. Manual smoke test (Task 11) was skipped per user request — that gate would have caught it in 30 seconds.

**Root cause**: A string literal inside a template literal is double-evaluated: once by the template literal itself, then again by the inner JS engine when the template's string is loaded as code. So the original `'\\u{1F504}'` in the template-literal source produced `'\u{1F504}'` at template-output time, which the webview's JS engine then parsed as the emoji. After lifting to a real `.ts` file, only one level of evaluation happens — `'\\u{1F504}'` becomes literal text `\u{1F504}` (9 chars), never interpreted as a unicode escape.

**Lesson**:
- When lifting any JS body out of a template literal into a real source file, the unescape pass must include **all** template-literal escape sequences, not just backticks and `${`. At minimum: `` \` ``, `\${`, `\\u`, `\\u{`, `\\xHH`, `\\n`, `\\r`, `\\t`, `\\\\` (literal backslash). Run a grep for `\\\\` in the source after the lift; every hit is a candidate for the same regression.
- Per-task code reviewers can miss UI-rendering bugs because they don't run the UI. The **manual smoke test** is the only reliable gate for this class of bug. If the user opts to skip manual smoke, flag the unicode/escape-sequence risk explicitly in the report so they can run a targeted check (e.g. open the panel and verify icons render).
- Add a one-liner check to any future webview-lift plan: `grep -nE '\\\\[a-zA-Z0-9{]' webview-src/<dir>/index.ts` should return zero hits after the unescape; any hit is a regression risk.
