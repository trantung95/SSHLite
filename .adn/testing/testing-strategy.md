# Testing Strategy

Testing infrastructure, patterns, and guides for SSH Lite. **859 tests across 32 suites**.

---

## Test Categories

| Category | Location | Runner | Environment |
|----------|----------|--------|-------------|
| **Unit** | `src/**/*.test.ts` | `npx jest --no-coverage` | Mocked VS Code |
| **Docker Integration** | `src/integration/docker-ssh.test.ts` | `npx jest --testPathPattern=docker` | Real SSH via Docker |
| **Multi-OS** | `src/integration/multios-*.test.ts` | `npx jest --testPathPattern=multios` | Multiple Linux distros |
| **Multi-Server** | `src/integration/multi-server.test.ts` | `npx jest --testPathPattern=multi-server` | Multiple SSH servers |
| **Integration** | `src/integration/port-forward-persistence.test.ts` | `npx jest --no-coverage` | Mocked SSH, cross-service |

### Running Tests

```bash
npx jest --no-coverage                          # All unit tests
npx jest -- HostTreeProvider                    # Specific file
npx jest --testPathPattern=docker --no-coverage # Docker e2e tests
npx jest --testPathPattern=multios --no-coverage # Multi-OS tests
```

---

## Mock Architecture

### VS Code Mock (`src/__mocks__/vscode.ts`)

Mocks the entire `vscode` module since it only exists in VS Code runtime:

```typescript
// Key mocked APIs:
export const window = {
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(), show: jest.fn(), dispose: jest.fn()
  })),
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showQuickPick: jest.fn(),
  showInputBox: jest.fn(),
  createTreeView: jest.fn(() => ({ onDidExpandElement: jest.fn(), ... })),
  registerFileDecorationProvider: jest.fn(),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((key, defaultValue) => defaultValue),
    update: jest.fn(),
  })),
  onDidSaveTextDocument: jest.fn(),
  onDidCloseTextDocument: jest.fn(),
};

export class EventEmitter {
  private _event = jest.fn();
  public event = this._event;
  public fire = jest.fn();
  public dispose = jest.fn();
}

export class Uri {
  static file(path: string) { return { fsPath: path, scheme: 'file' }; }
}

export const commands = {
  executeCommand: jest.fn(),
  registerCommand: jest.fn(),
};
```

**Configured in Jest**: `moduleNameMapper: { '^vscode$': '<rootDir>/src/__mocks__/vscode.ts' }`

### Test Helpers (`src/__mocks__/testHelpers.ts`)

Factory functions for consistent test data:

```typescript
createMockHostConfig(overrides?: Partial<IHostConfig>): IHostConfig
// Default: { id: 'test:22:user', name: 'Test', host: 'test', port: 22, username: 'user', source: 'saved' }

createMockRemoteFile(name: string, overrides?: Partial<IRemoteFile>): IRemoteFile
// Default: { name, path: `/home/user/${name}`, isDirectory: false, size: 1024, ... }

createMockCredential(overrides?: Partial<SavedCredential>): SavedCredential
// Default: { id: 'cred-1', label: 'Test', type: 'password', pinnedFolders: [] }

createMockConnection(overrides?): MockSSHConnection
// Returns mock with jest.fn() for exec, readFile, writeFile, etc.
```

---

## Test Patterns

### Unit Test Structure

```typescript
describe('ServiceName', () => {
  let service: ServiceName;

  beforeEach(() => {
    // Reset singleton (required for test isolation)
    (ServiceName as any)._instance = undefined;
    service = ServiceName.getInstance();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should do X when Y', async () => {
    // Arrange
    const mockConn = createMockConnection();
    mockConn.exec.mockResolvedValue('output');

    // Act
    const result = await service.doSomething(mockConn);

    // Assert
    expect(result).toBe('expected');
    expect(mockConn.exec).toHaveBeenCalledWith('command');
  });
});
```

### Singleton Reset

**Critical**: Singletons must be reset between tests for isolation:

```typescript
beforeEach(() => {
  (FileService as any)._instance = undefined;
  (ConnectionManager as any)._instance = undefined;
  (ActivityService as any)._instance = undefined;
});
```

### Testing Event Emitters

```typescript
it('should fire event when state changes', () => {
  const handler = jest.fn();
  service.onStateChanged(handler);

  service.triggerChange();

  expect(handler).toHaveBeenCalledWith(expect.objectContaining({
    state: 'connected'
  }));
});
```

