# SSH Lite -- Lightweight VS Code SSH Extension

VS Code extension for SSH file browsing, editing, terminals, and search — **without** installing a VS Code server on remote machines. Built with TypeScript, ssh2, and VS Code Extension API.

For detailed architecture, design decisions, and deep documentation see the `.adn/` folder.

---

## Quick Commands

```bash
npm run compile                          # Compile TypeScript
npm run watch                            # Watch mode
npx jest --no-coverage                   # Run all unit tests (823 tests)
npx jest -- HostTreeProvider             # Run specific file
npx jest --testPathPattern=docker        # Docker integration tests
npx vsce package                         # Create .vsix
```

---

## Project Structure

```
src/
  extension.ts                    # Main entry, commands, wiring
  types.ts                        # Core interfaces
  connection/
    ConnectionManager.ts          # Multi-connection, auto-reconnect
    SSHConnection.ts              # SSH/SFTP operations
  services/
    FileService.ts                # File ops, auto-sync, backups
    HostService.ts                # SSH config parsing
    CredentialService.ts          # Credentials + pinned folders
    TerminalService.ts            # SSH terminals
    PortForwardService.ts         # Port forwarding
    AuditService.ts               # Audit logging
    ActivityService.ts            # Activity tracking
    ServerMonitorService.ts       # Server diagnostics
    CommandGuard.ts               # Activity tracking middleware
    + FolderHistoryService, ProgressiveDownloadManager, PriorityQueueService
  providers/
    HostTreeProvider.ts           # SSH hosts tree
    FileTreeProvider.ts           # Remote files tree
    FileDecorationProvider.ts     # Badges (↑ ✗ M)
    ActivityTreeProvider.ts       # Activity panel
    PortForwardTreeProvider.ts    # Port forwards tree
  webviews/
    SearchPanel.ts                # Cross-server search
.adn/                             # Deep documentation (project DNA)
```

---

## LITE Principles (CRITICAL)

**IMPORTANT: These rules apply to ALL prompts (agents, skills, regular chat).**

SSH Lite must be **LITE** - minimize server resources and UI complexity.

| Rule | Bad | Good |
|------|-----|------|
| No auto server commands | `find` on every keystroke | User clicks "Search" button |
| No polling by default | Auto-refresh enabled | User enables in settings |
| Cache aggressively | Preload 5 subdirs | Load on user expand |
| Single connection | Multiple SSH sessions | Reuse connection |
| Debounce actions | Immediate server call | 300ms+ debounce |

**Before implementing, ask:**
- Does this run server commands automatically? → Make it user-triggered
- Does this poll the server? → Make it opt-in, default OFF
- Does this preload data? → Make it lazy-load on demand

---

## Code Quality

- Remove unused files/code - no dead code
- Use `log()` for output channel logging
- Don't log in loops - log summaries
- Keep source clean and consolidated
- Use `normalizeLocalPath()` for all local file path Map lookups
- Go through `CommandGuard` for significant SSH operations
- Use stable tree item `id` (never include dynamic state)

---

## Testing

- Run `npx jest --no-coverage` before committing
- Add tests for new functionality
- Use shared mocks from `src/__mocks__/testHelpers.ts`
- Reset singletons in `beforeEach`: `(Service as any)._instance = undefined`

---

## Documentation (.adn/)

The `.adn/` directory is the **project DNA** — it contains the authoritative documentation for this project. Any AI assistant or developer can fully understand, maintain, and extend SSH Lite from these docs.

**IMPORTANT: Keep `.adn/` in sync with code changes.**
After any code change that affects behaviour, architecture, or contracts, update the `.adn/` docs:

### When to update existing files

| Change type | Update these `.adn/` files |
|---|---|
| New/changed service | `architecture/overview.md`, `architecture/project-structure.md` |
| New/changed command | `configuration/commands-reference.md`, `architecture/project-structure.md` |
| New tree item type / contextValue | `features/tree-providers.md`, `configuration/commands-reference.md` |
| Settings added/removed/changed | `configuration/settings-reference.md` |
| Connection logic change | `features/connection-management.md`, `flow/connection-flow.md` |
| File operations change | `features/file-operations.md`, `flow/file-save-flow.md` |
| Search/filter change | `features/search-system.md`, `flow/search-flow.md` |
| Terminal/port forward change | `features/terminal-port-forwarding.md` |
| Activity/audit change | `features/activity-audit.md` |
| Tree provider/decoration change | `features/tree-providers.md` |
| Test pattern/infrastructure change | `testing/testing-strategy.md` |
| Startup/activation flow change | `flow/extension-activation.md` |
| Type/interface change | `architecture/types-reference.md` |

### When to create new files / folders

If a change introduces a **new major concept or subsystem** that doesn't fit into an existing doc, create a new `.md` file under `.adn/`. Examples:

- Adding a new webview panel → create `.adn/features/my-panel.md`
- Adding a new integration type → create `.adn/features/my-integration.md`

**Guidelines for new `.adn/` files:**
- Place in the most relevant existing folder first; only create a new folder when none fits
- Follow the same markdown style as existing docs (headings, tables, code blocks)
- Update `.adn/README.md` to include the new file in the folder map

---

## Self-Sustaining Growth

This project is designed to grow itself. The `.adn/growth/` folder contains everything needed to extend SSH Lite consistently:

- **`.adn/growth/playbooks.md`** — Step-by-step recipes for adding commands, services, tree views, settings, decorations, webviews, and features
- **`.adn/growth/coding-conventions.md`** — Singleton, EventEmitter, debounce, path normalization, error handling, and naming patterns
- **`.adn/growth/self-maintenance.md`** — Post-change verification checklist, consistency rules, rename/remove procedures

### Workflow for Any Change

1. **Before coding**: Read the relevant playbook in `.adn/growth/playbooks.md`
2. **While coding**: Follow patterns in `.adn/growth/coding-conventions.md`
3. **After coding**: Run the checklist in `.adn/growth/self-maintenance.md`:
   - `npm run compile` — 0 errors
   - `npx jest --no-coverage` — all tests pass
   - Update `.adn/` docs (this file's mapping table above)
4. **If adding a major new concept**: Create new `.adn/` file, update `README.md` folder map

---

## Release Notes

### v0.4.0 — Project DNA documentation system

- **`.adn/` documentation system**: 18-file "project DNA" covering architecture, features, flows, configuration, testing, and growth playbooks
- **CLAUDE.md rewrite**: Entry point with mapping table linking code changes to documentation files
- **Self-sustaining growth**: Playbooks for adding commands, services, tree views, settings, webviews, and features
- **Coding conventions**: Documented singleton, EventEmitter, debounce, path normalization, and error handling patterns
- **Self-maintenance**: Post-change verification checklist, consistency rules, rename/remove procedures
- **Retired `.claude-workflow.md`**: All content migrated into `.adn/` files

### v0.3.0

- Fix "Invalid username" connection failure, reconnect loop on invalid config
- Host config validation, improved connection logging
- Fix search multi-folder, sort by checked

### v0.2.5

- Remove User from hosts panel (saved + SSH config)
