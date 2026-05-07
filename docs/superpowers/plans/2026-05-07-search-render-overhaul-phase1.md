# Search Render Overhaul — Phase 1 (Bundler + Lift) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the 2535-line inline webview template out of `src/webviews/SearchPanel.ts` into real source files (`webview-src/search/`) bundled by esbuild to `media/search/`, with **zero observable behavior change**. Adds postMessage in/out logging and a webview→extension log forwarder. Ships as v0.8.1.

**Architecture:** New `webview-src/search/` directory holds `index.html`, `styles.css`, `index.ts`, and `log.ts`. A small `build/build-webview.js` script invokes esbuild to bundle to `media/search/{main.js,main.css,index.html}` (gitignored, packaged in `.vsix`). `SearchPanel.getWebviewContent()` shrinks to a 30-line HTML loader that rewrites asset URIs through `webview.asWebviewUri()` and injects a per-load CSP nonce. The script body migrates **as-is** — nested-backtick escaping is unwound to plain backticks; logic is otherwise byte-equivalent.

**Tech Stack:** TypeScript, esbuild, VS Code Webview API (`asWebviewUri`, CSP nonce), Jest (`@swc/jest`), `npx vsce package`.

**Spec reference:** `docs/superpowers/specs/2026-05-07-search-render-overhaul-design.md`

---

## File Map

| File | Action |
|---|---|
| `webview-src/search/index.html` | **Create** — body markup lifted from the inline template |
| `webview-src/search/styles.css` | **Create** — `<style>` block lifted from the inline template |
| `webview-src/search/index.ts` | **Create** — `<script>` body lifted; nested backticks unwound |
| `webview-src/search/log.ts` | **Create** — postMessage-based webview logger (`info`, `diag`) |
| `build/build-webview.js` | **Create** — esbuild orchestration |
| `scripts/verify-package.js` | **Create** — packaging smoke test (build → vsce package → list zip → assert) |
| `package.json` | **Modify** — esbuild devDep, new scripts, `compile` chains webview build, version bump 0.8.1 |
| `.gitignore` | **Modify** — add `media/` |
| `.vscodeignore` | **Modify** — allow `media/`, exclude `webview-src/` and `build/` |
| `src/webviews/SearchPanel.ts` | **Modify** — replace `getWebviewContent()` (line 1488–~4023) with HTML loader; add log forwarder handler; add postMessage in/out logging |
| `README.md` | **Modify** — version badge + 0.8.1 release notes |
| `docs/COMMANDS.md` | **Auto** — `npm run docs:commands` (no command changes expected, but runs as part of release checklist) |
| `.adn/CHANGELOG.md` | **Modify** — prepend v0.8.1 entry |
| `.adn/architecture/overview.md` | **Modify** — note new build pipeline |
| `.adn/architecture/project-structure.md` | **Modify** — note new `webview-src/`, `media/`, `build/`, `scripts/verify-package.js` |
| `.adn/features/search-system.md` | **Modify** — note webview is built from source, no behavior change |

---

## Task 1: Add esbuild devDep and verify it resolves

**Files:**
- Modify: `package.json`

- [ ] **Step 1.1: Install esbuild**

Run:
```bash
npm install --save-dev esbuild
```
Expected: `package.json` `devDependencies` gains `esbuild` at the latest version (≥ 0.20). `package-lock.json` updates.

- [ ] **Step 1.2: Verify esbuild is callable**

Run:
```bash
npx esbuild --version
```
Expected: prints a version string like `0.24.0` or similar.

- [ ] **Step 1.3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add esbuild as devDep for webview bundling"
```

---

## Task 2: Create the webview build script (red — fails because no source files yet)

**Files:**
- Create: `build/build-webview.js`

- [ ] **Step 2.1: Create the build script**

```javascript
// build/build-webview.js
//
// Bundles the search webview source (webview-src/search/) into media/search/.
// Emits main.js (bundled JS), main.css (lifted from styles.css), and copies
// index.html verbatim. The extension's SearchPanel.getWebviewContent() reads
// these artifacts at runtime via webview.asWebviewUri().

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'webview-src', 'search');
const OUT = path.join(ROOT, 'media', 'search');

const watch = process.argv.includes('--watch');

