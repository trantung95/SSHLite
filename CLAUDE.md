# SSH Lite (SSH Tools) — Lightweight VS Code SSH Extension

VS Code extension for SSH file browsing, editing, terminals, search — **without** VS Code server on remote. TypeScript, ssh2, VS Code Extension API. Deep docs in `.adn/`.

## Quick Commands

```bash
npm run compile                          # Compile TypeScript
npm run watch                            # Watch mode
npx jest --no-coverage                   # All unit tests (~1325, ~13s)
npx jest -- HostTreeProvider             # Specific file
npx jest --testPathPattern=docker        # Docker integration tests
npm run test:chaos                       # Chaos discovery (quick, 3-5 min)
npm run test:chaos:deep                  # Chaos discovery (deep, 10+ min)
npx vsce package                         # Create .vsix
npm run docs:commands                    # Regenerate docs/COMMANDS.md from package.json
```

## Commands Count — All Locations (CRITICAL)

When adding or removing a command, update the count in **all 5 places** (currently **100**):

| File | Location |
|------|----------|
| `README.md` | line ~42: `**100 commands**` (Quick Start section) |
| `.adn/configuration/commands-reference.md` | line 3: `All 100 commands` |
| `.adn/flow/extension-activation.md` | line ~55: `All 100 commands` |
| `.adn/README.md` | line ~43: `All 100 commands` |
| `docs/COMMANDS.md` | **AUTO** — run `npm run docs:commands` |

Get current count: `node -e "const p=require('./package.json'); console.log(p.contributes.commands.length)"`

## Version Bump — All Locations (CRITICAL)

When bumping the version (e.g. "update to 0.8.0"), change **in this order**:

| Step | File | What |
|------|------|------|
| 1 | `package.json` line 5 | `"version": "X.X.X"` |
| 2 | `README.md` version badge | **No manual edit** — the badge is `visual-studio-marketplace/v/hybr8.ssh-lite` (dynamic, auto-fetched from Marketplace after publish). Skip this step. |
| 3 | run `npm run docs:commands` | auto-updates `docs/COMMANDS.md` |
| 4 | `README.md` Release Notes | prepend new `**X.X.X** —` section, then **trim the section to keep only the last 2 versions** — older entries already live in `.adn/CHANGELOG.md` via the `[Full changelog]` link |
| 5 | `.adn/CHANGELOG.md` | prepend new `## vX.X.X —` section (this is the full archive — never trim) |

**Why trim README**: the Marketplace listing renders README. A long, accreting Release Notes section pushes donate / license / features below the fold and makes the page look stale. Keep README = last 2 versions + `[Full changelog]` link; keep `.adn/CHANGELOG.md` = full history.

`package-lock.json` and `docs/superpowers/specs/` are **never** touched manually.

## Documentation Auto-Update (CRITICAL)

`docs/COMMANDS.md` is **auto-generated** from `package.json contributes.commands`. A Claude Code hook regenerates it automatically whenever `package.json` is saved.

**Manual regeneration:** `npm run docs:commands`

**When you must run it manually:**
- After adding, renaming, or removing a command in `package.json`
- After changing command titles, categories, or keybindings
- After any change to `contributes.menus` or `contributes.keybindings`

The hook at `.claude/settings.json` handles automatic regeneration during AI-assisted edits. For manual edits outside Claude Code, run `npm run docs:commands` before committing.

## Project Structure

```
src/
  extension.ts          # Entry, commands, wiring        types.ts              # Core interfaces
  connection/           # ConnectionManager, SSHConnection (SSH/SFTP ops)
  services/             # FileService, HostService, CredentialService, TerminalService,
                        # PortForwardService, AuditService, ActivityService, ServerMonitorService,
                        # CommandGuard, FolderHistoryService, ProgressiveDownloadManager, PriorityQueueService,
                        # RemoteClipboardService (SSH copy/cut/paste state),
                        # SnippetService, SshKeyService, SystemToolsService, RemoteDiffService (SSH Tools suite)
  commands/             # SSH Tools command handlers: processAndService, envAndCron, snippet,
                        # batchAndScript, key, diff (registered via registerSshToolsCommands())
  providers/            # HostTreeProvider, FileTreeProvider, FileDecorationProvider,
                        # ActivityTreeProvider, PortForwardTreeProvider
  webviews/             # SearchPanel (cross-server search)
.adn/                   # Deep documentation (project DNA)
```

