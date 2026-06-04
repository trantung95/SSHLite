# Support View (WebviewView)

The **"Support SSH Lite"** section is the first entry in the `sshLite` activity-bar
container — above SSH Hosts — and is **collapsed by default**. It holds SSH Lite's
*secondary* purposes (not its core function): an animated promo banner plus quick
links to report a bug, donate, star/rate/share. Added in **v0.9.0**.

## Why a WebviewView (not a TreeDataProvider)

A `TreeDataProvider` row can only show a ~16px `ThemeIcon` — it cannot render a real
image or animation. To embed an **animated promo banner**, the section must be a
`vscode.WebviewViewProvider` (an HTML panel). This is the extension's **first**
WebviewView. Note the distinction from `SearchPanel`, which is a `WebviewPanel`
(an editor-area panel) — different API, different lifecycle.

| | SearchPanel | SupportViewProvider |
|---|---|---|
| API | `createWebviewPanel` | `registerWebviewViewProvider` |
| Location | editor column | sidebar view (in `sshLite` container) |
| Lifetime | singleton, `retainContextWhenHidden:true` | resolved on expand, `retainContextWhenHidden:false` |
| State | search scopes, results, tabs | stateless |

## Files

| File | Role |
|------|------|
| `src/webviews/SupportViewProvider.ts` | `WebviewViewProvider`; builds HTML (CSP + nonce + `asWebviewUri`), handles messages |
| `webview-src/support/index.html` | shell with `__CSP__ __NONCE__ __STYLES_URI__ __SCRIPT_URI__` tokens; a `<canvas id="promoCanvas">` + link buttons |
| `webview-src/support/index.ts` | wires `[data-cmd]` buttons → `postMessage({type:'action',cmd})`; `window.onerror` bridge; **draws the animated pixel-art coder on the canvas** |
| `webview-src/support/styles.css` | **fully fluid** layout (see "Responsive" below) |
| `webview-src/support/log.ts` | webview→extension log bridge (copy of `search/log.ts`) |
| `build/build-webview.js` | esbuild pipeline — `ENTRIES` array bundles both `search` and `support` |

The promo is **script-drawn**, not an image: `index.ts` renders a pixel-art coder
(sitting at a desk, facing the viewer, typing on a keyboard) onto a 160×120
`<canvas>` via a throttled `requestAnimationFrame` loop. No image asset ships —
the "art" is code. (`enableScripts:true` + the nonce'd `main.js` make this safe;
canvas drawing needs no `img-src`.)

Built artifacts land in `media/support/{main.js,main.css,index.html}` (same shape as
`media/search/`). `verify-package.js` asserts they ship in the `.vsix`.

## Registration (extension.ts)

Registered just before the tree views, wrapped in `safeStep` (a throw must not
cascade and break the tree views — see `extension-activation.md`):

```ts
const supportViewProvider = new SupportViewProvider(context.extensionUri, context.extensionPath);
safeStep('support-webview-view', () =>
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SupportViewProvider.viewType, supportViewProvider, {
      webviewOptions: { retainContextWhenHidden: false },
    })
  )
);
```

`package.json` view entry (first in `contributes.views.sshLite`):

```json
{ "id": "sshLite.support", "name": "Support SSH Lite", "type": "webview", "visibility": "collapsed" }
```

`"visibility": "collapsed"` sets the **initial** state. VS Code then remembers the
user's expand/collapse choice — there is no supported API to force-collapse every
launch, and we don't hack one.

### View ordering caveat (top-of-container)

Declaration order puts `sshLite.support` **first** in the container, so a **fresh
install** shows it at the top. But VS Code **persists per-container view order**,
and when a new view is added to a container the user already has (i.e. an
**upgrade** from a version without this view, or a dev-host profile that already
showed the old 4 views), VS Code appends the new view at the **bottom** of the
remembered layout. There is **no extension API to reorder views at runtime**
(`vscode.window` has no "move view"). The user fix is one of: drag the section to
the top (persists), right-click its title → **Reset Location**, or Command
Palette → **View: Reset View Locations** (re-applies declaration order). This is a
VS Code limitation, not a manifest bug — the manifest already declares it first.

## Commands (5, all real `sshLite.*`)

Buttons post `{type:'action',cmd}`; the provider validates `cmd` against an
allowlist and runs `vscode.commands.executeCommand('sshLite.'+cmd)`. Registering
real commands keeps them palette-discoverable and unit-testable.

