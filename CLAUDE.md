# SSH Lite — Lightweight VS Code SSH Extension

VS Code extension for SSH file browsing, editing, terminals, search — **without** VS Code server on remote. TypeScript, ssh2, VS Code Extension API. Deep docs in `.adn/`.

## Quick Commands

```bash
npm run compile                          # Compile TypeScript
npm run watch                            # Watch mode
npx jest --no-coverage                   # All unit tests (~1127, ~13s)
npx jest -- HostTreeProvider             # Specific file
npx jest --testPathPattern=docker        # Docker integration tests
npm run test:chaos                       # Chaos discovery (quick, 3-5 min)
npm run test:chaos:deep                  # Chaos discovery (deep, 10+ min)
npx vsce package                         # Create .vsix
```

## Project Structure

```
src/
  extension.ts          # Entry, commands, wiring        types.ts              # Core interfaces
  connection/           # ConnectionManager, SSHConnection (SSH/SFTP ops)
  services/             # FileService, HostService, CredentialService, TerminalService,
                        # PortForwardService, AuditService, ActivityService, ServerMonitorService,
                        # CommandGuard, FolderHistoryService, ProgressiveDownloadManager, PriorityQueueService
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
