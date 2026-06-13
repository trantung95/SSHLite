# Support View (WebviewView)

The **"Support SSH Lite"** section is the first entry in the `sshLite` activity-bar
container — above SSH Hosts — and is **collapsed by default**. It holds SSH Lite's
*secondary* purposes (not its core function): an animated promo banner plus quick
links to report a bug, donate, star/rate/share. Added in **v0.9.0**. The coder's
"liveliness" was widened in **v0.9.1** (reacts to SSH Lite terminals, AI
assistants, and other VS Code windows; floats AI tool name labels; follows the
cursor; dozes off when idle - see the sections below).

> **Design skills**: when reshaping this view's UI or the pixel-art **NPC** mascot, invoke the vendored `frontend-design` skill (webview look-and-feel) and `canvas-design` skill (the NPC's pixel art + font choices under `.claude/skills/canvas-design/canvas-fonts/`). See `CLAUDE.md` -> "Webview / UI & Visual Design Skills".

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
| `{type:'setSetting', key, value}` | update an **allow-listed** setting via `getConfiguration('sshLite').update(key, …, Global)`. Booleans (`BOOL_SETTING_KEYS` = `{npcAiActivity, npcCrossWindowBeacon}`) coerce with `!!value`; strings (`STRING_SETTING_KEYS` = `{npcBannerText}`) are trimmed and clamped to `BANNER_TEXT_MAX` (5) chars. Sent by the settings-panel checkbox + the banner-text input. Unknown keys are ignored |
| `{type:'installHooks'｜'uninstallHooks'}` | the panel's "Set up AI hooks" / "Remove" buttons → run `HookInstallerService.installAll()` / `uninstallAll()`, then push an updated `hookStatus` |
| `{type:'ready'}` | sent once the webview wired its listeners (and on each gear-open) → extension echoes `settings` + `hookStatus` so the panel renders correctly |

**Extension → webview:**

| message | trigger / effect |
|---------|------------------|
| `{type:'typed', src}` | sent by `notifyTyped(src)` on any activity pulse → wakes the coder and taps a hand. `src` tags the source: editor / selection / terminal-in / terminal-out / beacon (cross-window) / window (this window regained OS focus, via `onDidChangeWindowState`, feature-detected) |
| `{type:'aiActive', id, name, prompt?}` | a known AI coding assistant went active → float that tool's `name` as a label around the coder. `id` keys the per-tool label so repeats refresh the same label's time-to-live. When AI **input hooks** are installed, `prompt` carries the bounded text the user just submitted and the coder flies the actual characters; without hooks `prompt` is absent and a random word flies |
| `{type:'settings', npcAiActivity, npcCrossWindowBeacon, npcBannerText, npcBannerMode}` | reflect the settings on the panel: the checkbox + the banner-text input + the visibility dropdown. `npcBannerText` drives the cheering banner live; `npcBannerMode` (`occasional`/`always`/`never`) drives whether/when it shows. Sent on the `ready` handshake and whenever a setting changes (panel or Settings UI) |
| `{type:'hookStatus', tools, message?}` | per-tool AI-hook state (`{id,name,present,installed}[]`) + an optional status line → render the hooks section |

## Typing reaction

The coder reacts to the user's activity. A webview is sandboxed and **cannot see
keystrokes**, so the extension bridges activity to it. `extension.ts` calls
`supportViewProvider.notifyTyped(src)` on the **broadest supported signals**:

- `vscode.workspace.onDidChangeTextDocument`, editing a document (`src='editor'`).
- `vscode.window.onDidChangeTextEditorSelection`, moving the cursor / navigating
  in an editor (`src='selection'`).
- `vscode.window.onDidStartTerminalShellExecution`, running a terminal command
  (feature-detected; stable only on newer VS Code, so guarded for engines ^1.85).
- `TerminalService.onActivity`, typing or output in an **SSH Lite terminal**
  (`src='terminal-in'` / `'terminal-out'`; a coarse direction signal, never the
  keystroke or data content; see `.adn/features/terminal-port-forwarding.md`).
- `BeaconService`, another VS Code window of the same install is active
  (`src='beacon'`; see "Cross-window beacon" below).