async function build() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));

  const ctx = await esbuild.context({
    entryPoints: [path.join(SRC, 'index.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    outfile: path.join(OUT, 'main.js'),
    sourcemap: 'inline',
    logLevel: 'info',
  });

  const cssCtx = await esbuild.context({
    entryPoints: [path.join(SRC, 'styles.css')],
    bundle: true,
    outfile: path.join(OUT, 'main.css'),
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    await cssCtx.watch();
    console.log('[build-webview] watching webview-src/search/ ...');
  } else {
    await ctx.rebuild();
    await cssCtx.rebuild();
    await ctx.dispose();
    await cssCtx.dispose();
    console.log('[build-webview] bundled to media/search/');
  }
}

build().catch((err) => {
  console.error('[build-webview] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2.2: Verify it fails because source files don't exist**

Run:
```bash
node build/build-webview.js
```
Expected: error like `ENOENT: no such file or directory, open '...webview-src/search/index.html'`. This is the red state — we'll fix it in the next tasks.

- [ ] **Step 2.3: Commit**

```bash
git add build/build-webview.js
git commit -m "build: add esbuild orchestration for webview bundling"
```

---

## Task 3: Extract the CSS block to `webview-src/search/styles.css`

**Files:**
- Create: `webview-src/search/styles.css`

- [ ] **Step 3.1: Locate the `<style>` block**

In `src/webviews/SearchPanel.ts`, the `<style>` opening tag is at line 1496 (`<style>`); the closing `</style>` is roughly 800 lines later. Confirm the exact line range:
```bash
grep -n "<style>\|</style>" src/webviews/SearchPanel.ts
```

- [ ] **Step 3.2: Copy CSS verbatim into a new file**

Create `webview-src/search/styles.css` with the exact contents between (but not including) `<style>` and `</style>`. **Do not modify any rule.** Preserve indentation. The file should start something like:

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  /* ... continues ... */
}
```

- [ ] **Step 3.3: Commit (intermediate — file not yet wired)**

```bash
git add webview-src/search/styles.css
git commit -m "build: extract search webview CSS to webview-src/search/styles.css"
```

---

## Task 4: Extract the body markup to `webview-src/search/index.html`

**Files:**
- Create: `webview-src/search/index.html`

- [ ] **Step 4.1: Locate the body markup boundaries**

The `<body>` opens after the closing `</style>`. The closing `</body></html>` is just before the template's terminating backtick. Find the body start with:
```bash
grep -n "<body>\|</body>" src/webviews/SearchPanel.ts
```

- [ ] **Step 4.2: Build the new index.html skeleton**

Create `webview-src/search/index.html` with this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- CSP and asset URIs are injected by SearchPanel.getWebviewContent() at runtime.
       The placeholders below are replaced via simple string substitution. -->
  <meta http-equiv="Content-Security-Policy" content="__CSP__">
  <title>Search</title>
  <link rel="stylesheet" href="__STYLES_URI__">
</head>
<body>
__BODY__
  <script nonce="__NONCE__" src="__SCRIPT_URI__"></script>
</body>
</html>
```

- [ ] **Step 4.3: Replace `__BODY__` with the lifted markup**

Open `src/webviews/SearchPanel.ts`, copy the markup between `<body>` and the trailing `<script>` tag (the `<script>` block stays out — its body becomes `index.ts`). Paste in place of `__BODY__`. Preserve indentation. **Do not modify any element, attribute, class, or id.**

- [ ] **Step 4.4: Commit**

```bash
git add webview-src/search/index.html
git commit -m "build: extract search webview HTML skeleton to webview-src/search/index.html"
```

---

## Task 5: Create the webview log helper

**Files:**
- Create: `webview-src/search/log.ts`

- [ ] **Step 5.1: Write the log helper**

```typescript
// webview-src/search/log.ts
//
// Webview-side logger. Cannot write to the extension's Output channel
// directly, so it posts {type:'log', level, scope, event, payload} messages
// back to the extension which forwards via infoLog/diagLog.
//
// Levels match the extension-side diagnosticLog module:
//   - info: always emits.
//   - diag: gated by sshLite.diagnosticLogging on the extension side.

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

let api: { postMessage: (msg: unknown) => void } | null = null;

function getApi(): { postMessage: (msg: unknown) => void } {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

type LogPayload = Record<string, unknown> | undefined;

function emit(level: 'info' | 'diag', scope: string, event: string, payload?: LogPayload): void {
  try {
    getApi().postMessage({ type: 'log', level, scope, event, payload });
  } catch {
    // postMessage failure is silent — never throw from the logger.
  }
}

export function info(scope: string, event: string, payload?: LogPayload): void {
  emit('info', scope, event, payload);
}

export function diag(scope: string, event: string, payload?: LogPayload): void {
  emit('diag', scope, event, payload);
}

export function getVsCodeApi(): { postMessage: (msg: unknown) => void } {
  return getApi();
}
```

- [ ] **Step 5.2: Commit**

```bash
git add webview-src/search/log.ts
git commit -m "build: add webview-side log helper that forwards to extension Output channel"
```

---

## Task 6: Extract the `<script>` body to `webview-src/search/index.ts`

This is the largest mechanical step. The current `<script>` body (about 1500–2500 lines depending on counting) sits inside the outer template literal in `getWebviewContent()`, which means every backtick and `${}` inside it is escaped (`\``, `\${`). Pulling it out unwinds those escapes.

**Files:**
- Create: `webview-src/search/index.ts`

- [ ] **Step 6.1: Locate the script boundaries**

```bash
grep -n "<script>\|</script>" src/webviews/SearchPanel.ts
```
The opening `<script>` is around line 2487; the closing `</script>` is near the end of `getWebviewContent()`.

- [ ] **Step 6.2: Copy the script body verbatim**

Create `webview-src/search/index.ts`. Start it with this header:

```typescript
// webview-src/search/index.ts
//
// Search webview bootstrap and runtime. Phase 1 of the search render overhaul:
// this is a byte-equivalent lift of the script body that previously lived
// inside SearchPanel.getWebviewContent()'s template literal. Logic is
// unchanged — only string escaping is normalised (\` → `, \${ → ${).
//
// Phase 2 will dismantle this monolith into ResultStore + ListRenderer +
// TreeRenderer modules. Until then, treat this file as the existing webview
// JS, just hoisted into a real source file.

import { info, diag } from './log';

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

```

Then paste the entire script body (the contents between `<script>` and `</script>`, excluding those tags themselves) below.

- [ ] **Step 6.3: Unwind nested-backtick escaping**

The lifted code currently has `\`` and `\${` because it was inside an outer template literal. Replace globally:
- `\`` → `` ` ``
- `\${` → `${`

Verify:
```bash
grep -c "\\\\\`" webview-src/search/index.ts
grep -c "\\\\\${" webview-src/search/index.ts
```
Expected: both print `0` after the replacement.

- [ ] **Step 6.4: Replace `console.log` calls with the log helper (if any)**

```bash
grep -n "console\\.log\\|console\\.error\\|console\\.warn" webview-src/search/index.ts
```
For each hit, replace:
- `console.log(args)` → `info('search-webview', '<descriptive-event>', { ... })`
- `console.error(args)` → `info('search-webview', 'error', { message: String(args) })`
- `console.warn(args)` → `diag('search-webview', '<event>', { ... })`

If the grep returns no hits, skip this step.

- [ ] **Step 6.5: Add bootstrap log**

Find the very first executable statement (likely `const vscode = acquireVsCodeApi();`). Replace that line with:

```typescript
const vscode = acquireVsCodeApi();
info('search-webview', 'ready', { domReadyMs: Math.round(performance.now()) });
```

- [ ] **Step 6.6: Verify the file parses as TypeScript**

Run:
```bash
npx tsc --noEmit --target es2020 --module esnext --moduleResolution bundler --skipLibCheck webview-src/search/index.ts webview-src/search/log.ts
```
Expected: no errors. If you see implicit-any errors on event handlers (`MessageEvent`, etc.), add explicit types — the goal is type safety. Do NOT loosen `tsconfig` globally.

- [ ] **Step 6.7: Verify esbuild bundles it**

Run:
```bash
node build/build-webview.js
```
Expected: prints `[build-webview] bundled to media/search/` and produces:
- `media/search/main.js` (non-empty, > 50 KB)
- `media/search/main.css` (non-empty)
- `media/search/index.html` (copied verbatim)

- [ ] **Step 6.8: Commit**

```bash
git add webview-src/search/index.ts
git commit -m "build: extract search webview script body to webview-src/search/index.ts"
```

---

## Task 7: Add npm scripts and wire `compile`

**Files:**
- Modify: `package.json`

- [ ] **Step 7.1: Add the new scripts**

In `package.json`, replace the existing `compile`, `watch`, `vscode:prepublish` entries with:

```json
"vscode:prepublish": "npm run compile",
"compile": "npm run compile:webview && tsc -p ./",
"compile:webview": "node build/build-webview.js",
"watch": "tsc -watch -p ./",
"watch:webview": "node build/build-webview.js --watch",
"verify:package": "node scripts/verify-package.js",
```

Keep all other scripts unchanged.

- [ ] **Step 7.2: Verify `npm run compile` succeeds**

Run:
```bash
npm run compile
```
Expected: webview bundles, then `tsc` compiles the extension. No errors. `out/` contains compiled extension code; `media/search/` contains the webview bundle.

- [ ] **Step 7.3: Commit**

```bash
git add package.json
git commit -m "build: chain compile:webview before tsc; add watch:webview and verify:package scripts"
```

---

## Task 8: Update `.gitignore` and `.vscodeignore`

**Files:**
- Modify: `.gitignore`
- Modify: `.vscodeignore`

- [ ] **Step 8.1: Add `media/` to `.gitignore`**

Append to `.gitignore`:

```
# Built webview bundles (regenerated by `npm run compile:webview`)
media/
```

Verify nothing inside `media/` is currently tracked:
```bash
git ls-files media/
```
Expected: empty output.

- [ ] **Step 8.2: Update `.vscodeignore`**

Replace the current `.vscodeignore` with:

```
.vscode/**
.vscode-test/**
src/**
webview-src/**
build/**
scripts/**
.gitignore
.yarnrc
vsc-extension-quickstart.md
**/tsconfig.json
**/.eslintrc.json
**/*.map
**/*.ts
!out/**/*.d.ts
*.vsix
.git/**
.claude-workflow.md
.claude/**
test-docker/**
jest.*.config.js
jest.config.js
nul
docs/**
.adn/**
```

The key changes: add `webview-src/**`, `build/**`, `scripts/**`, `docs/**`, `.adn/**` (these don't belong in the .vsix). `media/**` is **not** excluded — it must ship.

- [ ] **Step 8.3: Verify**

Run:
```bash
npm run compile
npx vsce ls
```
Expected: the listed files include `media/search/main.js`, `media/search/main.css`, `media/search/index.html`, `out/extension.js`, `package.json`, `README.md`. They do NOT include `webview-src/`, `build/`, `src/`, `docs/`, `.adn/`, or `tests/`.

- [ ] **Step 8.4: Commit**

```bash
git add .gitignore .vscodeignore
git commit -m "build: gitignore media/; vscodeignore webview-src/build/scripts/docs/.adn"
```

---

## Task 9: Replace `getWebviewContent()` with the HTML loader

**Files:**
- Modify: `src/webviews/SearchPanel.ts`

- [ ] **Step 9.1: Add the loader helper at the top of the class**

In `src/webviews/SearchPanel.ts`, near the top of the `SearchPanel` class (before any method), add:

```typescript
  /** Generate a CSP nonce per webview load. */
  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }
```

- [ ] **Step 9.2: Replace `getWebviewContent()`**

Find `private getWebviewContent(): string {` (around line 1488) and the matching closing `}` (around line 4023, the very last method body before `dispose()`). Replace the **entire method body** with:

```typescript
  private getWebviewContent(): string {
    if (!this.panel) {
      throw new Error('SearchPanel.getWebviewContent called before panel was created');
    }
    const webview = this.panel.webview;
    const nonce = SearchPanel.makeNonce();
    const cspSource = webview.cspSource;

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'search');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));

    const csp = [
      `default-src 'none'`,
      `script-src ${cspSource} 'nonce-${nonce}'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data:`,
      `font-src ${cspSource}`,
    ].join('; ');

    const htmlPath = path.join(this.context.extensionPath, 'media', 'search', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace('__CSP__', csp)
      .replace('__STYLES_URI__', stylesUri.toString())
      .replace('__SCRIPT_URI__', scriptUri.toString())
      .replace('__NONCE__', nonce);

    diagLog('search-panel', 'load-html', {
      htmlPath,
      nonceLen: nonce.length,
      bytes: html.length,
    });

    return html;
  }
```

- [ ] **Step 9.3: Add the necessary imports**

At the top of `src/webviews/SearchPanel.ts`, ensure these imports exist (add any that are missing):

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { infoLog, diagLog } from '../utils/diagnosticLog';
```

- [ ] **Step 9.4: Confirm `this.context` is available**

`SearchPanel` already takes `context: vscode.ExtensionContext` in its constructor (verify by reading the constructor signature around line 143). No change needed if so. If not, thread `context` through — but it should already be there.

- [ ] **Step 9.5: Compile**

Run:
```bash
npm run compile
```
Expected: 0 TypeScript errors.

- [ ] **Step 9.6: Commit (DO NOT run tests yet — log forwarder lands in next task)**

```bash
git add src/webviews/SearchPanel.ts
git commit -m "feat(search): replace inline 2535-line template with HTML-loader getWebviewContent"
```

---

## Task 10: Add the webview log forwarder and postMessage logging

**Files:**
- Modify: `src/webviews/SearchPanel.ts`

- [ ] **Step 10.1: Find the existing onMessage handler**

In `src/webviews/SearchPanel.ts`, find where the webview's message receiver is registered. Search for `webview.onDidReceiveMessage` or `panel.webview.onDidReceiveMessage`:

```bash
grep -n "onDidReceiveMessage" src/webviews/SearchPanel.ts
```

- [ ] **Step 10.2: Add a `'log'` case at the top of the message handler switch**

Inside the message handler (typically a `switch (message.type)` block), add this case **before all other cases**:

```typescript
case 'log': {
  const level = message.level === 'diag' ? 'diag' : 'info';
  const scope = typeof message.scope === 'string' ? message.scope : 'search-webview';
  const event = typeof message.event === 'string' ? message.event : 'unknown';
  const payload = (message.payload && typeof message.payload === 'object') ? message.payload : undefined;
  if (level === 'info') {
    infoLog(scope, event, payload);
  } else {
    diagLog(scope, event, payload);
  }
  return;
}
```

Also extend the `WebviewMessage` discriminated union (around line 72) to include the `'log'` variant:

```typescript
  | { type: 'log'; level: 'info' | 'diag'; scope: string; event: string; payload?: Record<string, unknown> };
```

- [ ] **Step 10.3: Add `'webviewError'` handler**

In the same switch, add:

```typescript
case 'webviewError': {
  infoLog('search-panel', 'webview-error', {
    message: typeof message.message === 'string' ? message.message : '(no message)',
    stack: typeof message.stack === 'string' ? message.stack.slice(0, 1000) : undefined,
  });
  return;
}
```

Extend the union type:

```typescript
  | { type: 'webviewError'; message: string; stack?: string };
```

- [ ] **Step 10.4: Add postMessage in/out diag logging**

Find `private postMessage(` (around line 1479). Replace its body with a wrapper that logs:

```typescript
  private postMessage(msg: unknown): void {
    try {
      const m = msg as { type?: string };
      diagLog('search-panel', 'post', {
        type: m && typeof m.type === 'string' ? m.type : 'unknown',
        size: typeof msg === 'object' && msg !== null ? JSON.stringify(msg).length : 0,
      });
    } catch { /* never let logging break postMessage */ }
    if (this.panel) {
      this.panel.webview.postMessage(msg);
    }
  }
```

Wrap the inbound message handler entry too — at the top of the message-receiver function:

```typescript
diagLog('search-panel', 'recv', { type: typeof message?.type === 'string' ? message.type : 'unknown' });
```

- [ ] **Step 10.5: Add `show`/`dispose` info logs**

Find `public show(` (around line 273). At the top of the method body, add:

```typescript
infoLog('search-panel', 'show', {
  hasPanel: !!this.panel,
  scopeCount: this.searchScopes.length,
  serverCount: this.serverList.length,
});
```

Find `public dispose(` (around line 4023). At the top:

```typescript
infoLog('search-panel', 'dispose', {});
```

- [ ] **Step 10.6: Compile**

```bash
npm run compile
```
Expected: 0 errors.

- [ ] **Step 10.7: Run the existing test suite**

Run:
```bash
npx jest --no-coverage
```
Expected: **all 1445 tests pass.** If `SearchPanel.test.ts` fails, the most likely cause is the new `'log'`/`'webviewError'` cases assuming a structure the test mock doesn't provide. Inspect the failure, fix the handler to be defensive (the code above already is), or fix the test mock.

- [ ] **Step 10.8: Commit**

```bash
git add src/webviews/SearchPanel.ts
git commit -m "feat(search): add webview log forwarder and postMessage in/out diag logs"
```

---

## Task 11: Manual smoke test — webview behavior unchanged

**Files:** none (manual verification step)

- [ ] **Step 11.1: Build and launch the extension**

```bash
npm run compile
```
Open the project in VS Code, press `F5` to launch the Extension Development Host.

- [ ] **Step 11.2: Open the search panel**

In the host window, run the command **SSH Lite: Open Search Panel** (or the existing equivalent — check `package.json contributes.commands` for the exact title).

- [ ] **Step 11.3: Verify visual parity**

Compare against the v0.8.0 baseline (use a fresh git stash if needed). Expected: identical layout, identical fonts, identical colors, identical icons. **If any visual difference, stop and investigate** — it means the lift wasn't byte-equivalent.

- [ ] **Step 11.4: Verify behavior parity**

In the host window:
1. Connect to a real or test SSH server.
2. Search for a common term across one server's `/etc` directory.
3. Verify results appear progressively, file groups expand/collapse, list/tree toggle works, sort toggle works.
4. Pin a result tab. Open another search. Switch between tabs.
5. Cancel a search mid-stream.

Expected: every behavior matches v0.8.0. **If anything regresses, stop and fix before continuing.**

- [ ] **Step 11.5: Verify logs reach the Output channel**

In the host window, View → Output → select **SSH Lite** from the dropdown. Expected: see `[INFO/search-panel] show ...` log entry. Open a search → see `[DIAG/search-panel] post ...` lines (only if `sshLite.diagnosticLogging` is enabled in the host's settings; enable it and reproduce).

- [ ] **Step 11.6: No commit (verification step)**

---

## Task 12: Add packaging smoke test

**Files:**
- Create: `scripts/verify-package.js`

- [ ] **Step 12.1: Write the script**

Important: this script uses `child_process.execFileSync` (no shell, arg arrays) per project convention. For zip listing it shells out to `tar -tf` (Windows 10 build 17063+ ships bsdtar.exe; POSIX has tar with libarchive), which is the lightest cross-platform way to list .vsix entries without adding a zip-reader devDep.

```javascript
// scripts/verify-package.js
//
// Builds the extension, runs `vsce package`, lists .vsix entries, and asserts
// the webview bundle (media/search/main.js etc.) is included.
// Run via `npm run verify:package`. Exits non-zero on failure.
//
// Uses execFileSync (no shell) with arg arrays — see project security rule.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';

// Inside a .vsix, files live under "extension/" (vsce convention).
const REQUIRED_ENTRIES = [
  'extension/media/search/main.js',
  'extension/media/search/main.css',
  'extension/media/search/index.html',
  'extension/out/extension.js',
];

function run(bin, args) {
  console.log('[verify-package] $ ' + bin + ' ' + args.join(' '));
  execFileSync(bin, args, { cwd: ROOT, stdio: 'inherit' });
}

function listVsixEntries(vsixPath) {
  // tar (bsdtar/libarchive) handles zip on both Win10+ and POSIX.
  const out = execFileSync('tar', ['-tf', vsixPath], { cwd: ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

(function main() {
  // Clean prior .vsix files
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.vsix')) fs.rmSync(path.join(ROOT, f));
  }

  run(NPM, ['run', 'compile']);
  run(NPX, ['--yes', '@vscode/vsce', 'package', '--no-dependencies']);

  const vsix = fs.readdirSync(ROOT).find((f) => f.endsWith('.vsix'));
  if (!vsix) {
    console.error('[verify-package] FAIL: no .vsix produced');
    process.exit(1);
  }
  console.log('[verify-package] produced ' + vsix);

  const entries = listVsixEntries(path.join(ROOT, vsix));
  const missing = REQUIRED_ENTRIES.filter((e) => !entries.includes(e));
  if (missing.length) {
    console.error('[verify-package] FAIL: missing entries in .vsix:');
    missing.forEach((m) => console.error('  - ' + m));
    console.error('[verify-package] First 20 entries actually in .vsix:');
    entries.slice(0, 20).forEach((e) => console.error('  ' + e));
    process.exit(1);
  }
  console.log('[verify-package] OK — all ' + REQUIRED_ENTRIES.length + ' required entries present in ' + vsix);
})();
```

- [ ] **Step 12.2: Run it**

```bash
npm run verify:package
```
Expected: prints `[verify-package] OK — all 4 required entries present in sshlite-0.8.0.vsix` (the version in the filename will reflect the current `package.json`).

If it fails because `tar` is missing on Windows (very old Windows builds), upgrade Windows or replace the listing call with PowerShell — but on the project's supported environments tar is present.

- [ ] **Step 12.3: Commit**

```bash
git add scripts/verify-package.js
git commit -m "build: add packaging smoke test that verifies media/search/* lands in the .vsix"
```

---

## Task 13: Bump version to 0.8.1 (5-location checklist)

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Auto: `docs/COMMANDS.md` (via `npm run docs:commands`)
- Modify: `README.md` Release Notes
- Modify: `.adn/CHANGELOG.md`

- [ ] **Step 13.1: Bump `package.json` version**

In `package.json`, change `"version": "0.8.0"` to `"version": "0.8.1"`.

- [ ] **Step 13.2: Bump README badge**

In `README.md` line 3, change `version-0.8.0-blue` to `version-0.8.1-blue`.

- [ ] **Step 13.3: Regenerate command docs**

Run:
```bash
npm run docs:commands
```
Expected: `docs/COMMANDS.md` is updated (likely a no-op diff for this phase since no commands change).

- [ ] **Step 13.4: Add README release notes entry**

In `README.md`, find the Release Notes section. Prepend:

```markdown
### 0.8.1 — Search webview lifted to bundled assets

Internal refactor. The search panel webview is now built from `webview-src/search/` (esbuild) and shipped under `media/search/` in the .vsix. No user-visible behavior change.

**Why:** unblocks parallel list+tree state (v0.8.2) and list virtualization (v0.8.3) — see `.adn/CHANGELOG.md` for the full series. `SearchPanel.ts` shrinks from 4032 to ~1500 lines; the rendering layer is now testable in isolation. Adds postMessage in/out diag logs and a webview→extension log forwarder so all webview events land in the **SSH Lite** Output channel for triage.
```

- [ ] **Step 13.5: Add `.adn/CHANGELOG.md` entry**

In `.adn/CHANGELOG.md`, prepend:

```markdown
## v0.8.1 — Search webview lifted to bundled assets

Phase 1 of the search render overhaul (spec: `docs/superpowers/specs/2026-05-07-search-render-overhaul-design.md`). Pure refactor — zero observable behavior change.

### What changed

- **New `webview-src/search/`** — `index.html`, `styles.css`, `index.ts`, `log.ts`. Source of truth for the search webview.
- **New `build/build-webview.js`** — esbuild orchestration. Bundles to `media/search/{main.js, main.css, index.html}`.
- **New `scripts/verify-package.js`** — packaging smoke test, run via `npm run verify:package`.
- **`SearchPanel.getWebviewContent()`** shrinks from 2535 lines to ~30. CSP tightens from `'unsafe-inline'` script to a per-load nonce.
- **Logging:** every `postMessage` in/out is logged via `diagLog`. `show`/`dispose` are logged via `infoLog`. New `'log'` and `'webviewError'` message types route webview-side logs into the **SSH Lite** Output channel.

### Build pipeline

- New devDep: `esbuild`.
- `npm run compile` now runs `compile:webview` (esbuild) before `tsc`.
- `npm run watch:webview` for webview-only dev iteration.
- `npm run verify:package` builds + packages + asserts `media/search/*` is in the .vsix.

### Verification

- `npm run compile` — 0 errors
- `npx jest --no-coverage` — 1445/1445 pass (unchanged from v0.8.0)
- `npm run verify:package` — passes
- Manual smoke: search panel layout and behavior identical to v0.8.0

### Coming in v0.8.2

- `ResultStore` with parallel list+tree state
- View toggle becomes O(visible-rows), not O(total-results)
- Append-not-rebuild on each `searchBatch`
```

- [ ] **Step 13.6: Verify command count is consistent**

CLAUDE.md says "currently 98" commands. This phase doesn't add or remove commands. Confirm:
```bash
node -e "const p=require('./package.json'); console.log(p.contributes.commands.length)"
```
Expected: `98`. No update to the 5 places listed in `CLAUDE.md`'s Commands Count table is needed.

- [ ] **Step 13.7: Commit**

```bash
git add package.json README.md docs/COMMANDS.md .adn/CHANGELOG.md
git commit -m "release: v0.8.1 — search webview lifted to bundled assets"
```

---

## Task 14: Update `.adn/` documentation

**Files:**
- Modify: `.adn/architecture/overview.md`
- Modify: `.adn/architecture/project-structure.md`
- Modify: `.adn/features/search-system.md`

- [ ] **Step 14.1: Update `.adn/architecture/overview.md`**

Find the section describing the build pipeline (search for `tsc` or `compile`). Add after it:

````markdown
### Webview build pipeline (since v0.8.1)

The search panel webview (`src/webviews/SearchPanel.ts`) loads its HTML/CSS/JS from `media/search/`, bundled by esbuild from `webview-src/search/`. The pipeline:

```
webview-src/search/
  index.ts ──┐
  index.html ─┼─▶ build/build-webview.js (esbuild) ─▶ media/search/{main.js, main.css, index.html}
  styles.css ─┘
```

`npm run compile` chains `compile:webview` → `tsc`. `npm run watch:webview` for dev iteration. `npm run verify:package` is the smoke test that the bundle ships in the .vsix.

The webview loads bundled assets via `webview.asWebviewUri()` with a per-load CSP nonce; no inline scripts.
````

- [ ] **Step 14.2: Update `.adn/architecture/project-structure.md`**

Add (or update) the directory tree to reflect:

```
webview-src/search/    Source for the search webview (since v0.8.1)
build/                 Build orchestration scripts (esbuild webview)
scripts/               One-off scripts (verify-package, generate-commands-doc, run-chaos)
media/search/          Built webview bundle (gitignored, packaged in .vsix)
```

- [ ] **Step 14.3: Update `.adn/features/search-system.md`**

Find the `## Architecture` section near the top. Replace the diagram with:

```
SearchPanel (TS, extension) ←postMessage/onMessage→ Webview (bundled from webview-src/search/)
                                                     │
                                                     ├─ index.ts    (bootstrap + runtime; phase-2 split coming)
                                                     ├─ log.ts      (postMessage-based logger)
                                                     ├─ styles.css  (lifted from old inline <style>)
                                                     └─ index.html  (HTML skeleton; URIs + nonce injected at load)
```

Add a new subsection:

```markdown
### Logging

All search webview events land in the single **SSH Lite** Output channel:

- Extension side: `infoLog('search-panel', ...)` for show/dispose/webview-error; `diagLog('search-panel', ...)` for every `post`/`recv`.
- Webview side: posts `{type:'log', level, scope, event, payload}` back to the extension via the `log.ts` helper. The extension forwards via `infoLog`/`diagLog`.
- Triage: enable `sshLite.diagnosticLogging` → reproduce → View → Output → select **SSH Lite** → Select All → Copy.
```

- [ ] **Step 14.4: Commit**

```bash
git add .adn/architecture/overview.md .adn/architecture/project-structure.md .adn/features/search-system.md
git commit -m "docs: update .adn for v0.8.1 webview build pipeline and logging"
```

---

## Task 15: Final verification before tagging

**Files:** none (verification step)

- [ ] **Step 15.1: Clean build**

```bash
rm -rf out media node_modules
npm install
npm run compile
```
Expected: clean compile from scratch. `media/search/{main.js,main.css,index.html}` exist.

- [ ] **Step 15.2: Full test suite**

```bash
npx jest --no-coverage
```
Expected: 1445/1445 pass.

- [ ] **Step 15.3: Packaging**

```bash
npm run verify:package
```
Expected: `OK — all 4 required entries present`.

- [ ] **Step 15.4: Manual smoke (one more time)**

Repeat Task 11. Confirm zero behavior change vs v0.8.0.

- [ ] **Step 15.5: Verify SearchPanel.ts shrunk as expected**

```bash
node -e "const fs=require('fs'); console.log('lines:', fs.readFileSync('src/webviews/SearchPanel.ts','utf8').split('\\n').length)"
```
Expected: a number around 1500–1700 (down from 4032). If still > 2000, the lift wasn't complete — go back and check Task 9.

- [ ] **Step 15.6: Tag the release**

```bash
git tag v0.8.1
```

---

## Notes for the implementing engineer

- **Byte-equivalent lift.** Phase 1 is a refactor, not a redesign. If you find yourself wanting to clean up logic in `index.ts`, **stop** — that's phase 2's job. Save notes for later.
- **Nested-backtick escapes.** The original template uses `\`` and `\${` because it was inside an outer template literal. After lifting, those become plain `` ` `` and `${`. Task 6.3 covers this — verify with `grep` that no escapes survive.
- **`fs.readFileSync` in `getWebviewContent`.** This is acceptable: webview HTML is small (< 50 KB) and read once per panel show. If profiling later shows it as a hot path, cache it.
- **Why `'unsafe-inline'` for styles in CSP.** The lifted templates use `style="display:none"` and similar inline style attributes. Removing them is a phase-2 concern.
- **Logging discipline.** New webview-side `console.log` is not allowed (CLAUDE.md rule + project preference). Always use `info()` / `diag()` from `webview-src/search/log.ts`. The `'don't log in loops'` rule applies — phase 1 has no loops yet, but keep it in mind for phase 2/3.
- **`execFileSync` vs `execSync`.** Project rule: never use `execSync` or `exec` with string commands; always `execFileSync` with arg arrays (no shell). The build/verify scripts in this plan follow that rule.
- **If a task fails, do not skip ahead.** Each task ends in a green state (compile + tests). If you're red, fix before continuing.
