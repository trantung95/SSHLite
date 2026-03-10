# Chaos Bug Discovery Module

Dynamic bug-discovery system that exercises actual extension code against real Docker SSH containers with randomized scenarios, captures all extension output, and uses deliberate detection strategies to find issues before users do.

---

## Quick Reference

```bash
npm run test:chaos                    # Quick mode (3-5 min, 8 servers)
npm run test:chaos:deep               # Deep mode (10+ min, 8 servers)
CHAOS_SEED=42 npm run test:chaos      # Reproducible run
```

**Requires**: Docker Desktop running. Containers are managed automatically (see below).

---

## Container Lifecycle

Chaos tests fully manage their own Docker containers — no manual `docker compose up/down` needed.

| Phase | What happens | File |
|-------|-------------|------|
| **Log cleanup** | `globalSetup.chaos.ts` deletes `logs/chaos-container-logs.txt` and all `test-docker/logs/*/sshd.log` files from the previous run | `test-docker/globalSetup.chaos.ts` |
| **Setup** | Starts both compose stacks (`docker-compose.yml` ports 2201-2203, `docker-compose.multios.yml` ports 2210-2214), waits for SSH readiness on all 8 servers | `test-docker/globalSetup.chaos.ts` |
| **Log collection** | `globalTeardown.chaos.ts` collects last 200 lines from all 8 containers to `logs/chaos-container-logs.txt` — must happen before stop | `test-docker/globalTeardown.chaos.ts` |
| **Teardown** | Cleans test artifacts (`rm -rf chaos-*`), then stops and removes all 8 containers by exact name | `test-docker/globalTeardown.chaos.ts` |
| **Abnormal exit** | Signal handlers (`SIGINT`/`SIGTERM`) registered during setup stop containers if Jest is killed mid-run (Ctrl+C, VS Code close) | `test-docker/globalSetup.chaos.ts` |

**Key design decisions:**
- Containers are stopped by **exact name** (`sshlite-test-server-1`, `sshlite-os-alpine`, etc.), never by `docker compose down` or wildcard — this ensures other projects' containers are never touched
- Skip-if-running check compares services defined in each compose file against running containers, because both stacks share the same Docker Compose project directory
- Teardown collects container logs → cleans artifacts → stops containers (in that order: logs and artifacts are lost after docker rm)
- sshd logs are volume-mounted to `test-docker/logs/<container-name>/sshd.log` on the host — persists after `docker rm`

### Container Log Collection

Container logs are collected at **three levels**:

| Level | What | Where | When |
|-------|------|-------|------|
| **Per-scenario** | Full sshd logs from the target server's container | `logs/chaos-container-logs.txt` (per-scenario snapshots) | After each scenario in `ChaosEngine.runScenario()` |
| **Final teardown** | Full logs from all 8 containers | Appended to `logs/chaos-container-logs.txt` | In `globalTeardown.chaos.ts` before stopping containers |
| **Volume mount** | Live sshd log file | `test-docker/logs/<container-name>/sshd.log` | Continuously during container lifetime |

### Post-Run Log Analysis

After every chaos run, **analyze all container logs** (both `logs/chaos-container-logs.txt` and `test-docker/logs/*/sshd.log`) for:

| Pattern | What it means |
|---------|--------------|
| `MaxSessions` / `max sessions` | SSH channel limit hit — too many concurrent connections |
| `out of memory` / `oom` | Container memory exhaustion from file ops or connections |
| `no space left on device` | Disk full — chaos test artifacts not cleaned up |
| `too many open files` / `EMFILE` | File descriptor exhaustion from rapid SSH channel creation |
| `segfault` / `segmentation fault` | sshd crash (exit 139) |
| `fatal` / `panic` | Critical server error |
| `connection reset` / `broken pipe` | Client disconnected unexpectedly mid-operation |
| `authentication failure` | Credential mismatch or auth module error |

These server-side patterns reveal issues invisible to the client-side chaos engine. Always review this file after a chaos run, especially when scenarios pass but behavior seems suspicious.

---

## Architecture

