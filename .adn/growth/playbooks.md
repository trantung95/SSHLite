# Growth Playbooks

Step-by-step recipes for extending SSH Lite. After completing any playbook, update `.adn/` docs (see `CLAUDE.md` mapping table).

---

## Playbook 1: Add a New Command

**Modify**: `package.json` (commands + menus), `src/extension.ts` (register handler)
**Create**: Test in `src/extension.test.ts` or dedicated file

**Steps**:
1. Add command to `package.json` `contributes.commands` (`sshLite.myCommand`, title, category, icon)
2. Add menu placement in `contributes.menus` with `when` clause matching `contextValue`
3. Register handler in `extension.ts` — handle both tree item (context menu) and `undefined` (palette) invocation. Use `selectConnection()` for palette fallback
4. Write test
5. Update `.adn/configuration/commands-reference.md`

---

## Playbook 2: Add a New Service

**Create**: `src/services/MyService.ts`, `src/services/MyService.test.ts`
**Modify**: `src/extension.ts` (getInstance + wire events)

**Steps**:
1. Singleton pattern: private constructor, `_instance`, `getInstance()`. Add `initialize(context)` if needs ExtensionContext. Add `dispose()` for cleanup. EventEmitter: private `_on*`, public `on*`
2. Wire in `extension.ts`: `getInstance()`, `initialize()` if needed, subscribe to events
3. Write tests with singleton reset in `beforeEach`
4. Update `.adn/architecture/overview.md`, `project-structure.md`

---

## Playbook 3: Add a New Tree View

**Create**: `src/providers/MyTreeProvider.ts`, test file
**Modify**: `package.json` (views), `src/extension.ts` (register)

**Steps**:
1. Create `TreeDataProvider<MyTreeItem>` with `_onDidChangeTreeData` emitter, `getTreeItem()`, `getChildren()`, `refresh()`
2. Tree items: stable `id` (no dynamic state), set `contextValue` for menu matching
3. Register in `package.json` `contributes.views` (`sshLite.myView`)
4. Register in `extension.ts` via `createTreeView()` — set `showCollapseAll`, `dragAndDropController`, `canSelectMany` as needed
5. Add context menu items in `package.json` menus
6. Write tests, update `.adn/features/tree-providers.md`, `commands-reference.md`

---

## Playbook 4: Add a New Setting

**Modify**: `package.json` (`contributes.configuration`), code that reads it

**Steps**:
1. Add to `package.json` with type, default, min/max, description
2. Read via `vscode.workspace.getConfiguration('sshLite').get<T>('key', default)`
3. Update `.adn/configuration/settings-reference.md`

---

## Playbook 5: Add a New Tree Item Type

**Modify**: Provider file, `package.json` (when clauses)

**Steps**:
1. Create class extending `vscode.TreeItem` — stable `id`, set `contextValue`, `iconPath`
2. Add menu items in `package.json` with `when` clause matching `contextValue`
3. Update `.adn/configuration/commands-reference.md`

---

## Playbook 6: Add a New Webview

**Create**: `src/webviews/MyPanel.ts`
**Modify**: `src/extension.ts`

**Steps**:
1. Singleton panel with `show()`: create `WebviewPanel` if needed, `enableScripts: true`, `retainContextWhenHidden: true`
2. HTML generated inline (project convention — no separate HTML files)
3. Communication: extension ↔ webview via `postMessage` / `onDidReceiveMessage`
4. Handle `onDidDispose` to clear panel reference
5. Write tests, update `.adn/` docs

---

## Playbook 7: Add a New File Decoration

**Modify**: `src/providers/FileDecorationProvider.ts`, relevant service for state tracking

**Steps**:
1. Add state tracking in service: `Set<string>` + `isMyState(path)` using `normalizeLocalPath()`
2. Add decoration in `FileDecorationProvider.provideFileDecoration()`: badge, color, tooltip
3. Fire `_onDidChangeFileDecorations` when state changes
4. Update `.adn/features/tree-providers.md` badge table

---

## Playbook 8: Add a New Feature (Composite)

1. **LITE check first**: No auto commands? No default polling? Lazy-load? No data loss?
2. **Plan components**: Which playbooks needed (service, commands, tree items, etc.)?
3. **Implement in order**: Service → Provider → Commands → Tests → Documentation
4. **LITE checklist**: user-triggered, no polling, debounce 300ms+, single connection reuse, cache, `log()` not in loops
