# Growth Playbooks

Step-by-step recipes for extending SSH Lite. Each playbook follows established project patterns. After completing any playbook, update the relevant `.adn/` docs (see `CLAUDE.md` mapping table).

---

## Playbook 1: Add a New Command

**Files to modify:**
1. `package.json` — add to `contributes.commands` and optionally `contributes.menus`
2. `src/extension.ts` — register command handler

**Files to create (tests):**
1. `src/extension.test.ts` — add test for new command (or create dedicated test)

**Steps:**

1. **Add command to package.json**:
   ```json
   {
     "command": "sshLite.myNewCommand",
     "title": "My New Action",
     "category": "SSH Lite",
     "icon": "$(icon-name)"
   }
   ```

2. **Add menu placement** (if needed):
   ```json
   // In contributes.menus:
   "view/item/context": [
     {
       "command": "sshLite.myNewCommand",
       "when": "view == sshLite.fileExplorer && viewItem =~ /^folder/",
       "group": "1_operations"
     }
   ]
   ```

3. **Register handler in extension.ts**:
   ```typescript
   vscode.commands.registerCommand('sshLite.myNewCommand', async (item?: FileTreeItem) => {
     try {
       // Handle both tree context menu and command palette invocation
       let connection: SSHConnection;
       if (item instanceof FileTreeItem) {
         connection = item.connection;
       } else {
         const conn = await selectConnection(connectionManager);
         if (!conn) return;
         connection = conn;
       }

       // Perform operation
       await doSomething(connection);

       // Update UI
       fileTreeProvider.refresh();
       vscode.window.setStatusBarMessage('$(check) Done', 3000);
     } catch (error) {
       vscode.window.showErrorMessage(`Failed: ${(error as Error).message}`);
     }
   }),
   ```

4. **Write test**:
   ```typescript
   it('should handle myNewCommand', async () => {
     const mockConn = createMockConnection();
     // Test the handler logic
   });
   ```

5. **Update `.adn/configuration/commands-reference.md`** — add to relevant category

---

## Playbook 2: Add a New Service

**Files to create:**
1. `src/services/MyNewService.ts`

**Files to modify:**
1. `src/extension.ts` — get instance and wire up events

**Files to create (tests):**
1. `src/services/MyNewService.test.ts`

**Steps:**

1. **Create service with singleton pattern**:
   ```typescript
   import * as vscode from 'vscode';

   export class MyNewService {
     private static _instance: MyNewService;

     private readonly _onSomethingChanged = new vscode.EventEmitter<string>();
     public readonly onSomethingChanged = this._onSomethingChanged.event;

     private constructor() {
       // Private constructor
     }

     static getInstance(): MyNewService {
       if (!MyNewService._instance) {
         MyNewService._instance = new MyNewService();
       }
       return MyNewService._instance;
     }

     // If service needs ExtensionContext:
     initialize(context: vscode.ExtensionContext): void {
       // Store context, set up resources
     }

     dispose(): void {
       this._onSomethingChanged.dispose();
     }

     async doWork(connection: SSHConnection): Promise<void> {
       // Business logic
       this._onSomethingChanged.fire('result');
     }
   }
   ```

2. **Wire up in extension.ts**:
   ```typescript
   const myNewService = MyNewService.getInstance();
   // If needs initialization:
   myNewService.initialize(context);

   // Subscribe to events:
   myNewService.onSomethingChanged((result) => {
     fileTreeProvider.refresh();
   });
   ```

3. **Write tests**:
   ```typescript
   describe('MyNewService', () => {
     beforeEach(() => {
       (MyNewService as any)._instance = undefined;
     });

     it('should do work', async () => {
       const service = MyNewService.getInstance();
       const mockConn = createMockConnection();
       await service.doWork(mockConn);
       // assertions
     });
   });
   ```

4. **Update `.adn/`**:
   - `architecture/overview.md` — add to service dependency map
   - `architecture/project-structure.md` — add file listing

---

## Playbook 3: Add a New Tree View

**Files to create:**
1. `src/providers/MyTreeProvider.ts`

**Files to modify:**
1. `package.json` — add to `contributes.views`, `contributes.viewsContainers` (if new container)
2. `src/extension.ts` — create provider, register tree view, add commands

**Files to create (tests):**
1. `src/providers/MyTreeProvider.test.ts`

**Steps:**

1. **Create TreeDataProvider**:
   ```typescript
   import * as vscode from 'vscode';

   class MyTreeItem extends vscode.TreeItem {
     // Stable ID (never include dynamic state)
     constructor(public readonly data: MyData) {
       super(data.name, vscode.TreeItemCollapsibleState.None);
       this.id = `myItem:${data.id}`;  // STABLE
       this.contextValue = 'myItemType';
     }
   }

   export class MyTreeProvider implements vscode.TreeDataProvider<MyTreeItem> {
     private readonly _onDidChangeTreeData = new vscode.EventEmitter<MyTreeItem | undefined>();
     public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

     getTreeItem(element: MyTreeItem): vscode.TreeItem { return element; }

     async getChildren(element?: MyTreeItem): Promise<MyTreeItem[]> {
       if (!element) {
         // Root items
         return this.getRootItems();
       }
       // Child items
       return this.getChildItems(element);
     }

     refresh(): void {
       this._onDidChangeTreeData.fire(undefined);
     }
   }
   ```

2. **Register in package.json**:
   ```json
   "contributes": {
     "views": {
       "sshLite": [
         { "id": "sshLite.myView", "name": "My View" }
       ]
     }
   }
   ```

