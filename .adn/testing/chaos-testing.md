# Chaos Bug Discovery Module

Dynamic bug-discovery system: exercises extension code against real Docker SSH containers with randomized scenarios, captures output, uses detection strategies to find issues.

```bash
npm run test:chaos                    # Quick (3-5 min, 8 servers)
npm run test:chaos:deep               # Deep (10+ min, 8 servers)
CHAOS_SEED=42 npm run test:chaos      # Reproducible run
```

**Requires**: Docker Desktop running. Containers managed automatically.

---

## Basis & Non-Goals

**Basis**: every scenario must advance one or more of the 8 bug-discovery strategies (see "Bug Discovery Strategies" below). Chaos exists to find bugs no static check or unit test can — race conditions, leaked listeners, broken contracts under real network/filesystem behavior.

**Is**:
- Real Docker SSH containers (5 OS variants), real `ssh2` traffic, real timing.
- Invariant verification (every write/delete/mkdir/rename holds its contract).
- Output channel scanning, state-timeline anomaly detection, resource-leak counting.
- Coverage-driven — `coverage-manifest.json` maps methods → scenarios; gaps are surfaced.

**Is NOT**:
- A unit-test substitute (those live in `src/__tests__/` and are mocked).
- A performance benchmark (`duration_ms` is a budget signal, not a perf metric).
- A smoke test (a "passes once" scenario without an invariant adds no value).
- A place to dump integration tests that fit elsewhere.

A new scenario without an invariant or output/state assertion fails this basis and should be rejected.

---

## Container Lifecycle

| Phase | Action |
|-------|--------|
| Log cleanup | `globalSetup.chaos.ts` deletes previous logs |
| Setup | Starts both compose stacks (ports 2201-2203 + 2210-2214), waits for SSH readiness on 8 servers |
| Log collection | `globalTeardown.chaos.ts` collects last 200 lines from all containers to `logs/chaos-container-logs.txt` |
| Teardown | Cleans artifacts (`rm -rf chaos-*`), stops containers by **exact name** (never `docker compose down`) |
| Abnormal exit | Signal handlers stop containers if Jest killed mid-run |

**Design**: Exact container names protect other projects. Teardown order: logs → artifacts → stop (data lost after docker rm). sshd logs volume-mounted to `test-docker/logs/<container>/sshd.log`.

### Container Log Analysis

Three levels: per-scenario snapshots, final teardown (all 8), volume-mounted live sshd logs. Check for: `MaxSessions`, `out of memory`, `no space left`, `too many open files`, `segfault`, `fatal`, `connection reset`, `authentication failure`.

---

## Architecture

See `src/chaos/` — `ChaosEngine` (orchestrator), `ChaosConfig`, `ChaosCollector` (output capture), `ChaosDetector` (anomaly detection), `ChaosValidator` (invariants), `ChaosLogger` (JSON logging), `ContainerHealthMonitor`, `chaos-helpers`, `coverage-manifest.json`, `chaos.test.ts`, `scenarios/` (11 files + index: connection-lifecycle, file-operations, command-guard, server-monitor, concurrent-operations, error-paths, mixed-workflows, ssh-tools, ssh-tools-keys, channel-semaphore, port-forward).

## Bug Discovery Strategies

1. **Invariant checking**: writeFile/readFile match, mkdir visible, delete throws, connection state correct, CommandGuard tracks activity, zero running activities at scenario end
2. **Output capture**: Intercepts 5 output channels, scans for errors/SFTP codes/state issues
3. **State timeline**: Hooks `onStateChange`, `onFileChange`, `onDidChangeActivities` — detects double events, leaks, phantoms
4. **Resource leak detection**: Before/after activity counts, listener counts, connections
5. **Behavioral contracts**: Post-disconnect ops throw, concurrent writes don't corrupt
6. **Edge case fuzzing**: Special chars, empty files, binary content, rapid create/delete
7. **Code change tracking**: `coverage-manifest.json` maps methods → scenarios, warns about gaps
8. **Container health monitoring**: Pre-flight container check, 5s polling via `docker inspect`, immediate death alerts with exit code analysis (137=OOM, 139=segfault, 143=SIGTERM), post-run health report

Container names: `sshlite-test-server-{1,2,3}` (prod/staging/dev), `sshlite-os-{alpine,ubuntu,debian,fedora,rocky}`.

## Post-Run Analysis

`ChaosEngine.generatePostRunAnalysis()`: pass rate, container health correlation, per-OS patterns, anomaly breakdown, coverage gaps, invariant violation rate, output errors, duration insights. Printed + saved in JSONL log.

## Timeout Safeguards (6 layers)

1. **Per-operation**: `withTimeout()` — connect 45s, disconnect 10s, cleanup exec 10s
2. **Per-scenario**: `Promise.race()` — quick 30s, deep 60s
3. **Global budget**: quick 300s (80% of Jest), deep 780s (~87% of Jest)
4. **Dead server skip**: `ContainerHealthMonitor` death → skip remaining scenarios for that server
5. **Jest outer**: quick 360s, deep 900s
6. **Monitor cleanup**: `healthMonitor.stop()` in `try/finally`

## Budget Policy

Deep mode budget is **780 s of wall time across ~1,120 runs** (112 scenarios × 10 variations) on 8 servers serially per scenario.