### Testing Debounced Operations

```typescript
it('should debounce uploads', async () => {
  jest.useFakeTimers();

  service.queueUpload(localPath, content);
  service.queueUpload(localPath, content2); // Resets timer

  jest.advanceTimersByTime(1000); // uploadDebounceMs
  await Promise.resolve(); // Flush microtasks

  expect(mockConnection.writeFile).toHaveBeenCalledTimes(1);
  expect(mockConnection.writeFile).toHaveBeenCalledWith(remotePath, content2);

  jest.useRealTimers();
});
```

### Testing Tree Providers

```typescript
it('should return correct children', async () => {
  const provider = new HostTreeProvider();

  // Mock services
  jest.spyOn(HostService, 'getInstance').mockReturnValue({
    getAllHosts: () => [createMockHostConfig()],
  } as any);

  const children = await provider.getChildren();
  expect(children).toHaveLength(1);
  expect(children[0]).toBeInstanceOf(ServerTreeItem);
  expect(children[0].contextValue).toBe('savedServer');
});
```

---

## Docker Integration Tests

Uses `linuxserver/openssh-server` Docker image for real SSH testing:

```bash
# Start containers
cd test-docker && docker compose up -d

# Generate SSH keys
bash test-docker/generate-test-keys.sh

# Run tests
npx jest --testPathPattern=docker --no-coverage
```

### What's Tested

- Real SSH connection to Docker container
- File upload/download via SFTP
- Cross-server search with grep
- Search cancellation
- Permission handling
- Large file operations

---

## Multi-OS Tests

Test across multiple Linux distributions:

| Container | Image | Tests |
|-----------|-------|-------|
| Alpine | `linuxserver/openssh-server:latest` | Basic SSH, file ops |
| Ubuntu | `ubuntu:22.04` | inotifywait, extended attrs |
| Debian | `debian:12` | Standard Linux ops |
| Fedora | `fedora:39` | SELinux contexts |
| Rocky | `rockylinux:9` | RHEL-compatible ops |

### Test Files

```
multios-auth.test.ts          # Auth methods across OS
multios-connection.test.ts    # Connection behavior
multios-fileops.test.ts       # File operations
multios-monitor.test.ts       # Server monitoring
multios-commandguard.test.ts  # Activity tracking
multios-helpers.ts            # Shared test utilities
```

---

## Jest Configuration

```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/out/',
    'docker-ssh',
    'multios-',
    'multi-server',
    'credential-connection'
  ]
};
```

Separate configs exist for Docker, Multi-OS, and Chaos tests to include their specific test paths.

---

## Per-Function Test Case Matrix: Port Forward Persistence

Comprehensive test cases for every function in the port forward persistence feature, organized by test type.

**Legend**: `[x]` = implemented, `[ ]` = not yet implemented

---

### PortForwardService

#### `getInstance()`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Returns singleton instance | [x] |

#### `initialize(context)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Loads saved rules from globalState | [x] |
| Unit | Handles empty globalState gracefully | [x] |
| Integration | New service instance loads rules saved by previous instance | [x] |
| E2E (Docker) | Initializes with real VS Code extension context | [ ] |

#### `forwardPort(connection, localPort, remoteHost, remotePort)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Calls `connection.forwardPort` with correct args | [x] |
| Unit | Adds forward to tree provider on success | [x] |
| Unit | Shows success status bar message | [x] |
| Unit | Shows error message on failure | [x] |
| Unit | Does not add to tree on failure | [x] |
| Unit | Auto-saves rule on success | [x] |
| Unit | Does not save rule on failure | [x] |
| Integration | Create → verify tree + saved rule both reflect forward | [x] |
| E2E (Docker) | Forward real port through SSH tunnel | [ ] |
| E2E (Docker) | Forward with non-localhost remoteHost | [ ] |
| E2E (Docker) | Forward to port already in use (EADDRINUSE) | [ ] |
| Chaos | Forward under concurrent operations | coverage-manifest entry |
| Chaos | Forward during connection state transitions | coverage-manifest entry |

