# Chaos Bug Discovery Module

Dynamic bug-discovery system: exercises extension code against real Docker SSH containers with randomized scenarios, captures output, uses detection strategies to find issues.

```bash
npm run test:chaos                    # Quick (3-5 min, 8 servers)
npm run test:chaos:deep               # Deep (10+ min, 8 servers)
CHAOS_SEED=42 npm run test:chaos      # Reproducible run
```

**Requires**: Docker Desktop running. Containers managed automatically.

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

See `src/chaos/` — `ChaosEngine` (orchestrator), `ChaosConfig`, `ChaosCollector` (output capture), `ChaosDetector` (anomaly detection), `ChaosValidator` (invariants), `ChaosLogger` (JSON logging), `ContainerHealthMonitor`, `chaos-helpers`, `coverage-manifest.json`, `chaos.test.ts`, `scenarios/` (7 files + index).

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

## Servers

| Mode | Basic (2201-2203) | Multi-OS (2210-2214) |
|------|-------------------|----------------------|
| quick/deep | 3 Alpine | Alpine, Ubuntu, Debian, Fedora, Rocky |

## Output

**Console**: per-OS pass/fail, failures with invariants, anomalies, coverage, container health, analysis.
**JSONL** (`logs/chaos-results.jsonl`): `per_os_summary`, `anomalies_detected`, `coverage`, `output_summary`, `container_health`, `post_run_analysis`.

## Weekly AI Review Checklist

1. Run `test:chaos:deep`, analyze results
2. Read JSONL, compare with previous runs
3. Check `coverage.methods_uncovered` → add scenarios
4. Check `actions_missed` → add scenarios
5. Check `anomalies_detected` → real bugs?
6. Check `output_summary` → new error patterns?
7. Add detection rules to `ChaosDetector`
8. Add invariants to `ChaosValidator`
9. Review scenario category weights
10. Update `coverage-manifest.json`
11. Commit enhancements

## Adding New Scenarios

1. Create function matching `ScenarioFn` in appropriate scenario file
2. Add to exported array
3. Register in `scenarios/index.ts` if new file
4. Update `coverage-manifest.json`
5. Run `npm run test:chaos` to verify
