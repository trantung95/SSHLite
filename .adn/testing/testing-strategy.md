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
| Manifest | `src/__tests__/manifest/*.test.ts` | `npx jest --no-coverage` |
| Docker Integration | `src/integration/docker-ssh.test.ts` | `npx jest --testPathPattern=docker` |
| Multi-OS | `src/integration/multios-*.test.ts` | `npx jest --testPathPattern=multios` |
| Multi-Server | `src/integration/multi-server.test.ts` | `npx jest --testPathPattern=multi-server` |
| Cross-service | `src/integration/port-forward-persistence.test.ts` | `npx jest --no-coverage` |

**Manifest regression net**: when a bug lives in a `package.json` constant that VS Code reads at install/activation time (not reproducible on a docker SSH server), assert the shipped manifest value directly. Example: `src/__tests__/manifest/extensionKind.test.ts` reads `package.json` and asserts `extensionKind` deep-equals `["ui"]` — the net for the v1.0.5 "host list empty inside a Remote-SSH window" regression (`.adn/lessons.md` "2026-06-22"). Behavioural tests that *mock* `extensionKind` cannot catch the manifest value drifting; assert the constant itself.

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

Alpine-based SSH servers built from `test-docker/Dockerfile.sshd`. Setup: `docker compose -f test-docker/docker-compose.yml up -d web api db`, then run tests. Credentials: `testuser`/`testpass` (web+api) and `admin`/`adminpass` (db); ports 2201/2202/2203. The compose project is named `hybr8-prod`, so the containers appear as a production fleet (`hybr8-prod-web-01` / `-api-01` / `-db-01`) rather than `test-docker_*`.

Tests: real SSH connection, SFTP upload/download, cross-server grep search, cancellation, permissions, large files.

### Native search tools suite (isolated)

`src/integration/docker-ssh-search-tools.test.ts` runs against TWO dedicated servers in a SEPARATE compose file (`test-docker/docker-compose.search-tools.yml`, project `sshlite-search-tools`) so a build error there can never break the main docker suite:

- **`search-tools` (port 2207)** — `Dockerfile.search-tools`: ripgrep + fd + plocate + GNU userland. Exercises the rg/fd fast paths and the **results-parity** assertions (`nativeTools:'auto'` vs `'off'` must return identical sorted result sets across hidden / gitignored / excluded-dir / spaced-name / binary fixtures, for content + filename + worker-pool-file-list searches).
- **`search-busybox` (port 2208)** — `Dockerfile.busybox`: busybox-only userland (NO GNU grep/findutils). The regression net for the busybox `grep --include` silent-0-results bug: `'auto'` detects the non-GNU grep and uses the find|xargs path (returns results); `'off'` reproduces the bug (empty).

Run with `npm run test:docker:search-tools` (needs Docker Desktop). Isolated globalSetup/teardown (`globalSetup.search-tools.ts`) build + wait on 2207/2208 only. Unit coverage (no Docker) lives in `src/connection/searchCommandBuilder.test.ts` (every flag combo, escaping, strategy matrix, probe parsing, fallback predicate) + the "native search tool detection + runtime fallback" block in `SSHConnection.test.ts`.

### Server identities (hostnames)

The three basic servers carry production-style hostnames, asserted in `docker-ssh.test.ts` and configured in `src/chaos/ChaosConfig.ts` + `ContainerHealthMonitor.ts` + `globalSetup.chaos.ts` / `globalTeardown.chaos.ts`. The compose **service key**, **`container_name`**, and **`hostname`** all match (see table). Change them together if renaming — the basic `globalSetup.ts` drives the file by port and `down`, but the chaos suite keys off `container_name`:

| Service | container_name / hostname | Port | User | Build flavor |
|---------|---------------------------|------|------|--------------|
| `web` | `hybr8-prod-web-01` | 2201 | testuser | `prod-web` |
| `api` | `hybr8-prod-api-01` | 2202 | testuser | `prod-api` |
| `db` | `hybr8-prod-db-01` | 2203 | admin | `prod-db` |

### Seeded file tree (`test-docker/seed-showcase.sh`)

Every server built from `Dockerfile.sshd` is seeded at build time with a rich, diverse tree under `/home/testuser` so all SSH Lite features (browse, filter, search, preview, large-file download, symlinks, permissions, terminal prompt) exercise real content. The seed is **additive** — it never removes the minimal legacy fixtures (`projects/src/app.ts`, `projects/package.json`, `projects/src/todo.ts`, `logs/app.log`, `big/huge.log`, `admin/configs/*.conf`) that the assertions above depend on.

The `SERVER_FLAVOR` build arg (`prod-web` | `prod-api` | `prod-db`, default `prod-db`) decorates `workspace/` with a distinct top-level project per server. `seed-showcase.sh` adds: `showcase/` (code in ~15 languages, every config format, docs incl. a valid PDF, data/logs, real PNG/GIF/SVG images, tar.gz/gz/zip archives, a 5-level-deep tree, 40 files for filter/search demos, tricky filenames with spaces/unicode/no-extension, binaries, read-only + executable files, a 30 MB + 10 MB large file, file/dir/broken symlinks) plus hidden dotfiles and a colored production-style shell prompt (`.bashrc`).

### Slow / laggy servers (timing-bug repro)

`test-docker/docker-compose.yml` also carries two deliberately impaired SSH servers for reproducing timing-sensitive bugs (high ping, jitter, loss, periodic disconnect). Full docs: `test-docker/SLOW-SERVERS.md`.

| Approach | Service(s) | Port | Mechanism |
|----------|------------|------|-----------|
| In-container `tc`/netem | `slow` | 2205 | Linux netem on `eth0` + blackout loop (env-tunable) |
| Toxiproxy sidecar | `toxiproxy` + `slow-backend` | 2206 (API 8474) | runtime "toxics" via HTTP API |

**netem only works on a kernel with `sch_netem`** — Docker Desktop's WSL2 kernel lacks it (`tc` errors with "qdisc kind is unknown" even with `NET_ADMIN`), so on Windows/macOS use the Toxiproxy server (2206). `src/integration/docker-ssh-reveal.test.ts` (issue #7) exercises `revealFile()`/`getParent()` against the laggy Toxiproxy link, seeding a latency toxic via the API in `beforeAll`.

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
