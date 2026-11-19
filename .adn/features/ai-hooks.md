# AI input hooks (NPC reacts to your actual prompts)

**Opt-in, user-triggered.** Lets the Support-view pixel coder fly the words you
actually type into an AI coding tool, instead of SSH Lite reading any transcript.
Added in **v0.9.3**. Set up from the Support view's **gear → "Set up AI hooks"**.

## Why hooks (and why not read files)

A VS Code extension is sandboxed: it cannot see another extension's webview chat
box or another tool's keystrokes. The only on-disk signal is each AI tool's
transcript file changing — coarse, and reading it is heavier and content-bearing.
Instead, every supported AI tool exposes a **prompt-submit hook**: a shell command
the tool runs when you submit a prompt, with the prompt text on stdin. We install a
tiny hook that pushes only the bounded prompt to a beacon SSH Lite watches. SSH Lite
reads only that one small file it owns — never the tools' transcripts.

## Pieces

| Piece | File | Role |
|-------|------|------|
| Hook script | `assets/hooks/npc-beacon.js` | Bundled Node script the tools run. Reads the hook JSON on stdin, extracts only a bounded `prompt` (≤160 chars) + event/tool name, OVERWRITES one tiny beacon file. Always exits 0, never writes stdout — a failing hook can't disrupt the AI tool. Copied to a stable globalStorage path at install (survives extension updates). |
| Installer | `src/services/HookInstallerService.ts` | Reads/merges/writes each tool's hook config; install / uninstall / status; idempotent. |
| Reader | `src/services/HookBeaconService.ts` | Watches the single beacon file (event-driven, visible-gated), dedups by `ts`, drops stale, posts `{type:'aiActive', id, name, prompt}`. |
| UI | `webview-src/support/` gear panel | Per-tool install state + "Set up AI hooks" / "Remove". |
| Wiring | `src/extension.ts` | Builds the services, sets the hook controller, gates the reader on view visibility. |

## Safety — never break the user's config

Every write goes through these rules (see `HookInstallerService`):

- **Parse-or-abort** — an existing config that is not valid JSON is **left
  untouched** (no overwrite, no data loss); the op returns a reason.
- **Append-only merge** — only our single hook entry is added; all other keys and
  the user's existing hooks are preserved.
- **Idempotent** — re-install never duplicates (dedup by the `npc-beacon.js`
  marker in the command string).
- **Backup + atomic** — prior file copied to `<file>.sshlite.bak`, then a temp
  sibling is written and renamed over the target (no half-written config).
- **Presence-gated** — only writes into a tool's config when that tool's home dir
  exists; never creates configs for tools the user does not use.
- **Clean uninstall** — removes only our entry; Copilot uses its own dedicated file
  so removing it can never touch the user's other hooks.

## Coverage (verified hook schemas)

Installs into **user-global** config so the coder reacts across all the user's
projects. Each tool has a different schema family, encoded per descriptor:

| Tool | Config (user-global) | Event | Schema family |
|------|----------------------|-------|---------------|
| Claude Code | `~/.claude/settings.json` | `UserPromptSubmit` | nested (`hooks→event→[{hooks:[{type,command}]}]`) |
| Codex | `~/.codex/hooks.json` | `UserPromptSubmit` | nested |
| Gemini | `~/.gemini/settings.json` | `BeforeAgent` | nested |
| Cursor | `~/.cursor/hooks.json` | `beforeSubmitPrompt` | flat (`version:1`, `hooks→event→[{command}]`) |
| Copilot | `~/.copilot/hooks/ssh-lite-npc.json` | `userPromptSubmitted` | own dedicated file (`{type,bash,powershell}`) |

**Excluded:** Cline (hooks are UI-only — script-in-directory + in-app toggle, macOS/
Linux only — nothing safe to auto-write); Aider and Roo Code ship no hook system.

### Big caveat: the Claude Code VS Code EXTENSION does not run hooks

Hooks fire only in the Claude Code **CLI** (including `claude` in VS Code's
integrated terminal), **not** in the native Claude Code VS Code extension panel —
and this is **scope-agnostic** (user-global, project `.claude/settings.json`, and
`.claude/settings.local.json` all fail; the extension parses `Found 0 hook
matchers`). Documented as anthropics/claude-code #15021, #16114; feature request
#21736 is open with no timeline. So for a user prompting Claude in the extension
panel, our hook never fires; the coder can only react via the transcript watch
(`AiActivityWatchService`) when Claude **writes output** — never during the pure
"thinking" phase, which exposes no signal at all. Cursor and Copilot **do** run
their in-IDE hooks; Codex and Gemini are CLIs. The feature delivers prompt-text
reaction for: Claude Code in a terminal, Codex/Gemini CLIs, Cursor, and Copilot.

### Auto-setup (`sshLite.npcAutoSetupHooks`, default on)

