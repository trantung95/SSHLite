# Chaos Engine

A real chaos-testing system: dynamic sessions of concurrent user-like chains, multi-topology, real fault injection, universal invariants, replayable.

```bash
npm run test:chaos                    # Quick mode (~5 min, 8 servers)
npm run test:chaos:deep               # Deep mode (~13 min, 8 servers)
CHAOS_SEED=42 npm run test:chaos      # Reproducible run
npm run chaos:catalog                 # Regenerate catalog from .adn/ + package.json
npm run chaos:replay -- <run-id>      # Re-run a logged session deterministically
```

**Requires:** Docker Desktop running. Containers managed automatically via `globalSetup.chaos.ts` / `globalTeardown.chaos.ts`.

---

## Basis

Chaos exists to find bugs no static check or unit test can: race conditions, leaked listeners, broken contracts under hostile environment conditions. Three pillars:

1. **Dynamic sessions, dynamic data** — every run composes a random sequence of user-like chains with random parameters. No scripted scenarios.
2. **Real fault injection** — `docker pause`, `tc netem`, sshd signals, disk fill. The world misbehaves while the chains run.
3. **Universal invariants** — checked around every primitive op and at session end; violations are reproducible from `{seed, session}`.

A run that doesn't exercise dynamic data, fault injection, or invariant checking fails this basis.

---

## Concepts

| Term | Meaning |
|---|---|
| Action | A user-level task (e.g. "Edit a file") declared in `.adn/features/*.md` `## User Actions` tables; expands to a list of primitive ops |
| Primitive | An atomic op on `SSHConnection` or a service (e.g. `writeFile`, `runShort`, `saveCredential`); registered in `src/chaos/primitives/` |
| Persona | A weighted distribution over actions defining "what kind of user is this chain pretending to be" — explorer, editor, operator, watcher, searcher, admin |
| Chain | A sequence of primitive ops drawn from a persona's action distribution; runs concurrently with sibling chains via `Promise.all` |
| Per-server session | One shared `SSHConnection` exercised by k chains, with optional fault injection |
| Session | The unit of one chaos run — picks a topology, builds per-server sessions, runs them, logs result |
| Topology | A/B/C/D — single, fan-out, fan-in, mesh — controls multi-server / multi-user fan |
| Fault | A hostile environment condition with `inject` / `recover` (e.g. `dockerPause`, `netem`, `sshdSignal`, `diskFill`) |
| Invariant | A universal check before/after every primitive op or at session end |

---

## Action catalog auto-derived from .adn/

Each `.adn/features/*.md` declares its user actions in a `## User Actions` markdown table.

Pipeline:

```
.adn/features/*.md  -> npm run chaos:catalog -> src/chaos/catalog/actions.json
.adn/flow/*.md      ->                       -> src/chaos/catalog/flows.json
package.json        ->                       -> src/chaos/catalog/commands.json
```

The on-disk JSON is checked in. The drift test (`src/__tests__/chaos/catalogDrift.test.ts`) re-runs the parser and fails if `.adn` and the JSON have drifted. New `.adn` features automatically extend chaos coverage.

---

## Topologies

| Code | Quick | Deep | What runs | Stresses |
|---|---|---|---|---|
| A. Single | 60% | 50% | 1 connection -> 1 server, k chains concurrent | ChannelSemaphore, single-connection registries, listener leaks |
| B. Fan-out | 25% | 25% | 1 user -> 2-4 servers, each with its own per-server session | ConnectionManager isolation, parallel handshakes |
| C. Fan-in | 12% | 17% | M users -> 1 server (fresh ConnectionManagers) | sshd MaxSessions, server-side load |
| D. Mesh | 3% | 8% | M users x N servers | Full system invariants under everything simultaneous |

---

## Fault catalog (v0.8.0)

| Layer | Fault | Mechanism | Recovery |
|---|---|---|---|
| Network | `dockerPause` | `docker pause <container>` | `docker unpause` |
| Network | `netem` (NET_ADMIN) | `tc qdisc add dev eth0 root netem delay <ms> loss <pct>` | `tc qdisc del dev eth0 root` |
| Server | `sshdSignal` | `pkill -STOP sshd` | `pkill -CONT sshd` |
| Resource | `diskFill` | `dd if=/dev/zero of=/var/log/chaos-fill bs=1M count=N` | `rm -f` |

0 or 1 fault per session, weighted by mode (quick ~30%, deep ~70%). Injection at uniform-random offset in [0.2 x estimated session, 0.8 x estimated session]. Faults requiring `NET_ADMIN` skip cleanly when caps are absent.

More faults (`iptablesRst`, `sshdKill`, `maxSessions`, `fdExhaust`, `stressCpu`, `stressMem`, `clockSkew`, `chmodLock`, `yankFile`) ship in v0.8.1.

---

## Invariants (v0.8.0)

