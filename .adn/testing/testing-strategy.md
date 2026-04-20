# Testing Strategy

**~1127 tests across 32+ suites.**

## Testing Policy (MANDATORY)

Every code change must check/write/update ALL applicable test types:
- **Unit**: Every new/changed method
- **Integration**: Every cross-service flow change
- **E2E**: Every command/feature change
- **UI**: Every webview/tree provider change

Coverage target: 95%+ on new/changed code.

## Test Categories

| Category | Location | Runner |
|----------|----------|--------|
| Unit | `src/**/*.test.ts` | `npx jest --no-coverage` |
| Docker Integration | `src/integration/docker-ssh.test.ts` | `npx jest --testPathPattern=docker` |
| Multi-OS | `src/integration/multios-*.test.ts` | `npx jest --testPathPattern=multios` |
| Multi-Server | `src/integration/multi-server.test.ts` | `npx jest --testPathPattern=multi-server` |
| Cross-service | `src/integration/port-forward-persistence.test.ts` | `npx jest --no-coverage` |

## Mock Architecture

- **VS Code mock**: `src/__mocks__/vscode.ts` — mocks `window`, `workspace`, `EventEmitter`, `Uri`, `commands`. Configured via `moduleNameMapper: { '^vscode$': '<rootDir>/src/__mocks__/vscode.ts' }`
- **Test helpers**: `src/__mocks__/testHelpers.ts` — `createMockHostConfig()`, `createMockRemoteFile()`, `createMockCredential()`, `createMockConnection()`

## Test Patterns

**Singleton reset** (critical for isolation):
```typescript
beforeEach(() => {
  (ServiceName as any)._instance = undefined;
});
```

**Unit test structure**: Arrange (mock) → Act (call) → Assert. Use `createMockConnection()` for SSH mocks.

**Event emitters**: Subscribe with `jest.fn()`, trigger action, assert handler called with expected data.

**Debounced ops**: `jest.useFakeTimers()` → queue actions → `jest.advanceTimersByTime(delay)` → flush microtasks → assert single call.

**Tree providers**: Mock service `getInstance()` via `jest.spyOn`, call `getChildren()`, assert item types and `contextValue`.

## Docker Integration Tests

Uses `linuxserver/openssh-server` Docker image. Setup: `cd test-docker && docker compose up -d`, generate keys, run tests.

Tests: real SSH connection, SFTP upload/download, cross-server grep search, cancellation, permissions, large files.

## Multi-OS Tests

5 containers: Alpine, Ubuntu 22.04, Debian 12, Fedora 39, Rocky 9. Test files: `multios-auth`, `multios-connection`, `multios-fileops`, `multios-monitor`, `multios-commandguard`, `multios-helpers`.

## Jest Configuration

Main config excludes Docker/Multi-OS/Chaos tests. Separate configs (`jest.chaos.config.js`, etc.) include their specific paths. See `jest.config.js` for details.

## Chaos Bug Discovery

See `.adn/testing/chaos-testing.md` for full documentation.

```bash
npm run test:chaos          # Quick (3-5 min, 8 servers)
npm run test:chaos:deep     # Deep (10+ min, 8 servers)
```

Discovers: invariant violations, output anomalies, resource leaks, OS-specific bugs, race conditions, error handling gaps. Files in `src/chaos/`.

## Per-Function Test Matrix: Port Forward Persistence

### PortForwardService

| Function | Unit | Integration | E2E |
|----------|------|-------------|-----|
| `getInstance()` | [x] singleton | — | — |
| `initialize(context)` | [x] load/empty globalState | [x] cross-instance persistence | [ ] real context |
| `forwardPort(conn, local, host, remote)` | [x] success/fail/save/tree | [x] tree+rule reflect | [ ] real tunnel |
| `stopForward(forward)` | [x] stop/remove/warn/error/keepRule | — | [ ] real stop |
| `deactivateAllForwardsForConnection(id)` | [x] stop all/noop/keepRules | [x] tree 0 active, rules persist | [ ] real disconnect |
| `restoreForwardsForConnection(conn)` | [x] restore/multi/partial/empty | [x] full lifecycle, multi-server, partial fail | [ ] real reconnect |
| `saveRule(hostId, ...)` | [x] save/dedup/different/return | [x] survives restart | — |
| `deleteSavedRule(hostId, ruleId)` | [x] delete/refresh/cleanup | [x] not restored | — |
| `activateSavedForward(hostId, ruleId)` | [x] activate/warn noRule/warn noConn | [x] manual activate, no-conn warning | — |
| `getSavedRules(hostId)` | [x] return/empty | — | — |
| `getHostIdsWithSavedRules()` | [x] returns all | — | — |
| `promptForwardPort()` | [x] warn/pick/cancel/prompt | — | — |

### PortForwardTreeProvider

| Function | Unit | Integration |
|----------|------|-------------|
| `addForward / removeForward` | [x] add/multi, remove by port+conn | — |
| `getForwardsForConnection(id)` | [x] empty/filter | — |
| `getChildren(element?)` | [x] empty/active/skip-disconnected/saved/dedup/both/orphan | [x] active↔dimmed lifecycle |
| `cleanupDisconnectedForwards()` | [x] remove disconnected, keep connected | — |

### Integration Test Flows

7 flows: full lifecycle, tree view lifecycle, multi-server isolation, delete permanently, manual activation, no-conn warning, partial restore failure. All [x] implemented.

### Pending

- E2E Docker: 6 flows (real forward/stop/restore/conflict/unavailable/multi-OS)
- Chaos: 7 methods in coverage-manifest (scenarios pending)