```
src/chaos/
  ChaosEngine.ts              # Orchestrator: scenario picker, runner, result collector
  ChaosConfig.ts              # Config types, runtime modes, server configs
  ChaosCollector.ts           # Captures ALL output channels, state events, activity events
  ChaosDetector.ts            # Anomaly detection: scans collected data for issues
  ChaosValidator.ts           # Post-scenario invariant checks
  ChaosLogger.ts              # Structured JSON logging + console summary
  ContainerHealthMonitor.ts   # Real-time Docker container health monitoring
  chaos-helpers.ts            # Connection factory, seeded random, cleanup
  coverage-manifest.json      # Maps extension methods -> scenario coverage
  chaos.test.ts               # Jest entry point
  scenarios/
    index.ts                  # Scenario registry
    connection-lifecycle.ts   # Connect/disconnect/reconnect/state transitions
    file-operations.ts        # File CRUD + invariant verification
    command-guard.ts          # CommandGuard ops + activity tracking
    server-monitor.ts         # ServerMonitor service operations
    concurrent-operations.ts  # Parallel ops, race conditions
    error-paths.ts            # Invalid inputs, permission errors
    mixed-workflows.ts        # Multi-step user workflow simulations
```

---

## Bug Discovery Strategies

### Strategy 1: Invariant Checking
Every operation verifies its contract. Violations = bug found.

| Operation | Invariant |
|-----------|-----------|
| `writeFile(path, content)` | `readFile(path)` returns exact same content |
| `mkdir(path)` | `listFiles(parent)` includes the new dir |
| `deleteFile(path)` | `stat(path)` throws SFTPError |
| `rename(old, new)` | `stat(old)` throws, `stat(new)` succeeds |
| Any non-disconnect op | Connection state is `Connected` |
| Any CommandGuard op | ActivityService records matching activity |
| Scenario end | Zero running activities (no leaks) |

### Strategy 2: Extension Output Capture
Intercepts all 5 output channels via `ChaosCollector`:
- `SSH Lite`, `SSH Lite Commands`, `SSH Lite Audit`, `SSH Lite Monitor`, `SSH Lite - Server Backups`

Scans for: unexpected errors, SFTP error codes, state transitions after disconnect, missing events.

### Strategy 3: State Event Timeline
Hooks `SSHConnection.onStateChange`, `SSHConnection.onFileChange`, `ActivityService.onDidChangeActivities`.
Detects: double Connected events, activity leaks, phantom file events.

### Strategy 4: Resource Leak Detection
Before/after each scenario: checks `ActivityService.getRunningActivities().length`, event listener counts, open connections.

### Strategy 5: Behavioral Contract Testing
Multi-step contracts: post-disconnect operations throw, concurrent writes don't corrupt, search results are statable.

### Strategy 6: Edge Case Fuzzing
Special characters in filenames, empty files, binary content, rapid create/delete cycles.

### Strategy 7: Code Change Tracking
`coverage-manifest.json` maps extension methods to scenario coverage. Engine warns about uncovered methods.

### Strategy 8: Real-Time Container Health Monitoring
`ContainerHealthMonitor` watches all Docker containers throughout the chaos run:

1. **Pre-flight check**: Before any scenario runs, verifies all containers are alive. Non-running containers are reported immediately with their status and exit code.
2. **Real-time polling**: Polls container status every 5 seconds via `docker inspect`. Detects transitions from `running` to `exited`/`dead`.
3. **Immediate death reporting**: When a container dies mid-run, the monitor:
   - Prints a loud `!!!` alert to console immediately (not deferred to end)
   - Collects last 50 lines of container logs via `docker logs`
   - Auto-analyzes cause of death based on exit code + log patterns:
     - Exit 137 → OOM / SIGKILL
     - Exit 139 → Segfault
     - Exit 143 → SIGTERM (external stop)
     - Log patterns: `out of memory`, `no space left`, `too many open files`, `fatal`
   - Correlates with chaos activity (e.g., "too many concurrent SSH channels")
   - Fires `onDeath` callback so the engine can react
4. **Post-run health report**: Final report includes:
   - `monitored` / `healthy` / `dead` counts
   - Full `ContainerDeathEvent[]` with timestamps, exit codes, logs, and analysis
   - Per-container final status

**Container name mapping** (hardcoded in `ContainerHealthMonitor.ts`):

| Server Label | Container Name |
|---|---|
| prod-server | sshlite-test-server-1 |
| staging-server | sshlite-test-server-2 |
| dev-server | sshlite-test-server-3 |
| alpine-server | sshlite-os-alpine |
| ubuntu-server | sshlite-os-ubuntu |
| debian-server | sshlite-os-debian |
| fedora-server | sshlite-os-fedora |
| rocky-server | sshlite-os-rocky |

---

## Post-Run Analysis

After all scenarios complete, `ChaosEngine.generatePostRunAnalysis()` produces a structured analysis covering:

| Analysis Area | What It Reports |
|---|---|
| Pass rate | Overall pass/fail percentage |
| Container health correlation | Links container deaths to scenario failures on that server |
| Per-OS failure patterns | Highlights OS-specific failure rates |
| Anomaly breakdown | Groups anomalies by type with counts |
| Coverage gaps | Lists unexercised actions and uncovered methods |
| Invariant violation rate | Percentage of invariant checks that failed |
| Output channel errors | Channels with error patterns in their output |
| Duration insights | Total time and average per scenario |

The analysis is:
- Printed in the console summary under `POST-RUN ANALYSIS`
- Saved in the JSONL log as `post_run_analysis: string[]`
- Designed for quick human scanning — each line is a self-contained insight

---

## Timeout Safeguards (Preventing Infinite Runs)

The chaos engine has layered timeout protection to guarantee it always finishes:

### Layer 1: Per-Operation Timeouts (`withTimeout()`)

All async operations in cleanup and connection code are wrapped with `withTimeout()` from `chaos-helpers.ts`:

| Operation | Timeout | Location |
|---|---|---|
| `conn.connect()` | 45s | `createChaosConnection()` in `chaos-helpers.ts` |
| `conn.disconnect()` | 10s | `safeChaosDisconnect()` in `chaos-helpers.ts` |
| `conn.exec('rm -rf ...')` cleanup | 10s | `ChaosEngine.runScenario()` + 4 scenario `makeResult()` functions |

### Layer 2: Per-Scenario Timeout

`ChaosEngine.runScenario()` wraps each scenario function with `Promise.race()`:
- Quick mode: 30s per scenario
- Deep mode: 60s per scenario

### Layer 3: Global Time Budget

`ChaosEngine.run()` checks elapsed time before each scenario:
- Quick mode: 300s max (80% of Jest's 360s timeout)
- Deep mode: 780s max (~87% of Jest's 900s timeout)
- When exceeded, prints `GLOBAL TIMEOUT` and stops remaining scenarios gracefully

### Layer 4: Dead Server Skipping

When `ContainerHealthMonitor` detects a container death, the server label is added to `deadServers: Set<string>`. All remaining scenarios for that server are skipped with a `SKIP` log message instead of attempting connections that will fail.

### Layer 5: Jest Outer Timeout

Final safety net configured in `jest.chaos.config.js`:
- Quick mode: 360s (6 min)
- Deep mode: 900s (15 min)

### Layer 6: Monitor Cleanup

`healthMonitor.stop()` is guaranteed to run via `try/finally` in `ChaosEngine.run()`, preventing `setInterval` leaks even if the engine crashes.

---

## Servers Tested

| Mode | Basic (2201-2203) | Multi-OS (2210-2214) | Client OS |
|------|-------------------|----------------------|-----------|
| quick | All 3 Alpine | All 5 (Alpine/Ubuntu/Debian/Fedora/Rocky) | Local |
| deep | All 3 Alpine | All 5 (Alpine/Ubuntu/Debian/Fedora/Rocky) | Local + CI matrix |

---

## Output

### Console Summary
Shows per-OS pass/fail, failures with invariant violations, anomalies detected, coverage stats, uncovered methods, container health status, and post-run analysis.

### Structured Log (`logs/chaos-results.jsonl`)
Each run appends a JSON line with: `per_os_summary`, `anomalies_detected`, `coverage`, `output_summary`, `container_health`, `post_run_analysis`.

---

## Weekly AI Review Checklist

1. Run `npm run test:chaos:deep`, analyze results
2. Read `logs/chaos-results.jsonl` -- compare with previous runs
3. **Code change catchup**: Check `coverage.methods_uncovered` -- add scenarios for new/changed methods
4. **Coverage gaps**: Check `actions_missed` -> add scenarios
5. **Anomaly patterns**: Check `anomalies_detected` -> are they real bugs?
6. **Output analysis**: Check `output_summary` -> new error patterns in channels?
7. **Detection improvement**: Add new rules to `ChaosDetector` for patterns found
8. **Invariant expansion**: Add new invariants to `ChaosValidator` for edge cases found
9. **Strategy review**: Which scenario categories find the most bugs? Adjust weights
10. **Manifest update**: Update `coverage-manifest.json` to reflect new scenarios
11. Commit all enhancements with descriptive message

---

## Adding New Scenarios

1. Create a function matching `ScenarioFn` type in the appropriate scenario file
2. Add it to the scenario file's exported array
3. Register the file in `scenarios/index.ts` if it's a new file
4. Update `coverage-manifest.json` to map methods covered
5. Run `npm run test:chaos` to verify