- **Average ceiling**: ~695 ms/scenario. Exceeding this in aggregate produces `early_termination: global_timeout` and silently skips remaining scenarios — strategies #1–#6 only fire on scenarios that run, so a timeout collapses signal far beyond the slow scenario itself.
- **Per-scenario p95**: ≤ 4× average (≤ 2.8 s) before flagging.
- **Heavy scenarios** (channel-semaphore, ssh-key push, server-monitor): wrap long ops in `withTimeout(..., 5000)` and tag `weight: 'heavy'` in the `ScenarioDefinition`. The engine samples heavy scenarios at `ceil(variations / 3)` instead of `variations`, freeing budget without losing coverage.
- **When `early_termination=global_timeout` happens**: read `post_run_analysis.slowest_scenarios` (top 10 by p95). Mark slowest scenarios `heavy` or split them. Do not raise the budget — that hides real regressions.

## Coverage Triage

`coverage.methods_uncovered` is not a flat list. Triage by call-site reachability:

- **P0 — must cover**: methods reachable from any user-facing command. Examples currently uncovered: `SSHConnection.dispose`, `forwardPort`/`stopForward`/`getActiveForwards`, `watchFile`/`unwatchFile`/`isWatching`/`unwatchAll`, `fileExists`, `readFileChunked`/`readFileFirstLines`/`readFileLastLines`/`readFileTail`, `CommandGuard.startConnect`/`completeConnect`/`failConnect`/`trackDisconnect`. **Action**: add a scenario with a real invariant.
- **P1 — should cover**: stateful lifecycle methods (`CommandGuard.startMonitoring`/`updateMonitoring`/`stopMonitoring`/`startRefresh`/`completeRefresh`/`failRefresh`, `ServerMonitorService.watchStatus`/`checkService`/`watchLiveTerminal`, `PortForwardService.restoreForwardsForConnection`/`deactivateAllForwardsForConnection`, `ActivityService.cancelAllForConnection`/`cancelAll`/`clearAll`). **Action**: cover via lifecycle scenarios that thread several methods through one run.
- **P2 — defer**: pure parsers and synchronous getters fully exercised by unit tests (`parseProcessOutput`, `parseServiceOutput`, `getRunningActivities`, `hasClipboard`, `getUserSnippets`). **Action**: leave to unit tests; do not waste chaos budget here. Optionally move to a `unit-tested` bucket in the manifest so the warning surface points only at real gaps.

## Servers

| Mode | Basic (2201-2203) | Multi-OS (2210-2214) |
|------|-------------------|----------------------|
| quick/deep | 3 Alpine | Alpine, Ubuntu, Debian, Fedora, Rocky |

## Output

**Console**: per-OS pass/fail, failures with invariants, anomalies, coverage, container health, analysis.
**JSONL** (`logs/chaos-results.jsonl`): `per_os_summary`, `anomalies_detected`, `coverage`, `output_summary`, `container_health`, `post_run_analysis`.

### Scenario Heat Map

`post_run_analysis.slowest_scenarios` lists the top 10 scenarios by p95 `duration_ms`, with `{name, p95_ms, runs}`. This makes budget regressions visible without grepping JSONL — when a deep run nears the global budget, this list names the offenders. Also surfaced when `early_termination` fires.

## Weekly AI Review Checklist

1. Run `test:chaos:deep`. **First check**: did it `early_termination`? If yes, fix budget BEFORE adding scenarios — read `post_run_analysis.slowest_scenarios`, tag offenders `weight: 'heavy'` or split them. A timed-out run produces no signal for 80%+ of scenarios; stacking more on top is wasted work.
2. Read JSONL, compare with previous runs (anomalies, failure clusters, slowest_scenarios drift).
3. Triage `coverage.methods_uncovered` per the **Coverage Triage** section: P0 → new scenario this cycle; P1 → lifecycle scenario; P2 → defer/move to `unit-tested` bucket.
4. Check `actions_missed` → these are scenarios skipped due to budget; if persistent across runs, the budget needs Step 1, not more scenarios.
5. Check `anomalies_detected` → real bugs? Cluster by `name + server_os` to spot OS-specific issues.
6. Check `output_summary` → new error patterns? Add detection rules to `ChaosDetector`.
7. Add invariants to `ChaosValidator` for any new contract uncovered.
8. Review scenario weights — anything still slow despite `heavy`? Split it.
9. Update `coverage-manifest.json` to reflect new scenarios.
10. Commit enhancements with a measurable claim ("uncovered: 49 → N", "p95: X ms → Y ms").

## Adding New Scenarios

1. Create function matching `ScenarioFn` in appropriate scenario file
2. Add to exported array
3. Register in `scenarios/index.ts` if new file
4. Update `coverage-manifest.json`
5. Run `npm run test:chaos` to verify

## Scenario Authoring Policy

Every new scenario must declare three things at review time:

- **Strategy mapping**: which of the 8 bug-discovery strategies it advances (1+). A scenario that maps to none has no place here — write a unit test instead.
- **Invariant**: at least one verifiable contract checked via `ChaosValidator` (write/read match, mkdir visible, delete throws, listener count balanced) or a behavioral assertion in the scenario body. "It didn't throw" is not an invariant.
- **Cost budget**: expected p95 duration. The deep-mode average ceiling is ~695 ms/scenario. Scenarios consistently exceeding this MUST set `weight: 'heavy'` in the `ScenarioDefinition` so the engine samples them at `ceil(variations / 3)`.

Reuse helpers — do not re-implement:
- `createChaosConnection(server)` — connect with chaos defaults
- `safeChaosDisconnect(conn)` — guarded disconnect
- `withTimeout(promise, ms, label)` — per-operation timeout
- `SeededRandom(ctx.seed + ctx.variation)` — reproducible randomness; never `Math.random()`