The first time the user opens the Support view, `extension.ts` calls
`hookInstaller.installAll()` for the present tools, once (tracked by a globalState
flag so a later manual **Remove** is respected). It is gated on the panel becoming
visible — never at activation — so it cannot write configs during the test suite
(verified: the suite touches no real `~/.claude`). Turn the setting off to require
the manual "Set up AI hooks" button instead.

The hook command is `node "<stable script>" "<beacon file>" <toolId>`. It relies on
`node` being on the hook shell's PATH (true for anyone running these CLIs); if it is
missing the hook simply fails silently — the AI tool is unaffected, the feature just
does nothing for that user.

## LITE compliance

No polling (file-watch only), opt-in (default off — nothing is installed unless the
user clicks), reader runs only while the Support view is visible, reads one tiny
file SSH Lite owns (never the tools' transcripts), and is fully reversible from the
same panel.

**Artifact cleanup.** The staged script (`<globalStorage>/hooks/npc-beacon.js`) and
beacon (`<globalStorage>/npc-ai-hook-beacon.json`) are **persistent** while hooks
are installed — `HousekeepingService` only sweeps `sshlite-diff-*` temp dirs under
`os.tmpdir()`, never globalStorage, so it can't accidentally delete the script and
break a live hook. Conversely, because the housekeeper won't reach them, **uninstall
cleans up its own artifacts**: once nothing is left installed, `uninstallAll()`
deletes the staged script + beacon. The per-tool config writes leave a one-time
`<file>.sshlite.bak` backup in the tool's own config dir (intentional safety net).

**Extension uninstall cleanup + reinstall.** `package.json` `scripts["vscode:uninstall"]`
runs `out/uninstall.js` (`src/uninstall.ts`) in **plain Node.js** after the extension is
fully uninstalled and VS Code restarts — the `vscode` module does not exist there.

**Install registry** (`src/services/InstallRegistry.ts`, `~/.ssh-lite/installs.json`):
`activate()` calls `recordInstall(home, extensionPath, globalStorageUri.fsPath)`, so the
uninstall script can map its own extension folder (`..` of `out/`) to THIS editor's
globalStorage. Entries whose extension folder is gone (old version after an update)
are pruned; the file is written only when something changed.

Uninstall flow (`runUninstallCleanup`):

1. `lookupStorage()` → this editor's storage; `purgeHooksForUninstall(home, { storageDir })`
   → `HookInstallerService.purgeAll({ ownStorageDir })`:
   - Removes our marker entry from every known tool config — no presence gate (the
     tool's home dir may be gone while its config is not). Unparseable configs stay
     untouched and are reported as failed.
   - A hook whose staged script lives in **another editor's** storage (Code vs
     Code - Insiders vs Cursor) is left alone — that editor still uses it.
   - Deletes the staged script / beacon (`hooks/npc-beacon.js`,
     `npc-ai-hook-beacon.json` + `.tmp`) and the empty `hooks/` folder
     (non-recursive) — **even when no hook is left** (user removed it by hand).
     Paths parsed from hook commands are accepted only under a `hybr8.ssh-lite`
     path segment with our exact file names.
   - If a parseable config could not be rewritten (read-only, locked), staged files
     are **kept** so the leftover hook keeps exiting 0 instead of erroring per prompt.
   - Backups: the removal write would back up the *hooked* config over
     `.sshlite.bak`, so a clean prior backup is snapshotted and restored; a backup
     still containing our marker is deleted (restoring it would re-add a dead hook).
   - Without a registry entry (never activated with this version) it falls back to
     removing every SSH Lite hook by marker.
2. `markUninstalled()` drops the install entry and leaves a **tombstone** (the storage path).
   If the purge removed a hook, it also tombstones every **other** recorded install
   (`rearmOthers`): hooks are shared per AI tool (dedup by marker), so SSH Lite in
   Code - Insiders / Cursor may have relied on the removed hook while its own
   `npcAutoHooksDone` says "done" — re-arming makes it set its own hook up again.

Registry keys use the **realpath** of the extension folder: the uninstall process's
`__dirname` is resolved through symlinks / junctions, `context.extensionPath` is not.
Temp writes use a per-process name (`installs.json.<pid>.tmp`).

Reinstall: VS Code may keep `globalState` across an uninstall, which would keep the
one-time `npcAutoHooksDone` flag and stop auto-setup. On activation `recordInstall()`
consumes the tombstone and returns `reinstalled: true`; `activate()` then clears
`npcAutoHooksDone`, so opening the NPC panel sets hooks up again exactly like a first
install. Only hook state is reset — connections, credentials, and settings are kept.

- Logging is a lazy `require('../utils/diagnosticLog')` inside `HookInstallerService` —
  a no-op in the uninstall process. Never import a `vscode`-dependent module
  (directly or transitively) from `src/uninstall.ts`.
- `scripts/verify-package.js` requires `extension/out/uninstall.js` in the VSIX.
- Real VS Code end-to-end test (Docker Linux + portable Windows): [`testing/vscode-uninstall-e2e.md`](../testing/vscode-uninstall-e2e.md).
- The extension installs **no** AI skills — hooks are its only footprint in AI tool dirs.
