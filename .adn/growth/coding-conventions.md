# Coding Conventions

Authoritative reference for all naming, patterns, and rules used in SSH Lite. Follow these when writing any new code.

---

## Naming Conventions

### Files & Classes

| Element | Convention | Example |
|---------|-----------|---------|
| Source files | PascalCase, matches primary class | `FileService.ts`, `HostTreeProvider.ts` |
| Test files | Source name + `.test.ts` | `FileService.test.ts` |
| Service classes | PascalCase + `Service` suffix | `FileService`, `AuditService` |
| Provider classes | PascalCase + `TreeProvider` suffix | `HostTreeProvider`, `FileTreeProvider` |
| Connection classes | PascalCase | `ConnectionManager`, `SSHConnection` |
| Tree items | PascalCase + `TreeItem` suffix | `ServerTreeItem`, `FileTreeItem` |
| Interfaces | `I`-prefix + PascalCase | `IHostConfig`, `ISSHConnection` |
| Error classes | PascalCase + `Error` suffix | `AuthenticationError`, `SFTPError` |
| Utility files | camelCase | `helpers.ts`, `extensionHelpers.ts` |

---

## Core Patterns

### 1. Singleton Pattern

**Every service** uses this pattern:

```typescript
export class MyService {
  private static _instance: MyService;

  private constructor() {
    // Private constructor prevents direct instantiation
  }

  static getInstance(): MyService {
    if (!MyService._instance) {
      MyService._instance = new MyService();
    }
    return MyService._instance;
  }
}
```

**Rules**:
- Always `getInstance()`, never `new MyService()`
- If service needs `ExtensionContext`, add `initialize(context)` method
- Initialize order matters (see `flow/extension-activation.md`)

### 2. EventEmitter Pattern

**Service ↔ Provider communication**:

```typescript
// In service:
private readonly _onStateChanged = new vscode.EventEmitter<StateData>();
public readonly onStateChanged = this._onStateChanged.event;

// Fire event:
this._onStateChanged.fire({ state: 'connected' });

// In extension.ts (wiring):
service.onStateChanged((data) => {
  treeProvider.refresh();
});
```

**Rules**:
- Private `_on*` field, public `on*` getter
- Fire events AFTER state change is complete
- Wire up subscriptions in `extension.ts`

### 3. Debounce Pattern

Used for upload and other frequent operations:

```typescript
private timers: Map<string, NodeJS.Timeout> = new Map();

debouncedAction(key: string, action: () => void, delayMs: number): void {
  const existing = this.timers.get(key);
  if (existing) clearTimeout(existing);

  this.timers.set(key, setTimeout(() => {
    this.timers.delete(key);
    action();
  }, delayMs));
}
```

**LITE**: Minimum debounce is 300ms. Default upload debounce is 1000ms.

### 4. Path Normalization

**Critical for Windows compatibility**:

```typescript
import { normalizeLocalPath } from '../utils/helpers';

// WRONG - Map lookup may fail on Windows
this.fileMap.get(localPath);

// CORRECT - normalize drive letter case
this.fileMap.get(normalizeLocalPath(localPath));
```

`normalizeLocalPath()` lowercases drive letters on Windows (`C:\` → `c:\`).

**Rule**: Use `normalizeLocalPath()` for ALL `Map<string>` lookups keyed by local file paths.

### 5. CommandGuard Usage

```typescript
// CORRECT - tracked in Activity panel
const data = await commandGuard.readFile(connection, remotePath);
const output = await commandGuard.exec(connection, command);

// DIRECT - OK for quick metadata (not tracked)
const stat = await connection.stat(remotePath);
const realpath = await connection.exec('realpath ~');
```

**Rule**: User-initiated operations → CommandGuard. Internal metadata → direct connection.

### 6. Tree Item Identity

```typescript
// WRONG - expansion state lost when isConnected changes
this.id = `server:${key}:${isConnected}`;

// CORRECT - stable ID preserves expansion
this.id = `server:${key}`;
```

**Rule**: Tree item `id` must NEVER include dynamic state (connection status, filter state, etc.).

### 7. Context Value Naming

Pattern: `baseType` or `baseType.modifier`:

```typescript
this.contextValue = 'connectedServer.saved';    // Connected + saved host
this.contextValue = 'folder.filtered';           // Folder with filter applied
this.contextValue = 'credential';                // Basic credential
this.contextValue = 'credentialConnected';       // Connected credential
```

**Rules**:
- Must match package.json `when` clauses exactly
- Use regex-friendly patterns (`viewItem =~ /^connectedServer/`)
- Document in `.adn/configuration/commands-reference.md`

---

## Error Handling

### Standard Pattern

```typescript
try {
  await someOperation();
  vscode.window.setStatusBarMessage('$(check) Success', 3000);
} catch (error) {
  const errMsg = (error as Error).message;
  vscode.window.showErrorMessage(`Operation failed: ${errMsg}`);
  log(`ERROR: Operation failed: ${errMsg}`);
}
```

### Error Types and Behavior

| Error Type | Recovery | Action |
|-----------|----------|--------|
| `AuthenticationError` | Non-recoverable | Stop auto-reconnect |
| `ConnectionError` | May recover | Start auto-reconnect |
| `SFTPError` | Non-recoverable | Show error, log |
| Generic `Error` | Depends | Show error, log |

---

## Logging

### Rules

- **Use `log()`** for output channel logging (not `console.log`)
- **Don't log in loops** — log summaries
- **Log level by type**:
  - Commands: `logCommand(name, args)` and `logResult(name, success, detail)`
  - Errors: include error message and context
  - State changes: connection, upload state transitions

```typescript
// WRONG
for (const file of files) {
  log(`Processing: ${file.name}`);
}

// CORRECT
log(`Processing ${files.length} files`);
```

---

## LITE Principle Compliance Checklist

Before implementing any feature:

- [ ] **No auto server commands** — User must trigger actions explicitly
- [ ] **No polling by default** — Auto-refresh opt-in, default interval reasonable
- [ ] **Cache aggressively** — Don't re-fetch data that hasn't changed
- [ ] **Single connection** — Reuse existing SSH connection
- [ ] **Debounce actions** — 300ms+ between server calls
- [ ] **Lazy load** — Don't preload data user hasn't requested
- [ ] **Minimal UI** — Don't add complexity without clear user benefit
