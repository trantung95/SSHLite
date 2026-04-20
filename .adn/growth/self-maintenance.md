# Self-Maintenance Guide

Rules and checklists for keeping SSH Lite consistent.

## Post-Change Checklist

- [ ] `npm run compile` — 0 errors
- [ ] `npx jest --no-coverage` — all pass
- [ ] New public methods have tests
- [ ] `.adn/` docs updated (see `CLAUDE.md` mapping)
- [ ] No `console.log` — use `log()`
- [ ] LITE principles respected
- [ ] Backward compatibility maintained

## Consistency Rules

1. **Singleton**: Every service uses `getInstance()`, never `new`. Private constructor + `_instance`.
2. **contextValue ↔ package.json**: Every contextValue must have matching `when` clause in menus. Document in `commands-reference.md`.
3. **Settings ↔ package.json**: Every `config.get('sshLite.xxx')` must exist in `contributes.configuration`. Document in `settings-reference.md`.
4. **Commands ↔ package.json**: Every `registerCommand('sshLite.xxx')` must exist in `contributes.commands`. Document in `commands-reference.md`.
5. **EventEmitter subscriptions**: Every service event should have subscriber(s) in `extension.ts`. Document in `features/*.md`.
6. **Test coverage**: Every source file should have matching `*.test.ts`.

## Rename Procedures

### Command
`package.json` (commands + menus + keybindings) → `extension.ts` (registerCommand) → tests → `commands-reference.md`

### Service
Source file → class name + `_instance` type → all `getInstance()` callers → `extension.ts` var → tests → `project-structure.md`, `overview.md`, `features/*.md`

### Tree Item Type
Class name → `contextValue` → `package.json` when clauses → tests → `commands-reference.md`, `tree-providers.md`

### Setting
`package.json` property key → all `config.get()` calls → `settings-reference.md`, `README.md`

## Remove Procedures

### Service
Delete source + test → remove `getInstance()` + event subscriptions from `extension.ts` → remove from `.adn/` → verify `npm run compile`

### Command
Remove from `package.json` (commands + menus + keybindings) → remove `registerCommand()` → remove tests → update `commands-reference.md`

### Tree View
Remove from `package.json` views → remove `createTreeView()` → delete provider + test → remove subscriptions → update `.adn/`

### Setting
Remove from `package.json` configuration → remove `config.get()` calls → update `settings-reference.md`

## Documentation Self-Check

Before completing significant changes:
1. `project-structure.md` — file listing matches reality?
2. `settings-reference.md` — all settings match `package.json`?
3. `commands-reference.md` — all commands listed?
4. `.adn/README.md` — folder map includes new files?

## Common Mistakes

| Mistake | Prevention |
|---------|-----------|
| Path comparison fails (Windows) | `normalizeLocalPath()` for Map keys |
| Tree expansion lost | No dynamic state in `id` |
| Activity panel missing op | Use `CommandGuard` |
| Menu items don't appear | `contextValue` matches `when` regex |
| Credentials fail silently | `credentialService.initialize(context)` first |
| Host key fails | `setGlobalState(context.globalState)` on activation |
| Upload badge stuck | Both success/failure paths remove from `uploadingFiles` |
| Singleton leaks in tests | Reset `_instance = undefined` in `beforeEach` |
| Auto-reconnect hammers server | Check `isNonRecoverableError()` |
| console.log in production | Use `log()` |