`notifyTyped(src)` posts `{type:'typed', src}` to the webview, but only when the
view is **visible** (collapsed -> no-op, zero cost) and **throttled** to ~30ms. In
the webview, while typing is recent both hands **bob** up/down (alternating); they
rest when idle. The webview also reacts to its own `keydown` (for when the panel
itself has focus). Any pulse also **wakes** the coder out of idle drowsiness (see
below).

**Hard limit (why it can't be truly global):** there is **no VS Code API** for an
extension to observe keystrokes in **another extension's webview** (e.g. the
Claude Code chat box), the **integrated terminal** of another window (per-key), or
`InputBox`/QuickPick; those are sandboxed. The only way to capture global
keystrokes is an **OS-level keylogger** (native key hook), which we will **not**
ship: it is a privacy violation, needs OS accessibility permissions, would be
rejected/removed from the Marketplace, and is against LITE. This is exactly why the
AI-activity and cross-window signals below use **on-disk file-change watching** (a
coarse "something happened" signal, never the content) rather than trying to read
another window's input. So coverage is "the broadest VS Code allows", not literally
everywhere.

## AI assistant activity + name labels (`AiActivityWatchService`)

`src/services/AiActivityWatchService.ts` makes the coder react when a popular AI
coding assistant is working, and floats that tool's **name** as a label around the
coder. It watches the transcript / history files those tools write on disk using
`vscode.createFileSystemWatcher` (event-driven, **no polling**). On a file-change
event it calls `supportViewProvider.notifyAiActive(id, name)`, which posts
`{type:'aiActive', id, name}`; the webview floats the name at a random position and
flies a random word. Multiple active tools show multiple labels; a label disappears
about **2 seconds** after the tool goes quiet (a time-to-live keyed by `id`).

**Reads file-change events only, never file contents.** Watchers attach only while
the Support view is **visible** AND `sshLite.npcAiActivity` is on, **skip
non-existent directories**, and are disposed on hide / disable / deactivate. For a
richer reaction that flies the user's actual prompt text, see **AI input hooks**
below (and `.adn/features/ai-hooks.md`) — those push the prompt to a beacon instead
of SSH Lite reading any transcript.

### AI input hooks (`HookInstallerService` + `HookBeaconService`)

The opt-in way to make the coder fly the words the user actually types into an AI
tool. From the Support view's **gear → settings panel → "Set up AI hooks"**,
`HookInstallerService` installs a tiny *prompt-submit* hook into each AI tool the
user has (user-global config). Each tool's hook runs the bundled
`assets/hooks/npc-beacon.js`, which extracts only the bounded prompt text and
OVERWRITES one tiny beacon file in globalStorage. `HookBeaconService` watches that
single file and posts `{type:'aiActive', …, prompt}` so the coder flies the real
characters. SSH Lite still never reads the AI tools' transcripts.

