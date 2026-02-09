# Testing Strategy

Testing infrastructure, patterns, and guides for SSH Lite. **823 tests across 30 suites**.

---

## Test Categories

| Category | Location | Runner | Environment |
|----------|----------|--------|-------------|
| **Unit** | `src/**/*.test.ts` | `npx jest --no-coverage` | Mocked VS Code |
| **Docker Integration** | `src/integration/docker-ssh.test.ts` | `npx jest --testPathPattern=docker` | Real SSH via Docker |
| **Multi-OS** | `src/integration/multios-*.test.ts` | `npx jest --testPathPattern=multios` | Multiple Linux distros |
| **Multi-Server** | `src/integration/multi-server.test.ts` | `npx jest --testPathPattern=multi-server` | Multiple SSH servers |

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