#### `stopForward(forward)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Calls `connection.stopForward` | [x] |
| Unit | Removes forward from tree provider | [x] |
| Unit | Shows warning if connection no longer active | [x] |
| Unit | Shows error on stopForward failure | [x] |
| Unit | Shows status bar message on success | [x] |
| Unit | Keeps saved rule after stopping (rule persists) | [x] |
| E2E (Docker) | Stop real forwarded port, verify traffic stops | [ ] |
| Chaos | Stop during active data transfer | coverage-manifest entry |

#### `deactivateAllForwardsForConnection(connectionId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Stops all forwards for a connection | [x] |
| Unit | Does nothing if no tree provider | [x] |
| Unit | Handles missing connection gracefully | [x] |
| Unit | Keeps saved rules after deactivation | [x] |
| Integration | Deactivate → tree shows 0 active, saved rules persist | [x] |
| E2E (Docker) | Deactivate all after real SSH disconnect | [ ] |

#### `restoreForwardsForConnection(connection)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Restores saved forwards on connect | [x] |
| Unit | Restores multiple forwards | [x] |
| Unit | Handles partial failures gracefully (some succeed, some fail) | [x] |
| Unit | Does nothing when no saved rules | [x] |
| Unit | Shows status message on restore | [x] |
| Integration | Full create → disconnect → restart → restore cycle | [x] |
| Integration | Multi-server isolation (restore only correct server's rules) | [x] |
| Integration | Partial restore failure (successful rules added to tree, failed skipped) | [x] |
| E2E (Docker) | Restore real port forwards after SSH reconnect | [ ] |
| E2E (Docker) | Restore when remote port is no longer available | [ ] |
| Chaos | Restore under concurrent connection events | coverage-manifest entry |

#### `saveRule(hostId, localPort, remoteHost, remotePort)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Saves rule to globalState | [x] |
| Unit | Deduplicates identical rules (same localPort+remoteHost+remotePort) | [x] |
| Unit | Allows different rules for same host | [x] |
| Unit | Returns existing rule object on duplicate | [x] |
| Integration | Rule survives service instance restart (new singleton, same globalState) | [x] |

#### `deleteSavedRule(hostId, ruleId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Deletes rule from globalState | [x] |
| Unit | Refreshes tree after deleting rule | [x] |
| Unit | Cleans up host entry when last rule deleted | [x] |
| Integration | Deleted rule is not restored on next connect | [x] |

#### `activateSavedForward(hostId, ruleId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Activates a saved forward on active connection | [x] |
| Unit | Shows warning if rule not found | [x] |
| Unit | Shows warning if no active connection | [x] |
| Integration | Activate saved rule on active connection (manual trigger) | [x] |
| Integration | Shows warning when activating without connection | [x] |

#### `getSavedRules(hostId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Returns saved rules for host | [x] (via persistence tests) |
| Unit | Returns empty array for unknown host | [x] |

#### `getHostIdsWithSavedRules()`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Returns all hostIds that have saved rules | [x] |

#### `promptForwardPort()`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Shows warning if no connections | [x] |
| Unit | Shows quick pick to select connection | [x] |
| Unit | Cancels if user dismisses connection picker | [x] |
| Unit | Prompts for local port after connection selection | [x] |

---

### PortForwardTreeProvider

#### `addForward(connectionId, localPort, remoteHost, remotePort)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Adds a forward to internal storage | [x] |
| Unit | Adds multiple forwards | [x] |

#### `removeForward(localPort, connectionId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Removes by localPort and connectionId | [x] |
| Unit | Does not affect other connections | [x] |

#### `getForwardsForConnection(connectionId)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Returns empty array for unknown connection | [x] |
| Unit | Filters by connectionId | [x] |

#### `getChildren(element?)`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Returns empty when no forwards and no saved rules | [x] |
| Unit | Returns PortForwardTreeItem for active forwards with connection | [x] |
| Unit | Skips forwards for disconnected connections | [x] |
| Unit | Shows saved-but-inactive rules as SavedForwardTreeItem | [x] |
| Unit | Does not duplicate active forward as saved item (dedup) | [x] |
| Unit | Shows both active and saved items for different ports | [x] |
| Unit | Shows saved rules for orphaned hosts (not in HostService) | [x] |
| Integration | Shows active items during connection, dimmed items after disconnect | [x] |
| Integration | Shows active items again after reconnect + restore | [x] |

#### `cleanupDisconnectedForwards()`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Removes forwards for disconnected connections | [x] |
| Unit | Keeps forwards for still-connected connections | [x] |

#### `refresh()`

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Fires onDidChangeTreeData event | [x] |

---

### PortForwardTreeItem

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Has `contextValue = 'forward'` | [x] |
| Unit | Displays correct label format (remoteHost:remotePort <-> localhost:localPort) | [x] (via getChildren tests) |

### SavedForwardTreeItem

| Test Type | Case | Status |
|-----------|------|--------|
| Unit | Has `contextValue = 'savedForward'` | [x] |
| Unit | Has stable id (`saved:${hostId}:${ruleId}`) | [x] |
| Unit | Shows `(saved)` in description | [x] |
| Unit | Uses dimmed icon (`disabledForeground`) | [x] (via constructor) |

---

### Integration Test Flows (`src/integration/port-forward-persistence.test.ts`)

| Flow | Description | Status |
|------|-------------|--------|
| Full lifecycle | Create → disconnect → restart (new service instance) → restore | [x] |
| Tree view lifecycle | Active item → dimmed item (disconnect) → active item (reconnect) | [x] |
| Multi-server isolation | Restore only correct server's rules, other server untouched | [x] |
| Delete permanently | Delete saved rule → not restored on next connect | [x] |
| Manual activation | Activate a manually-saved rule on active connection | [x] |
| Activation without connection | Show warning when no active connection | [x] |
| Partial restore failure | One rule succeeds, one fails EADDRINUSE → only success in tree, both rules kept | [x] |

---

### E2E Docker Test Cases (Not Yet Implemented)

These require Docker Desktop running with SSH containers.

| Flow | Description | Status |
|------|-------------|--------|
| Real forward | Forward a real port through SSH, verify TCP connectivity | [ ] |
| Real stop | Stop forward, verify port no longer accessible | [ ] |
| Real restore | Disconnect SSH, reconnect, verify forwards auto-restore | [ ] |
| Port conflict | Forward to port already in use on local machine | [ ] |
| Remote port unavailable | Forward to remote port with no service listening | [ ] |
| Multi-OS | Verify port forwarding works on Alpine, Ubuntu, Debian, Fedora, Rocky | [ ] |

---

### Chaos Test Scenarios (Coverage Manifest Only)

Methods registered in `src/chaos/coverage-manifest.json`. Scenario implementations pending.

| Method | Manifest Scenarios |
|--------|--------------------|
| `PortForwardService.forwardPort` | `[]` (pending) |
| `PortForwardService.stopForward` | `[]` (pending) |
| `PortForwardService.restoreForwardsForConnection` | `[]` (pending) |
| `PortForwardService.deactivateAllForwardsForConnection` | `[]` (pending) |
| `PortForwardService.saveRule` | `[]` (pending) |
| `PortForwardService.deleteSavedRule` | `[]` (pending) |
| `PortForwardService.activateSavedForward` | `[]` (pending) |

---

### Test Coverage Summary

| Test Type | Written | Pending |
|-----------|---------|---------|
| **Unit** | 48 test cases | 0 |
| **Integration** | 7 flows (11 assertions) | 0 |
| **E2E (Docker)** | 0 | 6 flows |
| **Chaos** | 0 scenarios | 7 methods in manifest |

---

## Chaos Bug Discovery Tests

Dynamic bug-discovery module that exercises actual extension code against real Docker SSH containers.
See `.adn/testing/chaos-testing.md` for full documentation.

```bash
npm run test:chaos          # Quick mode (3-5 min, 8 servers)
npm run test:chaos:deep     # Deep mode (10+ min, 8 servers)
```

### What It Discovers

- **Invariant violations**: writeFile/readFile mismatches, ghost files, state machine bugs
- **Output anomalies**: unexpected errors in extension output channels
- **Resource leaks**: activities that never complete, dangling event listeners
- **OS-specific bugs**: different behavior across Alpine/Ubuntu/Debian/Fedora/Rocky
- **Race conditions**: concurrent operations that corrupt data or hang
- **Error handling gaps**: operations that don't throw when they should

### Files

```
src/chaos/
  ChaosEngine.ts, ChaosConfig.ts, ChaosCollector.ts, ChaosDetector.ts,
  ChaosValidator.ts, ChaosLogger.ts, chaos-helpers.ts, chaos.test.ts,
  coverage-manifest.json
  scenarios/ (7 scenario files + index.ts)
```