**Safety (never break the user's config):** parse-or-abort (an unparseable config
is left untouched), append-only merge (existing keys/hooks preserved), idempotent
(dedup by the `npc-beacon.js` marker), `<file>.sshlite.bak` backup + atomic
temp-rename write, presence-gated (only writes where the tool's home dir exists),
and uninstall removes only our entry (Copilot uses its own dedicated file).

**Coverage (verified schemas):** Claude Code (`~/.claude/settings.json`), Codex
(`~/.codex/hooks.json`), Gemini (`~/.gemini/settings.json`, `BeforeAgent`), Cursor
(`~/.cursor/hooks.json`, `beforeSubmitPrompt`), Copilot (`~/.copilot/hooks/ssh-lite-npc.json`).
Cline is UI-only (script-in-directory + in-app toggle, macOS/Linux only) so it is
excluded; Aider and Roo Code ship no hooks.

**Watching paths outside the workspace** requires
`new vscode.RelativePattern(vscode.Uri.file(base), glob)`; a plain string glob only
watches inside the open workspace folder (needs `engines.vscode >= 1.64`; we are
`^1.85`).

Tool registry (id → display name → watched path):

| id | display name | watched path |
|----|--------------|--------------|
| `claude-code` | Claude Code | `~/.claude/projects/**/*.jsonl` |
| `codex` | Codex | `~/.codex/sessions/**/*.jsonl` |
| `gemini` | Gemini | `~/.gemini/tmp/**/*.json` |
| `cursor` | Cursor | `~/.cursor/projects/**/agent-transcripts/*.jsonl` |
| `aider` | Aider | `<workspace>/.aider.chat.history.md` |
| `cline` | Cline | `globalStorage/saoudrizwan.claude-dev/tasks/**/ui_messages.json` |
| `roo` | Roo Code | `globalStorage/rooveterinaryinc.roo-cline/tasks/**/ui_messages.json` |
| `kilo` | Kilo Code | `globalStorage/kilocode.kilo-code/tasks/**/ui_messages.json` |
| `continue` | Continue | `~/.continue/sessions` + `dev_data` |
| `github-copilot` | Copilot | `workspaceStorage/**/chatSessions/*.json` (Copilot Chat only) |

`sshLite.npcAiActivityTools` (default `[]`) limits the set: empty means **all known
tools**; otherwise only the listed ids are watched.

**Granularity is per turn / per tool-call, not per keystroke.** The chat input of
each tool is itself a webview, so typed characters are not written to disk until
submit. Inline Copilot completions are never written to disk, so they cannot be
detected (Copilot Chat sessions are).

## User presence label

The same floating-label mechanism shows **the local user** working, mirroring the
AI labels. When the user is active in an editor or in an SSH Lite terminal, the
`{type:'typed', src, user}` message carries a display name and the webview floats a
single label keyed `__user__` (styled distinctly and tagged "(you)"), refreshed on
each pulse and expiring with the same ~2 second time-to-live. The name comes from
`os.userInfo().username` (resolved in `extension.ts`, defaulting to "You") - always
available and local, no git or network lookup. Net effect: the coder shows *who* is
working - the person and any busy AI assistants - at a glance.

## Cross-window beacon (`BeaconService`)

`src/services/BeaconService.ts` makes the coder react when **another VS Code window
on the same machine** is active. There is no VS Code API to observe other windows,
so it uses a tiny shared file as a one-way activity channel:
`context.globalStorageUri` is shared by **all windows of the same VS Code install**,
so a small file there plus `createFileSystemWatcher` is a no-polling cross-window
activity signal.

- **Writer**: debounced to at most one write per **250ms**; writes only
  `{ v, ts, kind:'editor'|'terminal', from:<instanceId> }`, that is a schema
  version, a timestamp, a coarse category, and the window's instance id. **No
  keystrokes, paths, or host names.**
- **Reader**: watches `npc-beacon.json`, **ignores its own writes** (self-echo
  suppression by `from === instanceId`), **ignores malformed or stale** beacons
  (older than 10 seconds), and on a valid foreign beacon calls
  `notifyTyped('beacon')` to pulse the coder.
- **Lifecycle**: the reader watcher runs **only while the Support view is
  visible**; gated by `sshLite.npcCrossWindowBeacon` (default on); the beacon file
  is **deleted on deactivate**.

## Idle drowsiness (webview only)

After about **15 seconds** with no activity the coder closes its eyes in a slow
breathing rhythm (sleeps). **Any** activity (typing, terminal, AI, or
cross-window) wakes it instantly (every pulse resets the idle timer). Pure canvas
effect, no message round-trip; respects `prefers-reduced-motion` (no breathing
animation, just the static closed-eye frame).

## Eyes follow the cursor (webview only)

While the mouse is over the Support panel, the coder's **pupils track the cursor**
(clamped to a small range so the eyes never leave the sockets); they **recentre**
when the mouse leaves the panel. This is **panel-only**: a sandboxed extension
cannot track the cursor in other windows or anywhere in the operating system, so no
attempt is made. Pure canvas effect.

## Cheering banner ("băng cổ động") — webview only

Added in **v0.9.5**. Once in a while a small **tilted headband** appears **across
the coder's forehead** (like a sports fan's cheering band — between the hairline and
the glasses, not floating above the head). It is a thin strip about the **glasses'
height**, carrying a **Vietnam flag** (a red field with a centred yellow five-point
star, drawn as an inline SVG — no image asset, works under `default-src 'none'`)
and, a short gap away, a short **text** (`sshLite.npcBannerText`, default "VN").
It **zooms in**, lingers a few minutes, then **zooms out**. Pure webview DOM over
the `.promo` container (like the `.kpop` keycaps and `.ailabel` labels) — never on
the pixelated canvas, so the flag and text stay crisp.

