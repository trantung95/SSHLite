# Self-Maintenance Guide

Rules and checklists for keeping SSH Lite consistent and healthy as it grows. Every AI assistant or developer must follow these after making changes.

---

## Post-Change Verification Checklist

Run after **every** code change:

- [ ] `npm run compile` — **0 errors**
- [ ] `npx jest --no-coverage` — **all tests pass**
- [ ] New public methods have corresponding test(s)
- [ ] `.adn/` docs updated if the change affected architecture, features, config, or behavior (see mapping in `CLAUDE.md`)
- [ ] No `console.log` statements — use `log()` instead
- [ ] LITE principles respected (no auto server commands, debounced actions, etc.)

---

## Consistency Rules

### 1. Singleton Pattern

Every service class MUST use `getInstance()`:
- Private constructor
- Static `_instance` field
- Public `getInstance()` method

If a class exists as a singleton, it must be accessed via `getInstance()` everywhere — never `new`.

### 2. Context Value ↔ package.json Parity

Every `contextValue` set on a tree item MUST have a matching `when` clause in `package.json` menus. If you add a new context value:
- Add it to the tree item class
- Add menu items in `package.json` with matching `when` clause
- Document in `.adn/configuration/commands-reference.md`

### 3. Settings ↔ package.json Parity

Every `config.get('sshLite.xxx')` call MUST have a corresponding entry in `package.json` `contributes.configuration`. If you add a new setting:
- Add to `package.json` with type, default, description
- Document in `.adn/configuration/settings-reference.md`

### 4. Command ↔ package.json Parity

Every `registerCommand('sshLite.xxx')` call MUST have a corresponding entry in `package.json` `contributes.commands`. If you add a new command:
- Add to `package.json` commands array
- Add to menus array (if needed)
- Document in `.adn/configuration/commands-reference.md`

### 5. Event Emitter Subscriptions

Every EventEmitter declared in a service should have subscriber(s) wired up in `extension.ts`. If you add a new event:
- Declare `_on*` / `on*` pair in service
- Wire up in `extension.ts` (usually refreshing a tree provider)
- Document in the relevant `.adn/features/*.md` events table

### 6. Test Coverage Parity

For every source file, there should be a matching test file:

| Source | Test |
|--------|------|
| `src/services/MyService.ts` | `src/services/MyService.test.ts` |
| `src/providers/MyProvider.ts` | `src/providers/MyProvider.test.ts` |
| `src/connection/MyConnection.ts` | `src/connection/MyConnection.test.ts` |

---

## When Renaming Things

### Renaming a Command

1. `package.json` — command ID in `contributes.commands`
2. `package.json` — all `contributes.menus` references
3. `package.json` — keybindings (if any)
4. `src/extension.ts` — `registerCommand()` call
5. Tests that reference the command
6. `.adn/configuration/commands-reference.md`

### Renaming a Service

1. Source file name
2. Class name and `_instance` type
3. All `getInstance()` callers
4. `src/extension.ts` — variable name
5. Tests — file name, class reference, singleton reset
6. `.adn/architecture/project-structure.md`
7. `.adn/architecture/overview.md` (if in dependency map)
8. Relevant `.adn/features/*.md` file

### Renaming a Tree Item Type

1. Tree item class name
2. `contextValue` string
3. `package.json` — `when` clauses that match the old contextValue
4. Tests
5. `.adn/configuration/commands-reference.md` — context value reference
6. `.adn/features/tree-providers.md`

### Renaming a Setting

1. `package.json` — property key in `contributes.configuration`
2. All `config.get('sshLite.oldName')` calls
3. `.adn/configuration/settings-reference.md`
4. `README.md` (if documented there)

---

## When Removing Things

### Removing a Service

1. Delete the source file
2. Delete the test file
3. Remove `getInstance()` calls from `extension.ts` and other services
4. Remove event subscriptions in `extension.ts`
5. Remove from `.adn/architecture/project-structure.md`
6. Remove from `.adn/architecture/overview.md` dependency map
7. Remove from relevant `.adn/features/*.md`
8. **Verify `npm run compile`** — any remaining references cause errors

### Removing a Command

1. Remove from `package.json` `contributes.commands`
2. Remove from `package.json` `contributes.menus`
3. Remove from `package.json` `contributes.keybindings` (if any)
4. Remove `registerCommand()` from `extension.ts`
5. Remove tests
6. Update `.adn/configuration/commands-reference.md`

### Removing a Tree View

1. Remove from `package.json` `contributes.views`
2. Remove `createTreeView()` from `extension.ts`
3. Remove provider class and test file
4. Remove event subscriptions
5. Update `.adn/` docs

### Removing a Setting

1. Remove from `package.json` `contributes.configuration`
2. Remove all `config.get()` calls for the setting
3. Update `.adn/configuration/settings-reference.md`

---

## Documentation Self-Check

Before considering any significant change complete, verify:

1. **`.adn/architecture/project-structure.md`** — Does the file listing match reality?
2. **`.adn/configuration/settings-reference.md`** — Do all settings match `package.json`?
3. **`.adn/configuration/commands-reference.md`** — Are all commands listed?
4. **`.adn/README.md`** — Does the folder map include any new files?
5. **`CLAUDE.md`** — Does the mapping table cover the change type?

---

## Preventing Common Mistakes

| Mistake | Prevention |
|---------|-----------|
| Path comparison fails on Windows | Always use `normalizeLocalPath()` for Map key lookups |
| Tree expansion state lost | Never include dynamic state in tree item `id` |
| Activity panel doesn't show operation | Use `CommandGuard` for significant SSH operations |
| Menu items don't appear | Check `contextValue` matches `when` clause regex in `package.json` |
| Credential operations fail silently | Ensure `credentialService.initialize(context)` called before any connection |
| Host key verification fails | Ensure `setGlobalState(context.globalState)` called on activation |
| Upload badge stuck | Ensure both success and failure paths remove from `uploadingFiles` Set |
| Singleton state leaks between tests | Reset `(Service as any)._instance = undefined` in `beforeEach` |
| Auto-reconnect hammers server | Check `isNonRecoverableError()` for auth failures |
| Console.log in production | Use `log()` from extension.ts output channel |

---

## Growth Health Indicators

Signs the project is healthy:
- `npm run compile` — 0 errors
- `npx jest --no-coverage` — all 823+ tests pass
- Every new feature has tests
- `.adn/` docs match the code
- Commands in `package.json` match registered handlers
- Settings in `package.json` match code reads
- Context values match menu `when` clauses
- No `console.log` in production code
- LITE principles respected in all features
