# Real VS Code uninstall / reinstall end-to-end test

Proves the `vscode:uninstall` hook (`src/uninstall.ts`) in a **real VS Code**, not
mocks: VS Code itself runs the hook. The unit tests cover the logic; only this test
covers VS Code's side (does it call the script, when, with which environment).
Feature design: [`features/ai-hooks.md`](../features/ai-hooks.md) "Extension
uninstall cleanup + reinstall".

## Run

```bash
npm run test:vscode-uninstall                                   # Linux leg (Docker)
node scripts/test-vscode-uninstall.js --windows                 # Windows leg (Windows host)
node scripts/test-vscode-uninstall.js [--windows] --keep        # keep everything for debugging
node scripts/test-vscode-uninstall.js [--windows] --down        # teardown only
```

Both legs **set up their own fixtures and always tear everything down**, whether
the test passes or fails (`--keep` is the only exception). Needs Docker Desktop
(Linux containers) for the Linux leg and network access to download VS Code.
Takes a few minutes (image build + VS Code download on the first run).

## What it does (both legs)

| Step | Action | Checks (`test-docker/vscode-uninstall/e2e.js`) |
|------|--------|-----------------------------------------------|
| 0 | Fake home: create `~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`, `~/.copilot`; `~/.claude/settings.json` holds a user's own hook + `theme` | — |
| 1 | `code --install-extension ssh-lite.vsix`, launch VS Code, wait for `~/.ssh-lite/installs.json`, close | `activated`: one install recorded, storage = `globalStorage/hybr8.ssh-lite` |
| 2 | **Fixture** = what the NPC panel auto-setup leaves behind: the installed extension's own `HookInstallerService.installAll()` + `npcAutoHooksDone = true` written into `state.vscdb` | `seed`: all 5 configs hooked, script staged, hook command exits 0 and writes the beacon |
| 3 | `code --uninstall-extension hybr8.ssh-lite`, launch VS Code (it runs `vscode:uninstall` on this start), wait for the tombstone, close | `after-uninstall`: no config references `npc-beacon.js`, Copilot file gone, user hook + settings kept, no backup holds the dead hook, script / `hooks/` / beacon deleted, install entry dropped, tombstone left |
| 4 | Reinstall, launch, wait until the tombstone is consumed, close | `after-reinstall`: same storage recorded, tombstone consumed, `npcAutoHooksDone` cleared (the NPC panel sets hooks up again like a first install) |

VS Code is always **closed** before a check runs: `state.vscdb` is SQLite and the
checks read / write it with `node:sqlite` (Node.js 22.13+).

## Linux leg (Docker)

- `test-docker/docker-compose.vscode-uninstall.yml`, image built from
  `test-docker/vscode-uninstall/Dockerfile.linux`: `node:22-bookworm` + Xvfb
  (X virtual framebuffer) + the latest stable VS Code tarball
  (`--build-arg VSCODE_BUILD=<version>` pins one). Runs as user `node`: the
  container's home is the fake home.
- `scripts/test-vscode-uninstall.js` packages the VSIX into
  `test-docker/vscode-uninstall/.artifacts/` (gitignored, excluded from the build
  context), builds, runs `run-linux.sh` once, then
  `docker compose down --volumes --rmi all --remove-orphans` and deletes
  `.artifacts/`.

- The `node:22-bookworm` **base** image is kept as a pull cache (shared with
  other images); remove it with `docker rmi node:22-bookworm` if wanted.
- apt in the image uses IPv4 without HTTP pipelining: behind some VPNs Docker
  Desktop otherwise stalls ~30 s per request.

## Windows leg (host, portable VS Code)

- Not a Windows container: that needs Docker Desktop switched to Windows
  containers (stops managing the Linux ones), a multi-gigabyte image, and
  Electron needs a desktop session that Server Core containers lack.
- Instead: the VS Code **zip** build is extracted into
  `%TEMP%\sshlite-vscode-uninstall-e2e\vscode` with a `data/` folder (portable
  mode: user data + extensions stay inside it), launched with `USERPROFILE` /
  `HOME` pointed at `...\home`. The real VS Code, real extensions and the real
  `~/.claude` etc. are never touched.
- Teardown kills every process whose executable is under that folder, then
  deletes the whole `%TEMP%\sshlite-vscode-uninstall-e2e` folder.

## Last verified

2026-11-19, VS Code stable 1.146: both legs passed all 22 checks. Both showed
that VS Code runs `vscode:uninstall` on the first start **after**
`code --uninstall-extension` (not during the command itself).

## When to run

After any change to `src/uninstall.ts`, `src/services/InstallRegistry.ts`, the
purge path in `HookInstallerService`, the `vscode:uninstall` script in
`package.json`, or the install-registry step in `activate()`. Not part of
`npm test` or CI (needs a real VS Code and minutes of runtime).
