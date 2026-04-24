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

When adding or removing a command, update the count in **all 5 places** (currently **98**):

| File | Location |
|------|----------|
| `README.md` | line ~175: `all 98 commands` and line ~217: `All 98 commands` |
| `.adn/configuration/commands-reference.md` | line 3: `All 98 commands` |
| `.adn/flow/extension-activation.md` | line ~55: `All 98 commands` |
| `.adn/README.md` | line ~43: `All 98 commands` |
| `docs/COMMANDS.md` | **AUTO** — run `npm run docs:commands` |

Get current count: `node -e "const p=require('./package.json'); console.log(p.contributes.commands.length)"`

## Version Bump — All Locations (CRITICAL)

When bumping the version (e.g. "update to 0.8.0"), change **in this order**:

| Step | File | What |
|------|------|------|
| 1 | `package.json` line 5 | `"version": "X.X.X"` |
| 2 | `README.md` line 3 | `![Version](https://img.shields.io/badge/version-X.X.X-blue)` |
| 3 | run `npm run docs:commands` | auto-updates `docs/COMMANDS.md` |
| 4 | `README.md` Release Notes | prepend new `### X.X.X —` section |
| 5 | `.adn/CHANGELOG.md` | prepend new `## vX.X.X —` section |

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
6. **Codex will review your output once you are done** — self-verify rigorously before reporting complete

## Code Quality & Performance

- Efficient algorithms/data structures; avoid unnecessary iterations/allocations/async overhead
- Safety guards on `while` loops (parent===p break, max iteration); prefer lazy eval; cache I/O
- Remove unused code; use `log()` for output channel; don't log in loops
- `normalizeLocalPath()` for all local file path Map lookups
- `CommandGuard` for significant SSH operations
- Stable tree item `id` (never include dynamic state)

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

Full changelog: `.adn/CHANGELOG.md`
