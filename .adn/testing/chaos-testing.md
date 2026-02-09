# Chaos Bug Discovery Module

Dynamic bug-discovery system that exercises actual extension code against real Docker SSH containers with randomized scenarios, captures all extension output, and uses deliberate detection strategies to find issues before users do.

---

## Quick Reference

```bash
npm run test:chaos                    # Quick mode (3-5 min, 8 servers)
npm run test:chaos:deep               # Deep mode (10+ min, 8 servers)
CHAOS_SEED=42 npm run test:chaos      # Reproducible run
```

**Requires**: Docker Desktop running with both `docker-compose.yml` and `docker-compose.multios.yml` containers.

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

---

## Servers Tested

| Mode | Basic (2201-2203) | Multi-OS (2210-2214) | Client OS |
|------|-------------------|----------------------|-----------|
| quick | All 3 Alpine | All 5 (Alpine/Ubuntu/Debian/Fedora/Rocky) | Local |
| deep | All 3 Alpine | All 5 (Alpine/Ubuntu/Debian/Fedora/Rocky) | Local + CI matrix |

---

## Output

### Console Summary
Shows per-OS pass/fail, failures with invariant violations, anomalies detected, coverage stats, uncovered methods.

### Structured Log (`logs/chaos-results.jsonl`)
Each run appends a JSON line with: `per_os_summary`, `anomalies_detected`, `coverage`, `output_summary`.

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