## LITE Principles (CRITICAL)

**LITE = Lightweight, Intentional, Transparent, Efficient. Never sacrifice data correctness.**

- No auto server commands → user-triggered only
- No polling by default → opt-in, default OFF
- No preloading → lazy-load on demand
- Cache aggressively, reuse single connection, debounce 300ms+
- True data, no missing → wait for all results, never truncate/filter/lose data

## AI Behavior (CRITICAL)

1. **Plan first, code later.** Wrong mid-way? Stop, re-plan
2. **Delegate hard tasks to sub-agents.** Keep main context clean
3. **Self-improvement loop.** Record lessons to `.adn/lessons.md`
4. **Prove it works.** Run tests, check logs — not done until verified
5. **Self-fix bugs.** Check logs, find root cause, fix it
6. **Repro on a real local SSH server (docker), not mocks**, whenever a bug touches ssh2 / sftp / event-loop / large-file paths. Start with `docker compose -f test-docker/docker-compose.yml up -d ssh-server-1`. Mocks confirm code shape, not crash behaviour under real crypto load.
7. **Codex will review your output once you are done** — self-verify rigorously before reporting complete

## Code Quality & Performance

- Efficient algorithms/data structures; avoid unnecessary iterations/allocations/async overhead
- Safety guards on `while` loops (parent===p break, max iteration); prefer lazy eval; cache I/O
- Remove unused code; use `log()` for output channel; don't log in loops
- `normalizeLocalPath()` for all local file path Map lookups
- `CommandGuard` for significant SSH operations
- Stable tree item `id` (never include dynamic state)

## Tree Inline Icon Order (CRITICAL)

**Rule**: An icon that appears on multiple `viewItem` rows MUST occupy the same `inline@N` slot on every row it appears on. "Same relative slot" is not enough — visual position must match across rows. When a row lacks one of the canonical icons, leave that slot empty rather than re-numbering downstream icons.

**Canonical inline slots for `sshLite.fileExplorer` rows** (search/filter first, then row-specific actions):

| Slot | Connection | Folder | File |
|------|------------|--------|------|
| `inline@1` | `searchInScope` | `searchInScope` | `searchInScope` |
| `inline@2` | `filterFileNames` / `clearFilenameFilter` | `filterFileNames` / `clearFilenameFilter` | `openFile` |
| `inline@3` | `disconnect` | `openTerminalHere` | `openTerminalHere` |
| `inline@4` | `openTerminal` | `refreshItem` | `refreshItem` |
| `inline@5` | `monitor` | — | — |

**Audit**: when adding/moving a `view/item/context` entry in `package.json`, grep for every `when` clause that targets the same command and confirm `group: inline@N` matches the canonical table above. Two entries with the same `inline@N` on the same viewItem is a collision — pick a new slot, don't double-stack.

## Testing

- Run `npx jest --no-coverage` before committing; add tests for new functionality
- Shared mocks: `src/__mocks__/testHelpers.ts`; reset singletons: `(Service as any)._instance = undefined`
- **Transpiler**: `@swc/jest` (not `ts-jest`) — 3-5x faster
- **Mock hoisting**: `@swc/jest` does NOT hoist `const`/`let` into `jest.mock()` factories. Use `var` for mock variables, **getters** for properties referencing them. Singleton mock instances via `mockReturnValue`, NOT `mockImplementation(() => ({...}))`

## Documentation (.adn/)

Keep `.adn/` in sync with code changes. Mapping:

- **Service/command/type change** → `architecture/overview.md`, `project-structure.md`, `types-reference.md`
- **Command/contextValue change** → `configuration/commands-reference.md`
- **Settings change** → `configuration/settings-reference.md`
- **Connection/file ops/search/terminal/port/activity** → matching `features/*.md`, `flow/*.md`
- **Tree provider/decoration** → `features/tree-providers.md`
- **Test/chaos change** → `testing/testing-strategy.md`, `testing/chaos-testing.md`
- **New major concept** → create new `.adn/` file, update `.adn/README.md`