| Invariant | When | What it checks |
|---|---|---|
| `sshStateMachine` | after-each-op | Connection state is in the valid set |
| `semaphoreFloor` | after-each-op | ChannelSemaphore counters never go negative |
| `cleanShutdown` | after-each-op | Stub for v0.8.0; rich post-disconnect-error contract lands in v0.8.1 |
| `listenerLeak` | after-session | Emitter listener counts return to baseline (threshold 10) |
| `activityCount` | after-session | `ActivityService.getRunningActivities().length` does not grow across the session |
| `sessionTeardown` | after-session | Connection is `Disconnected` at session end |

More invariants (`treeConsistency`, `hoverCorrectness`, `decorationConsistency`, `credentialAtomicity`, `commandIdempotence`, `backgroundQuiescence`, `disposalCleanup`, `crossConnectionIsolation`, plus the rich `cleanShutdown`) ship in v0.8.1.

---

## Replay format

One JSONL line per session in `logs/chaos-results.jsonl`. Each line has `{run_id, seed, mode, topology, perServerSessions, outcome, duration_ms, primitives_exercised, actions_used, faults_injected, invariant_checks, invariant_violations}`.

The full op trace is preserved per chain, including primitive names, params, fault timing, and start delays — sufficient for byte-for-byte deterministic replay.

`outcome` is `"passed"` or `{"violation": "<invariant>", ...}` or `{"exception": "..."}`.

---

## Replayer

Re-execute any logged session deterministically:

```bash
npm run chaos:replay -- <run_id>
```

Loads the JSONL entry, walks the recorded ops directly with the same primitives, honours `startDelayMs` and `fault.atMs`. Useful for debugging — set breakpoints, step through, attach to your editor.

Shrinker (delta-debug to minimal failing subset) ships in v0.8.2.

---

## Container Lifecycle

| Phase | Action |
|---|---|
| Log cleanup | `globalSetup.chaos.ts` deletes previous logs |
| Setup | Brings up both compose stacks (ports 2201-2203 + 2210-2214); waits for SSH readiness on 8 servers |
| Log collection | `globalTeardown.chaos.ts` collects last 200 lines from all containers to `logs/chaos-container-logs.txt` |
| Teardown | Cleans artifacts, stops containers by **exact name** (never `docker compose down`) |
| Abnormal exit | Signal handlers stop containers if Jest is killed mid-run |

**Design:** Exact container names protect other projects. Teardown order: logs -> artifacts -> stop. sshd logs volume-mounted to `test-docker/logs/<container>/sshd.log`.

`ContainerHealthMonitor` polls every 5s; when sshd dies but `docker inspect` still says "running", consecutive connection failures trigger dead-server skip after 3 in a row.

### Container Log Analysis

Per-session snapshots, final teardown, volume-mounted live sshd logs. Watch for: `MaxSessions`, `out of memory`, `no space left`, `too many open files`, `segfault`, `fatal`, `connection reset`, `authentication failure`.

---

## Architecture

```
src/chaos/
  ChaosEngine.ts              session orchestrator
  ChaosConfig.ts              modes, budgets, fault rate, topology distribution
  ChaosLogger.ts              JSONL emitter
  ChaosTypes.ts               PrimitiveOp, Persona, Action, Fault, Invariant, Session, Chain, RunResult
  ContainerHealthMonitor.ts   dead-server detection
  chaos-helpers.ts            createChaosConnection, safeChaosDisconnect, SeededRandom, mocks
  chaos.test.ts               jest entry
  catalog/
    actions.json   commands.json   flows.json     (generated, checked in)
    builder.ts     loader.ts       personas.ts
  primitives/
    sshOps/{connection,run,file}.ts
    serviceOps/credentialOps.ts
    index.ts
  invariants/...                + index.ts
  faults/...                    + index.ts
  generator/...
  replay/ChaosReplayer.ts
```

---

## Weekly AI Review Checklist

1. Run `test:chaos:deep`. Read JSONL summary: how many sessions ran? Topologies covered? Faults fired?
2. Triage `invariant_violations` by `invariant` field. Each violation should reproduce via `npm run chaos:replay -- <run-id>`.
3. Check `actions_used` coverage — actions that never appear are likely dropped by all personas; either add a referencing persona weight or delete the action.
4. Inspect `primitives_exercised` rate — primitives that never fire indicate registry gaps or generator skip-bugs.
5. If a session times out or hangs, look at `duration_ms` percentile. Adjust `globalBudgetMs` only as a last resort; prefer fixing the underlying primitive cost.

---

## Adding new coverage

| Adding... | Where |
|---|---|
| A new user action | `## User Actions` table in the relevant `.adn/features/*.md`, then `npm run chaos:catalog` |
| A new primitive | New file in `src/chaos/primitives/<surface>/` + register in `src/chaos/primitives/index.ts` + reference from at least one action |
| A new fault | New file in `src/chaos/faults/` + register in `src/chaos/faults/index.ts` |
| A new invariant | New file in `src/chaos/invariants/` + register in `src/chaos/invariants/index.ts` |
| A new persona | Entry in `src/chaos/catalog/personas.ts` referencing existing actions |

The test suite enforces drift — if you change `.adn/features/*.md` without running `npm run chaos:catalog`, `catalogDrift.test.ts` fails.