| cmd | command | action |
|-----|---------|--------|
| `reportIssue` | `sshLite.reportIssue` | open GitHub Issues (bug **or** feature request) |
| `donate` | `sshLite.donate` | open the **Bánh Mì** donate webview (`DonatePanel`) |
| `starGithub` | `sshLite.starGithub` | open GitHub repo |
| `rateMarketplace` | `sshLite.rateMarketplace` | open Marketplace review tab |
| `shareExtension` | `sshLite.shareExtension` | copy Marketplace URL to clipboard |

## Donate panel (`DonatePanel` + `donate/donateInfo.ts`)

`sshLite.donate` opens **`src/webviews/DonatePanel.ts`** — a "Send me a Bánh Mì"
`WebviewPanel` (styled after CleanBinAndObj's `SendMeABanhMi`): a short emoji
cooking animation (11 steps + progress bar), then it reveals the donate info —
QR codes, coins/chain, addresses, and **Copy address** buttons. Same webview
discipline as the rest: locked-down CSP + per-load nonce, QR PNGs via
`asWebviewUri` (from `images/donate/`, copied from `docs/images/donate/`), and a
`{type:'log'}` bridge. Copy buttons post `{type:'copy', id, address}`; the
extension copies **only** an address that exists in the source of truth.

**Single source of truth:** all donate content (addresses, coins, chains, notes,
tips, footer, QR filenames) lives in **`src/donate/donateInfo.ts`**. The panel
reads it directly, so editing one file updates the panel everywhere. The README
"Send me a Bánh Mì" section mirrors the same data as static markdown; the drift
test **`src/donate/donateInfo.test.ts`** fails if an address / message / QR ref
in `donateInfo.ts` is not present in the README (and asserts the QR files ship
under `images/donate/`). So a change in one place is flagged until the others
match — addresses are money-critical (see `.adn/lessons.md` 2026-05-19).

Clicking the promo coder does **not** open a link (that was felt to be annoying).
Instead it **recolours a part** — handled entirely in `index.ts` (no message, no
command): click the **shirt** → random hoodie colour, the **coffee mug** → random
mug colour, the **glasses** → random frame colour. Hit-testing uses the click's
canvas coordinates against per-part boxes; each recolour picks a random hue and
derives the shades, then redraws immediately.

## Message contract

**Webview → extension:**

| message | handling |
|---------|----------|
| `{type:'action', cmd}` | run `sshLite.<cmd>` (allowlisted; the 5 link buttons only) |
| `{type:'log', level, scope, event, payload}` | forward to `infoLog`/`diagLog` (one SSH Lite Output channel) |
| `{type:'webviewError', message, stack}` | `infoLog('support-view','webview-error', …)` |

**Extension → webview:**

| message | trigger / effect |
|---------|------------------|
| `{type:'typed'}` | sent by `notifyTyped()` on every editor text change → the coder taps a hand |

## Typing reaction

The coder reacts to the user's activity. A webview is sandboxed and **cannot see
keystrokes**, so the extension bridges activity to it. `extension.ts` calls
`supportViewProvider.notifyTyped()` on the **broadest supported signals**:

- `vscode.workspace.onDidChangeTextDocument` — editing a document.
- `vscode.window.onDidChangeTextEditorSelection` — moving the cursor / navigating
  in an editor.
- `vscode.window.onDidStartTerminalShellExecution` — running a terminal command
  (feature-detected; stable only on newer VS Code, so guarded for engines ^1.85).

`notifyTyped()` posts `{type:'typed'}` to the webview — but only when the view is
**visible** (collapsed → no-op, zero cost) and **throttled** to ~30ms. In the
webview, while typing is recent both hands **bob** up/down (alternating); they
rest when idle. The webview also reacts to its own `keydown` (for when the panel
itself has focus).

**Hard limit (why it can't be truly global):** there is **no VS Code API** for an
extension to observe keystrokes in **another extension's webview** (e.g. the
Claude Code chat box), the **integrated terminal** (per-key), or
`InputBox`/QuickPick — those are sandboxed. The only way to capture global
keystrokes is an **OS-level keylogger** (native key hook), which we will **not**
ship: it is a privacy violation, needs OS accessibility permissions, would be
rejected/removed from the Marketplace, and is against LITE. So coverage is "the
broadest VS Code allows", not literally everywhere.

## Key popups, zoom, and the rate input

- **Key popups** - on each typed pulse, `index.ts` occasionally spawns a small
  keycap **as a real DOM element** (a `.kpop` div over the `.promo` container),
  not on the canvas, so the text stays crisp instead of being upscaled by the
  pixelated canvas. The keycap shows the just-typed key when known (the webview's
  own `keydown`), otherwise a random key or a random word; it gets a random
  colour, floats up and fades via CSS (`@keyframes kpop-rise`), removes itself on
  `animationend`, and dismisses on click.
- **Popup rate** - a `<input type="number">` on the zoom row sets the max popups
  per minute. `spawnPopup` throttles to `60000 / rate` ms between popups; **0**
  means no throttle (every key spawns one). Edited inline (hover shows the
  tooltip), auto-saved on change via `patchState({rate})`, negatives/invalid
  rejected. Default is **0**.
- **Zoom** - the same row has buttons (and Ctrl+wheel over the canvas) that set
  the canvas CSS width in pixels. `max-width:100%` caps it at the section width,
  so it is independent of the width-driven scaling but can never exceed the
  section. Persisted via `patchState({zoom})`. Both zoom and rate share one
  persisted state object (`getState`/`patchState` over the webview state API).
- Typing into the rate input is excluded from popup spawning (the global
  `keydown` handler ignores events whose target is an `INPUT`).

## CSP (identical to SearchPanel)

```
default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource}
```

The promo is canvas-drawn, so `img-src` is unused for it; the directive is kept
only for parity with SearchPanel — **no relaxation, no remote origins**.
`localResourceRoots` is scoped to `media/support` (the only place assets load from).

## Tweaking / replacing the promo animation

The animation lives in `webview-src/support/index.ts` (`startPromo()` + `draw()`),
drawn on a 160×120 `<canvas>` with simple `fillRect` "pixels". Edit the `draw()`
scene or the `C` palette and rebuild (`npm run compile:webview`). To swap to a
different promo (e.g. a static/animated image ad), replace the canvas in
`index.html` with an `<img>`, re-add an `asWebviewUri`'d asset under a packaged
folder + that folder to `localResourceRoots`, and ship the file — `img-src
${cspSource} data:` already allows it (no CSP change).

## Responsive / fluid layout (hard constraint)

The sidebar view resizes on **both axes** — width (drag the sidebar) and height
(drag the divider between views). The layout is fluid, but the promo scales by
**width only**:

- No hardcoded px widths; `width:100%`, `box-sizing:border-box`, flex column.
- Promo `<canvas>`: internal resolution fixed at 160×120; CSS is just `width:100%;
  height:auto; image-rendering:pixelated`. `height:auto` makes the rendered height
  follow the canvas's own ratio, i.e. **driven by width only** — making the
  section taller does **not** rescale the art. **Do not** add a `vh`/`vmin` cap:
  inside a webview `vh` is the *section's* height, so a height-based cap would make
  a vertical drag rescale the promo (a bug we hit and removed).
- Buttons wrap (`white-space:normal`) when narrow.

## LITE compliance

- **Lazy**: collapsed by default; `resolveWebviewView` runs on first expand (and
  VS Code MAY call it again after the view was hidden, since
  `retainContextWhenHidden:false` tears the webview down when hidden). The
  provider clears its `disposables` at the top of `resolveWebviewView` so
  listeners don't accumulate across show/hide cycles. The animation restarts on
  re-show because the iframe is rebuilt (acceptable for a promo).
- **Animation is cheap and self-pausing**: the `requestAnimationFrame` loop is
  throttled to ~14fps, `rAF` pauses while the document is hidden, and the loop
  doesn't run at all when the view is collapsed (no webview) or when the user
  prefers reduced motion (one static frame). No timers, no polling.
- **No remote fetch** (`default-src 'none'`; canvas-drawn promo; donate/share via
  clipboard; links via user-initiated `openExternal`), **no SSH / server commands**
  (no `CommandGuard` needed).

## Tests

`src/webviews/SupportViewProvider.test.ts` (uses `createMockWebviewView()` from
`src/__mocks__/vscode.ts`, and `jest.mock('fs')` for a hermetic `getHtml`):
nonce + CSP + bundled JS/CSS URIs present; each action runs the right command;
`openPromo` opens the URL; unknown cmd ignored; `webviewError` + log bridge forward
to `infoLog`/`diagLog`. (The canvas animation itself isn't unit-tested — it's
purely presentational drawing with no logic to assert.)
