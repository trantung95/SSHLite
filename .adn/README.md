# .adn - Project DNA

> **ADN** is the Vietnamese word for DNA — this folder encodes the project's complete genetic blueprint for self-sustaining growth.

This folder contains the complete documentation ("DNA") of **SSH Lite** -- a lightweight VS Code extension for SSH connections that works WITHOUT installing a VS Code server on remote machines.

## Purpose

The `.adn/` folder allows any AI assistant (or new developer) to fully understand, maintain, and extend this project without reading every source file. It captures architecture decisions, feature logic, data flows, configuration, and operational procedures.

## How to Use

1. **This file first** — then read `architecture/overview.md` for the big picture
2. **Understand features** — read files in `features/` for specific feature areas
3. **Navigate flows** — follow `flow/` docs to trace key operations step by step
4. **Get configuration** — see `configuration/` for all settings and commands
5. **Test strategy** — see `testing/` for test infrastructure and coverage approach
6. **Templates for growth** — read `growth/playbooks.md` for recipes, `growth/coding-conventions.md` for patterns, `growth/self-maintenance.md` for post-change verification

## Folder Map

```
.adn/
  README.md                              # This file
  architecture/
    overview.md                          # System architecture, layers, key decisions
    project-structure.md                 # Solution layout, all files by component
    types-reference.md                   # All interfaces and types (types.ts)
  features/
    connection-management.md             # ConnectionManager, SSHConnection, auto-reconnect
    file-operations.md                   # FileService, upload state machine, backups
    search-system.md                     # SearchPanel webview, cross-server search
    terminal-port-forwarding.md          # TerminalService, PortForwardService
    tree-providers.md                    # HostTreeProvider, FileTreeProvider, decorations
    activity-audit.md                    # ActivityService, AuditService, CommandGuard
  flow/
    extension-activation.md              # Startup sequence, init order, wiring
    file-save-flow.md                    # Ctrl+S -> debounce -> upload -> badge
    connection-flow.md                   # User click -> auth -> connect -> refresh
    search-flow.md                       # Search webview -> grep/find -> results
  configuration/
    settings-reference.md                # All sshLite.* settings with defaults
    commands-reference.md                # All 80+ commands, context values, when clauses
  testing/
    testing-strategy.md                  # Unit/Docker/MultiOS, mock architecture
    chaos-testing.md                     # Chaos bug discovery module + AI review checklist
  growth/
    playbooks.md                         # Step-by-step recipes for extending SSH Lite
    coding-conventions.md                # Singleton, EventEmitter, debounce patterns
    self-maintenance.md                  # Post-change checklist, consistency rules
```

## Conventions

- All file paths use forward slashes in documentation (even on Windows)
- Connection ID format: `${host}:${port}:${username}` (e.g., `192.168.1.100:22:root`)
- All services are singletons accessed via `getInstance()`
- LITE principle: minimize server resources and UI complexity (see `CLAUDE.md`)