Each appearance randomises:

- **Tilt** — a small random rotation (±4°), carried by an inline `--tilt` CSS var
  that each `@keyframes` step restates, so the zoom in/out animates `scale()` while
  the tilt and centring survive.
- **Colours** — `pickBannerColours()`: the background hue is chosen from the arcs
  `(15..40)∪(70..345)` so it **never matches the flag's red `#da251d` / yellow
  `#ffff00`**, with a random dark or light lightness band; the text is a
  near-complementary hue with the **opposite** lightness band (and a vivid
  saturation), so it always contrasts and is **never the same colour as the
  background**. The background is kept **pale** (low saturation, ~30–46%) and
  **slightly translucent** — it is emitted as an `hsla()` with `VN_BANNER_BG_ALPHA`
  (0.8), so only the band's fill is see-through; the flag SVG and text are separate
  child elements painted on top and stay fully opaque. Applied via inline `--bg` /
  `--txt` vars.
- **Band width** — a **fixed headband** whose straight middle spans the head width
  (`canvas.offsetWidth * 34/160`); it overhangs by a small fixed margin
  (`VN_BANNER_MIN_OVERHANG`, **1 internal px** split across both ends) so it **hugs
  the head**, plus **0–4 internal px** more at random (`VN_BANNER_EXTRA_MAX`). The
  corner radius (`VN_BANNER_RADIUS`, must match the CSS) is kept separate from the
  width margin. The width is set once per appearance and is **independent of the
  text** — editing the label swaps the content in place (`refreshBannerInner`) and
  never resizes the band. `overflow:hidden` clips content to the rounded ends.
- **Flag position** — the flag is **always off to one side** (`bannerFlagSide`,
  random left/right), never mid-forehead: it is the outermost element on that side
  with the text trailing toward the centre a short gap away, and
  `layoutBannerContent` pushes the content 78–100% of the way to that side
  (`--shift`). If the content is wider than the band (long 5-char text or a tiny
  zoom) it is **scaled down to fit** (`--fit`) instead.

Sizing is derived from the head width (`canvas.offsetWidth * 34/160`), so the banner
**scales with the NPC zoom**; the text/gap also use `--npc-scale` like the keycaps.
The banner **follows the head's up/down bob**: `draw()` calls
`syncBannerToHeadBob(bob)` each frame, adding the head's vertical bob (in DOM px) to
the banner's resting `top`, so it stays glued to the head while the coder types.

**Timing (tunable constants in `index.ts`):** appearances are **≥10 minutes apart**
(random 10–20 min); each one stays **≥3 minutes** (random 3–5 min) before zooming
out. Only **one banner at a time**. The self-rescheduling `setTimeout` (the
idle-glance pattern) runs only while the webview is alive (`retainContextWhenHidden:
false` tears it down on collapse) and skips spawning while `document.hidden`.
`prefers-reduced-motion` shortens the zoom to a snap. An **empty** `npcBannerText`
shows the **flag only** (no text or gap). The banner text is rendered via
`textContent` (never `innerHTML`) and clamped to 5 chars on both the webview and
extension sides, so a user-set value cannot inject markup.

**Visibility mode (`sshLite.npcBannerMode`: `occasional` / `always` / `never`
(default)).** One dropdown drives whether/when the headband shows (the three states
are mutually exclusive by construction — no conflicting toggles). **The feature is
off by default (`never`)** — it's a niche flourish, opt-in via the dropdown:
- `occasional` — the ≥10-min cycle above.
- `always` — kept shown continuously: spawned as a *persistent* banner with no
  auto-retire (`bannerPersistent`); an in-flight occasional banner is *promoted* to
  persistent (its hold timer cancelled); a live `npcBannerText` edit swaps the
  content in place so the new text shows immediately.
