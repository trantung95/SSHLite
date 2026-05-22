# Lessons Learned

AI assistants must read this file at the start of every session and apply all lessons.
Add new entries as bugs are found, mistakes are made, or better approaches are discovered.

---

## 2026-05-22 — `fs.writeFileSync(uri.fsPath, …)` is unsafe; declare `extensionKind` when an extension belongs on the user's machine

**What happened**: User A on Windows used VS Code's built-in **Remote-SSH** extension to connect to a Linux server, then installed SSH Lite from the Marketplace inside that session. Because `package.json` did not declare `extensionKind`, VS Code placed SSH Lite on the **workspace** extension host (running on remote Linux), not on the user's Windows machine. When the user clicked **Download** on a remote file:

- The save dialog defaulted to `/tmp/<vscode-tmp-id>/<name>` (a VS Code session-temp on the remote), not the user's actual home.
- The download silently failed — `fs.writeFileSync(saveUri.fsPath, content)` either landed in a hidden VS Code temp dir or threw `EACCES`, depending on the Remote-SSH setup.
- The user expected behaviour like the PDF Viewer extension: an **Install in Local** button, with SSH Lite running on Windows and the file landing at `C:\Users\<user>\...`.

**Root cause** (two stacked layers):

- **Manifest layer**: `extensionKind` was undeclared. Marketplace falls back to "wherever VS Code prefers", which for a Remote-SSH session is the workspace host. SSH Lite was already designed as a UI-only client (all I/O via `vscode.SecretStorage`, `showSaveDialog`, `ssh2` native client; no `process.platform` branches; no local-file assumptions) but it never *told* VS Code that.
- **Code layer**: `FileService.downloadFileTo` and `downloadFolder` used `fs.writeFileSync(saveUri.fsPath, content)` / `fs.mkdirSync(folderUri.fsPath, ...)`. The dialog can return a URI whose scheme is **not** `file:` — on Remote-SSH workspace host it returns `vscode-remote://ssh-remote+host/...`, and `.fsPath` on that URI resolves to a path the raw Node `fs` module cannot reach (or writes to the wrong host's filesystem). The unit + integration suites only ever exercised `file:` URIs, so this latent bug shipped.

**Lesson** (mandatory checks for any future feature touching save/open dialogs OR extension hosts):

- **Declare `extensionKind` explicitly** for any extension whose semantic is "talk to remote servers from where the user actually sits". For SSH-client-type extensions like SSH Lite, `["ui", "workspace"]` (UI preferred, workspace allowed for chained SSH) is the right shape. Never rely on VS Code's default placement — it varies by VS Code version and remote backend.
- **Never call `fs.writeFileSync(uri.fsPath, …)`** (or `fs.readFileSync(uri.fsPath)`, `fs.mkdirSync`, etc.) on a URI returned by `showSaveDialog` / `showOpenDialog`. The URI scheme is **not** guaranteed to be `file:` — it can be `vscode-remote:`, `vscode-vfs:` (GitHub Codespaces, virtual workspaces), `untitled:`, or any registered `FileSystemProvider` scheme. Use `vscode.workspace.fs.{readFile,writeFile,createDirectory,delete,stat,readDirectory}` — they dispatch via the URI provider system and respect the scheme. `vscode.workspace.fs.createDirectory` is idempotent; drop the `if (!fs.existsSync(...)) fs.mkdirSync(...)` guard.
- **Use `vscode.Uri.joinPath(baseUri, ...segments)`** to build child URIs inside a folder dialog result. `path.join(folderUri.fsPath, name)` produces a *string*, dropping the scheme — when you later feed that string back into a URI you lose `vscode-remote:` / `vscode-vfs:`.
- **Surface a one-time hint** when an extension lands on the wrong host. Detection combo: `vscode.env.remoteName === 'ssh-remote'` plus `context.extension.extensionKind === vscode.ExtensionKind.Workspace`. Offer "Install in Local" + a dismissible "Don't show again" backed by a settings key (`sshLite.suppressLocalInstallHint`). "Download failed silently to a path I've never heard of" is a hostile experience; the user does not know which host the extension ran on.
- **Regression net**: every dialog-write path needs a unit test that exercises **at least three URI schemes** — `file:`, `vscode-remote:`, and one arbitrary custom scheme (`mem:`, etc.). The test asserts `vscode.workspace.fs.writeFile` was called AND `fs.writeFileSync` was NOT called on the dialog URI. See `src/services/FileService.downloadUri.test.ts` for the template.
- **Remaining dialog call sites with the same latent bug** (still using `.fsPath` with raw `fs`): `AuditService.exportLogs`, `keyCommands.pushPubkey`, `diffCommand`, `FileService.uploadFileTo` (read side). Lower user impact but track as a known gap — fix when the next change touches that area.

---

## 2026-05-19 — `activate()` init steps MUST be wrapped in `safeStep`; an unguarded throw silently kills all tree views

**What happened**: A user on v0.8.10 reported all 4 SSH Lite tree views ("SSH HOSTS", "REMOTE FILES", "ACTIVITY", "PORT FORWARDS") showed *"There is no data provider registered"* and their saved hosts looked gone. We traced it to `src/extension.ts` `activate()`: it ran ~18 sequential init steps (service inits, virtual-doc providers, tree-provider constructors, then four `vscode.window.createTreeView` calls) **with no try/catch and minimal logging**. A single throw in any step — `credentialService.initialize`, `connectionManager.initialize`, `portForwardService.initialize`, `folderHistoryService.initialize`, `SnippetService.initialize`, or any tree-provider constructor — aborted the whole function before reaching `createTreeView`. Result: no view ever registered, no log to tell us which step failed, no way to recover without an extension reinstall. (Hosts were not actually deleted — they remained in VS Code User `settings.json` under `sshLite.hosts` — but with no tree to render them, the user thought they were lost and was on the verge of re-adding everything from memory.)

**Root cause**: VS Code's extension activation has no implicit safety net. If `activate()` throws, VS Code marks the extension as broken AND any `contributes.views` declared in `package.json` show the "no data provider registered" placeholder — which looks identical to "the tree provider isn't implemented yet" rather than "activation crashed". The user has no way to distinguish "my hosts were deleted" from "the extension never loaded". And without per-step logging, even reproducing the bug locally doesn't tell you which step is the culprit.

**Lesson — for any activation code added from v0.8.11 forward**:

- **Wrap each init step in `safeStep(name, fn)`** (defined at the top of `src/extension.ts`). The helper logs `lifecycle / activate/<name>-ok` on success, `activate/<name>-failed` with the error name + message + 3-line stack on throw, pushes the name onto `_activateFailures`, and returns `undefined` so subsequent steps still run. This is non-negotiable for service inits and `createTreeView` calls.
- **Tree-view variables become `TreeView<T> | undefined`** — guard every downstream usage (`if (view) { view.reveal(...) }`, `if (view) treeViewDisposables.push(view)` etc.). TypeScript will surface every missing guard via `'x' is possibly undefined` compile errors — fix them iteratively, don't skip with `!`.
- **Tree-provider constructors are intentionally NOT wrapped** because their downstream usages number in the hundreds (every command handler does `fileTreeProvider.refreshFolder(...)` etc.) and making the providers nullable would require guards in every handler. The bug in practice was in service inits, not provider constructors; if a provider ever does throw in the future, the throw propagates and VS Code marks the extension as broken — better than silently leaving the user with no UI.
- **End every activate with a summary**: if `_activateFailures.length > 0`, fire one `vscode.window.showErrorMessage` listing the failed step names so the user sees which feature is degraded and can open Output → SSH Lite for the per-step log. Always emit `infoLog('lifecycle', 'activate/complete', { failedSteps, failedNames })`.
- **Regression net**: `src/extension.activate.test.ts` asserts the happy path (4 trees register) AND the degraded path (one service throws, OTHER 3 trees still register, the failure is recorded, user gets one error notification). If a future refactor moves a throw-prone call outside `safeStep`, these tests fail.
- **The recovery path for users hit by an old version of this bug**: their saved hosts are still in `~/.../User/settings.json` under `sshLite.hosts`. The 0.8.11 release notes tell them where to look so they don't re-add everything by hand.

**Don't conflate "no UI rendered" with "data lost".** Always ask "did the storage layer actually delete anything, or did the rendering layer just fail?" before assuming the worst. SSH Lite saved hosts live in VS Code workspace configuration (`vscode.workspace.getConfiguration('sshLite').hosts` in `hostService.ts:154`), not in extension-managed JSON files — they survive even a totally broken extension.

---

## 2026-05-19 — Never transcribe a crypto address from a screenshot by eye; always decode the source QR

**What happened**: While building the donate section in `README.md`, I read the TON address from the wallet-app screenshot (`IMG_5389.png`) character by character — three times, even — and recorded it as `UQBbbIS1-F3ufPBPD13EKfp28G_A_j10kXNn-XuuxQUwoIEs` (uppercase `I` at position 6). v0.8.9 was committed and published with that string and a QR generated from it. User then asked me to verify carefully against the screenshots again, this time by decoding the source QR with `jsqr`. The QR actually encoded `UQBbblS1-…` — lowercase `l`, not uppercase `I`. The published donate page would have routed TON donations to a *different valid TON address* (or nowhere) — irrecoverable funds.

**Root cause**: iOS's sans-serif (SF Pro) renders uppercase `I`, lowercase `l`, and digit `1` as essentially the same vertical stroke at small sizes. Same applies to `0`/`O`/`o`, and `B`/`8` in some fonts. Visual transcription cannot reliably distinguish them. I performed the "triple-check" but all three checks used the same flawed input (my eyes on the same pixels), so they all returned the same wrong answer with growing confidence.

Compounding factor: my generator script then *encoded* my mistranscribed string into a QR, and when I "verified" by decoding that generated QR with `jsqr`, of course it round-tripped correctly — I was checking that the QR matched my string, not that my string matched the source. That's a tautology, not a verification.

**Lesson**:

- **For any address that came from a QR code (crypto wallets, payment links, anything money- or auth-critical):** decode the source QR with `jsqr` (or another decoder) and use the decoded bytes as ground truth. Never transcribe by eye, no matter how many times.
- **"Verification by re-encoding then decoding" is a tautology.** It only proves the generator round-trips, not that the encoded value matches the source. The verification chain must be: `source screenshot → decode → string A`; `our string → string B`; assert `A === B`.
- **Watch for these character pairs in any base64/base64url payload** (the alphabet TON, GitHub gist IDs, JWTs, etc. use): `I`/`l`/`1`/`i`, `O`/`0`/`o`, `B`/`8`, `S`/`5`, `Z`/`2`. base58 (used by Solana, Bitcoin) deliberately excludes most of these (`0`, `O`, `I`, `l`) — that's a feature, not an accident. Hex (used by EVM chains) is also unambiguous.
- **When a verification step succeeds, ask "what input did this verification consume?"** If the answer is "the same input I'm trying to verify", it's not a verification.

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