3. **Register in extension.ts**:
   ```typescript
   const myTreeProvider = new MyTreeProvider();
   const myTreeView = vscode.window.createTreeView('sshLite.myView', {
     treeDataProvider: myTreeProvider,
     showCollapseAll: false,
   });
   ```

4. **Add context menu items** in package.json menus
5. **Write tests** with mocked data
6. **Update `.adn/`**: `features/tree-providers.md`, `configuration/commands-reference.md`

---

## Playbook 4: Add a New Configuration Setting

**Files to modify:**
1. `package.json` — add to `contributes.configuration.properties`
2. Code that reads the setting

**Steps:**

1. **Add to package.json**:
   ```json
   "sshLite.myNewSetting": {
     "type": "number",
     "default": 5000,
     "minimum": 1000,
     "description": "Description of what this setting does"
   }
   ```

2. **Read in code**:
   ```typescript
   const config = vscode.workspace.getConfiguration('sshLite');
   const value = config.get<number>('myNewSetting', 5000);
   ```

3. **Update `.adn/configuration/settings-reference.md`** — add to relevant section

---

## Playbook 5: Add a New Tree Item Type

**Files to modify:**
1. Provider that creates the tree item
2. `package.json` — add `when` clauses for context menus

**Steps:**

1. **Create tree item class**:
   ```typescript
   class MyNewTreeItem extends vscode.TreeItem {
     constructor(data: MyData) {
       super(data.name, vscode.TreeItemCollapsibleState.None);
       this.id = `myNew:${data.id}`;        // STABLE ID
       this.contextValue = 'myNewType';       // For menu matching
       this.iconPath = new vscode.ThemeIcon('icon-name');
     }
   }
   ```

2. **Add menu items** in package.json:
   ```json
   {
     "command": "sshLite.myCommand",
     "when": "view == sshLite.fileExplorer && viewItem == myNewType",
     "group": "1_operations"
   }
   ```

3. **Update `.adn/configuration/commands-reference.md`** — add contextValue to reference

---

## Playbook 6: Add a New Webview

**Files to create:**
1. `src/webviews/MyPanel.ts`

**Files to modify:**
1. `src/extension.ts` — create and show panel

**Steps:**

1. **Create webview panel**:
   ```typescript
   export class MyPanel {
     private static _instance: MyPanel;
     private panel: vscode.WebviewPanel | undefined;

     static getInstance(): MyPanel { ... }

     show(): void {
       if (!this.panel) {
         this.panel = vscode.window.createWebviewPanel(
           'sshLiteMyPanel', 'My Panel',
           vscode.ViewColumn.One,
           { enableScripts: true, retainContextWhenHidden: true }
         );
         this.panel.webview.html = this.getHtmlContent();
         this.setupMessageHandlers();
         this.panel.onDidDispose(() => { this.panel = undefined; });
       }
       this.panel.reveal();
     }

     private setupMessageHandlers(): void {
       this.panel!.webview.onDidReceiveMessage(async (msg) => {
         switch (msg.type) {
           case 'action': await this.handleAction(msg); break;
         }
       });
     }

     private getHtmlContent(): string {
       return `<!DOCTYPE html><html>...</html>`;
     }

     // Send data to webview
     sendState(): void {
       this.panel?.webview.postMessage({ type: 'updateState', ... });
     }
   }
   ```

2. **HTML generates inline** (convention in this codebase — no separate HTML files)
3. **Communication**: extension ↔ webview via `postMessage` / `onDidReceiveMessage`
4. **Write tests** and update `.adn/` docs

---

## Playbook 7: Add a New File Decoration

**Files to modify:**
1. `src/providers/FileDecorationProvider.ts`

**Steps:**

1. **Add state tracking** in FileService (or relevant service):
   ```typescript
   private myStateFiles: Set<string> = new Set();

   isMyState(localPath: string): boolean {
     return this.myStateFiles.has(normalizeLocalPath(localPath));
   }
   ```

2. **Add decoration** in FileDecorationProvider:
   ```typescript
   if (fileService.isMyState(localPath)) {
     return {
       badge: 'X',
       color: new vscode.ThemeColor('charts.blue'),
       tooltip: 'My state description'
     };
   }
   ```

3. **Fire refresh event** when state changes
4. **Update `.adn/features/tree-providers.md`** — add to badge table

---

## Playbook 8: Add a New Feature (Composite)

For larger features that combine multiple playbooks:

1. **Check LITE principles** first:
   - Does this run server commands automatically? → Make user-triggered
   - Does this poll the server? → Make opt-in, default OFF
   - Does this preload data? → Make lazy-load on demand

2. **Plan components**: Identify which playbooks you need (service, commands, tree items, etc.)

3. **Implement in order**: Service → Provider → Commands → Tests → Documentation

4. **LITE checklist**:
   - [ ] No auto server commands without user trigger
   - [ ] No polling without user opt-in
   - [ ] Debounced actions (300ms+)
   - [ ] Single SSH connection reused
   - [ ] Cache where possible
   - [ ] Logging uses `log()`, not in loops

---

## General Rules for All Playbooks

1. **Use `log()` for output channel logging** (not `console.log`)
2. **Use `normalizeLocalPath()`** for all local file path Map lookups
3. **Go through CommandGuard** for significant SSH operations
4. **Use stable tree item IDs** (never include dynamic state)
5. **Match contextValue patterns** with package.json `when` clauses
6. **Build and test** before considering done:
   ```bash
   npm run compile
   npx jest --no-coverage
   ```
7. **Update `.adn/` docs** — follow mapping table in `CLAUDE.md`