- `never` (default) — any current banner is retired and nothing respawns.

The occasional scheduler keeps firing underneath but only spawns in `occasional`
mode, and no-ops while a banner is already present (one banner at a time).

## Key popups, zoom, and the settings gear

- **Key popups** - on each typed pulse, `index.ts` spawns a small keycap **as a
  real DOM element** (a `.kpop` div over the `.promo` container), not on the
  canvas, so the text stays crisp instead of being upscaled by the pixelated
  canvas. When the **actual characters are known** it flies them: the panel's own
  `keydown` (EVERY key — letters, digits, and named keys Tab/Ctrl/Alt/F1‑F20/etc.
  via `keyLabel`), and **editor edits** (the `onDidChangeTextDocument` change carries
  the inserted text → forwarded as `typed.text`). A **mouse click** pops "Click" and
  **scroll** pops "Scroll" (throttled; Ctrl+wheel stays the zoom gesture). When the
  characters aren't known (cursor move, deletion, terminal, window-focus pulse) it
  flies a **random word** — never a random single key. An AI pulse with an installed
  hook flies the user's **actual prompt characters** (a short staggered burst via
  `flyPromptText`, capped at 10). Each keycap gets a random colour, floats
  up and fades via CSS (`@keyframes kpop-rise`), removes itself on `animationend`,
  and dismisses on click. **No rate limit** - every pulse spawns one; the extension
  already throttles its pulses per source (30 ms user / 150 ms server + AI), so
  flooding is bounded upstream.
- **Settings gear** - a `#settingsToggle` (⚙) button on the zoom row expands /
  collapses the `#npcSettings` panel (collapsed by default; open state persisted via
  `patchState({settingsOpen})`). The panel holds: a **React to other VS Code
  windows** checkbox (`npcCrossWindowBeacon`), a **Banner text** row with the
  `npcBannerText` input (`maxlength=5`, see "Cheering banner" below) and a
  visibility **dropdown** (`npcBannerMode`: Sometimes / Always / Never) beside it,
  and the **AI input hooks** section
  (per-tool install state + "Set up AI hooks" / "Remove" buttons). Every row carries
  a hover `title` tooltip. The `npcAiActivity` toggle lives in the VS Code Settings
  UI, not the panel. The checkboxes + input post `setSetting` (the input debounced
  ~400ms, value trimmed/clamped to 5); buttons post `installHooks` /
  `uninstallHooks`. On open (and load) the webview posts `{type:'ready'}` so the
  extension echoes `settings` + `hookStatus`.
- **Zoom** - the same row has buttons (and Ctrl+wheel over the canvas) that set
  the canvas CSS width in pixels. `max-width:100%` caps it at the section width,
  so it is independent of the width-driven scaling but can never exceed the
  section. Persisted via `patchState({zoom})`.
- Typing inside a form field is excluded from popup spawning (the global `keydown`
  handler ignores events whose target is an `INPUT`/`TEXTAREA`).

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
- **Activity signals are event-driven and visible-gated**: the AI-activity watcher
  (`AiActivityWatchService`) and cross-window beacon (`BeaconService`) use
  `createFileSystemWatcher` (no polling), attach **only while the Support view is
  visible** AND the setting is on (`sshLite.npcAiActivity` /
  `sshLite.npcCrossWindowBeacon`, both default on), read **file-change events only,
  never contents**, and are disposed on hide / disable / deactivate. The opt-in AI
  input hooks (`HookBeaconService`) likewise watch only one tiny beacon file SSH
  Lite owns — never the AI tools' transcripts. The cursor-follow and idle-drowsiness
  effects are pure webview canvas (no extension traffic).

## Tests

`src/webviews/SupportViewProvider.test.ts` (uses `createMockWebviewView()` from
`src/__mocks__/vscode.ts`, and `jest.mock('fs')` for a hermetic `getHtml`):
nonce + CSP + bundled JS/CSS URIs present; each action runs the right command;
`openPromo` opens the URL; unknown cmd ignored; `webviewError` + log bridge forward
to `infoLog`/`diagLog`. (The canvas animation itself isn't unit-tested — it's
purely presentational drawing with no logic to assert.)