**Growth playbooks**: `.adn/growth/playbooks.md` (recipes), `coding-conventions.md` (patterns), `self-maintenance.md` (checklist)

**Workflow**: Read playbook → follow conventions → run checklist (`compile` 0 errors, `jest` all pass, update `.adn/`) → if new concept, create `.adn/` file

## Chaos Testing

- **Weekly**: run `test:chaos:deep`, read `logs/chaos-results.jsonl`, follow `.adn/testing/chaos-testing.md` checklist
- **After logic changes**: run `test:chaos`, add scenarios for `coverage.methods_uncovered`
- **"Run chaos tests" means BOTH suites**: `npm run test:chaos:deep` AND `npm run test:windows-client` (added in v0.7.6 to cover Windows-client → Linux-server gaps that CI's Linux→Linux pass misses: drive-letter casing, CRLF, ssh-keygen.exe shell-out, Windows TCP stack). Treat any failure in either as part of the same report. The two suites share the multi-OS stack on ports 2210–2214

## Git Workflow

- **Solo project** — commit directly to `master`. No feature branches, no PRs, no worktree isolation. The `superpowers:using-git-worktrees` and similar branch-ceremony skills are overridden for this repo. Do NOT skip hooks, signing, or other safety mechanisms — only the branch ceremony.

## Diagnostic Logging Policy (CRITICAL)

Pervasive logging in every new code path — entry, exit, state transitions, error branches, decision points. Use `src/utils/diagnosticLog.ts`:

- `infoLog(scope, event, payload)` — always-on, for state transitions that matter on default installs (mount, unmount, view switch, error, batch boundaries)
- `diagLog(scope, event, payload)` — gated by `sshLite.diagnosticLogging` setting, for hot/loop paths; costless when off
- `scope`: stable kebab-case (`'search-renderer'`, `'result-store'`). `event`: verb-noun (`'append'`, `'view-switch'`). `payload`: object, never a formatted string (`fmtData` truncates fields to 200 chars)
- All logs land in the single **SSH Lite** Output channel (created in `extension.ts`). No second channel, no `console.log`, no DevTools-only logging — one collection point so users reporting issues do: enable diag → reproduce → View → Output → SSH Lite → copy
- Webview code posts `{type:'log', level, scope, event, payload}` back to the extension, which forwards via `infoLog`/`diagLog`. Webview logs MUST reach the same channel
- "Don't log in loops" still applies — for hot per-iteration paths, gate behind `diagLog` (not `infoLog`) and consider sampling

## AI Doc Auto-Sync (CRITICAL)

**End state: every AI doc related to this repo lives in this repo's committable tree.** Local-only paths (`~/.claude/CLAUDE.md`, auto-memory under `~/.claude/projects/d--CT-Repos-SSHLite/memory/`, vendor folders) are NOT shareable — teammates, CI, and other Claude installs never see them.

Canonical home rule: the **single source of truth** for any project-related AI doc is the committed file here (this `CLAUDE.md`, `.adn/`, `docs/`, `reference/`, or `lessons.md`). Local copies are at most one-line pointers back to the committed file.

Triggers (apply all):

1. **Session start**: scan `~/.claude/projects/d--CT-Repos-SSHLite/memory/` for any shareable item not yet in this repo. Propose migration before starting other work
2. **On read/recall**: when a local AI doc is loaded into context, mirror anything shareable into project docs in the same response
3. **On write**: after updating any local AI doc, mirror the change into the relevant project doc in the same response
4. **On project-doc edit**: when adding to this `CLAUDE.md` or `.adn/`, shrink the now-duplicate local memory to a one-line pointer to prevent drift

Classification when migrating:

- **Shareable** (conventions, workflows, ticket registry, infrastructure references, reusable lessons) → mirror to this repo, shrink local copy to a pointer
- **Personal** (per-user keyboard quirks, machine paths, shell aliases) → stay local, annotate `// LOCAL-ONLY: <reason>`
- **Credential-bearing** → split: usage/pattern → repo (token redacted to `<token>` placeholder + note "stored in `~/.claude/<vendor>/<file>.md`"); the actual token stays local-only

Do NOT keep a memory file local just because it has been local for a while. The local/repo split must be defensible by classification, not habit.

Full changelog: `.adn/CHANGELOG.md`
