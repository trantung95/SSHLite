# Chaos Engine Rebuild Design

**Date:** 2026-05-06
**Status:** Pending review
**Target version:** v0.8.0

## Problem

The current chaos suite (v0.7.7) has two structural defects that nullify most of its declared value:

1. **Only 1 of 12 scenario categories ever runs.** Iteration is `for scenario { for server { for variation } }` and `connection-lifecycle` (the first category) consumes the entire 780 s deep budget across 8 servers before category #2 gets a turn. The latest deep run shows `scenarios_run: 231` — exactly the four `connection-lifecycle:*` entries by run-count. `file-operations`, `command-guard`, `port-forward`, `server-monitor`, `channel-semaphore`, `ssh-tools`, `ssh-tools-keys`, `error-paths`, `mixed-workflows`, `concurrent-operations` never execute.
2. **Coverage telemetry is structurally wrong.** `ALL_KNOWN_ACTIONS` (24 verb-style names) and `recordAction(scenario.category)` (kebab-case category names) are disjoint namespaces, so `actions_missed` always reports all 24 known actions as missing regardless of what ran.

Beyond these defects, the suite does not match what *chaos testing* means in industry usage. It runs hand-written scripted scenarios with seeded-RNG parameter randomization against happy-state Docker containers. There is no failure injection at the environment level (network freeze, sshd kill, packet loss, disk fill, channel exhaustion). Bugs in the extension's behaviour under hostile conditions go undetected.

## Goal

Replace the chaos engine with a real chaos system:

- **Dynamic sessions, dynamic data**: each run composes random chains of user-like actions with random parameters; no scripted scenarios.
- **Concurrent, asynchronous chains**: multiple chains run on the same connection or across connections, with long-running ops (watchers, port forwards, log-tail commands) firing and being cancelled mid-flight.
- **Multiple topologies**: 1 user → 1 server, 1 user → many servers, many users → 1 server, many users → many servers.
- **Real fault injection**: Docker pause, `tc netem`, sshd signals, disk fill, fd exhaust, MaxSessions saturation, clock skew, permission flip, file yank.
- **Whole-extension surface coverage**: SSH ops + VS Code commands + tree providers + hover providers + decoration providers + service ops (credentials/snippets/hosts) + background-process triggers (idle timer, tree pre-load, monitor polling).
- **Auto-derived action catalog from `.adn/`**: features document their user actions; the catalog regenerates from `.adn/` and `package.json contributes.commands`.
- **Replay and shrink**: every failure is reproducible from `{seed, session}`; shrinker reduces to the minimal failing subset.
- **Real VS Code extension-host suite**: a parallel test target that runs the same primitives/personas/invariants under a real Electron VS Code instance, on a slower cadence.

## Non-goals

- Multi-extension-instance simulation (process-level multi-window). Topology C covers the server-side concurrency surface; client-side singleton contention is process-isolated by VS Code's design.
- Visual / screenshot regression. Random sessions diverge in visual state — there is no golden to diff against. Belongs in a separate UI regression suite.
- Performance benchmarking. `duration_ms` remains a budget signal, not a perf metric.
- Replacing unit tests in `src/__tests__/`. Pure parsers and synchronous getters stay there.

---

## Architecture overview

### Module tree

```
src/chaos/
  ChaosEngine.ts              session orchestrator
  ChaosConfig.ts              modes, budgets, fault rate, topology distribution
  ChaosLogger.ts              replay-grade JSONL emitter
  ChaosTypes.ts               PrimitiveOp, Persona, Action, Fault, Invariant, Session, Chain, RunResult
  ContainerHealthMonitor.ts   kept as-is (dead-server cascade detection)
  chaos-helpers.ts            slimmed: createChaosConnection, safeChaosDisconnect, SeededRandom
  chaos.test.ts               jest entry point

  catalog/
    actions.json              GENERATED from .adn/features/*.md User Actions tables
    commands.json             GENERATED from package.json contributes.commands
    flows.json                GENERATED from .adn/flow/*.md
    builder.ts                npm run chaos:catalog regenerates the three JSON files
    loader.ts                 read at test time, validate against PRIMITIVES registry

  primitives/
    index.ts                  exports PRIMITIVES: PrimitiveOp[]
    sshOps/
      connection.ts           connect, disconnect, dispose
      run.ts                  short-cmd run, long-cmd run, failing-cmd run, shell
      file.ts                 writeFile, readFile, listFiles, mkdir, rename, deleteFile, stat,
                              fileExists, searchFiles, readFileChunked, readFileFirstLines,
                              readFileLastLines, readFileTail, listDirectories
      portForward.ts          forwardPort, stopForward, getActiveForwards
      watcher.ts              watchFile, unwatchFile, unwatchAll, isWatching
      commandGuard.ts         guard run, guard.readFile, guard.writeFile, guard.listFiles,
                              guard.searchFiles, startMonitoring, updateMonitoring, stopMonitoring,
                              startRefresh, completeRefresh, failRefresh
      monitor.ts              quickStatus, diagnoseSlowness, listServices, recentLogs,
                              networkDiagnostics, watchStatus, checkService
    vscodeCommands/
      commandInvoker.ts       invokes any registered sshlite.* command via the VS Code commands API
                              with random-but-valid args drawn from current state
    treeOps/
      hostTree.ts             expand, collapse, getChildren, getTreeItem, refresh on HostTreeProvider
      fileTree.ts             same on FileTreeProvider
      activityTree.ts         same on ActivityTreeProvider
      portForwardTree.ts      same on PortForwardTreeProvider
    hoverOps/
      hoverInvoker.ts         provideHover for a tree item; capture popup; validate shape
    decorationOps/
      decorationInvoker.ts    provideFileDecoration for a path; validate consistency
    serviceOps/
      credentialOps.ts        save, retrieve, delete on CredentialService
      hostOps.ts              addHost, deleteHost, updateHost on HostService
      snippetOps.ts           add, rename, update, remove on SnippetService
      folderHistoryOps.ts     push, peek, clear on FolderHistoryService
      remoteClipboardOps.ts   setClipboard, getClipboard, clear, hasClipboard
    backgroundOps/
      idleTimer.ts            force idle-disconnect timer to fire
      preloadTree.ts          force HostTreeProvider lazy-load to run
      monitorPolling.ts       force a single monitor poll tick
      decorationRefresh.ts    force FileDecorationProvider to invalidate-and-recompute
      activityTick.ts         force ActivityService to advance pending state

  faults/
    index.ts                  exports FAULTS: Fault[]
    dockerPause.ts            docker pause / docker unpause
    netem.ts                  tc qdisc add netem delay <ms> loss <pct>; tc qdisc del to recover
    iptablesRst.ts            iptables -I INPUT -p tcp --tcp-flags ALL RST -j DROP
    sshdSignal.ts             pkill -STOP sshd / pkill -CONT sshd
    sshdKill.ts               pkill -KILL sshd (requires entrypoint that restarts sshd)
    maxSessions.ts            spawn N dummy ssh sessions until MaxSessions hit; release on recover
    diskFill.ts               dd if=/dev/zero of=/var/log/fill bs=1M count=N; rm to recover
    fdExhaust.ts              spawn dummy file-descriptors until ulimit -n; release on recover
    stressCpu.ts              stress-ng --cpu N --timeout Ts
    stressMem.ts              stress-ng --vm 1 --vm-bytes 80% --timeout Ts
    clockSkew.ts              date -s "+30 minutes"; date -s on recover
    chmodLock.ts              chmod 000 on the working dir; chmod restore on recover
    yankFile.ts               delete a path another chain is reading

  invariants/
    index.ts                  exports INVARIANTS: Invariant[]
    sshStateMachine.ts        connection state stays in valid set; transitions are legal
    listenerLeak.ts           emitter listener counts return to baseline after dispose
    activityCount.ts          ActivityService running count balances; no leaked activities
    semaphoreFloor.ts         ChannelSemaphore counter never goes negative; no permanent stuck slot
    portForwardRegistry.ts    active-forward set matches successful forwardPort minus successful stopForward
    watcherRegistry.ts        isWatching reflects watch/unwatch parity
    cleanShutdown.ts          post-disconnect ops throw the documented error type, not hang or silently swallow
    crossConnectionIsolation.ts  ops on connection X do not perturb connection Y's state, registry, or activity
    sessionTeardown.ts        at session end, every connection is at a clean baseline
    treeConsistency.ts        provider parent/child graph acyclic; refresh count balanced; no orphan nodes
    hoverCorrectness.ts       hover for known node returns expected shape; hover for deleted node returns null
    decorationConsistency.ts  same path queried twice returns the same decoration unless underlying state changed
    credentialAtomicity.ts    save/delete is all-or-nothing; no half-written entries observable from another chain
    commandIdempotence.ts     idempotent commands repeat-safely; non-idempotent commands declared and gated
    backgroundQuiescence.ts   at session end, no idle timers, monitor polls, or pre-load tasks are pending
    disposalCleanup.ts        after extension.deactivate (simulated), every singleton is reset and every listener detached

  generator/
    SessionGenerator.ts       picks topology, picks personas per chain, generates chains, schedules fault
    ChainGenerator.ts         per-chain action draw (persona-weighted), expands actions to primitives,
                              fills random data; light context-awareness (sometimes read what was written)
    TopologyChooser.ts        weighted draw over A/B/C/D
    FaultScheduler.ts         picks fault, target server(s), injection time
    DataGenerator.ts          random paths, bytes, command strings; weighted "weird" cases
                              (empty, binary, CRLF, unicode, very long)

  replay/
    ChaosReplayer.ts          load {seed, session} from JSONL, re-execute deterministically
    Shrinker.ts               delta-debug a failing session: try halving chains, dropping ops,
                              dropping the fault; smallest still-failing subset wins
                              CLI: npm run chaos:shrink -- <jsonl-line>
```

### Run loop

```
seed
  -> TopologyChooser.pick()             (A | B | C | D)
  -> SessionGenerator.generate(seed, topology)
        (per affected server: connect; pick personas for k chains;
         draw N actions per chain; expand actions -> primitive ops with
         random params; record startDelayMs per chain)
  -> FaultScheduler.schedule(seed, session)
        (0 or 1 fault per session, weighted by mode; random injection time,
         random affected server set)
  -> execute session
        (Promise.all over chains, with start-delay; fire-and-forget for
         long-running primitives; fault inject at scheduled offset;
         invariants snapshot before / check after every primitive; fault recover on completion)
  -> check sessionTeardown invariant
  -> log {seed, topology, session, fault, outcome, primitives_exercised, actions_used, faults_injected}
```

---

## Action catalog auto-derived from .adn/

### Source of truth

- `.adn/features/*.md` — each feature file gains a `## User Actions` section with a markdown table:

  ```markdown
  ## User Actions
  | Action | Primitives | Notes |
  |---|---|---|
  | Browse files | listFiles, listDirectories, stat, fileExists | Often interleaved with reads |
  | Edit a file | readFile, writeFile | Write usually follows read |
  | Rename a file | rename, listFiles | Listing confirms move |
  ```

- `package.json contributes.commands` — already authoritative for VS Code commands; the chaos catalog cross-references this list, no edits needed there.
- `.adn/flow/*.md` — typical sequences are extracted from any "## Flow" or "## Steps" section in flow docs and recorded as `flows.json`.

### Build pipeline

```
.adn/features/*.md  --+
.adn/flow/*.md      --+--> chaos:catalog (npm script)  -->  src/chaos/catalog/{actions,flows,commands}.json
package.json        --+
```

- `npm run chaos:catalog` regenerates the three JSON files. Generated, but checked in for reviewability.
- Jest test `catalog.test.ts` re-runs the parser in-memory and fails if the on-disk JSON drifts from `.adn/`. Same pattern as `docs/COMMANDS.md`.
- Claude Code hook in `.claude/settings.json` regenerates on `.adn/features/*.md` save.
- Adding a new feature with a `## User Actions` table automatically extends chaos coverage. Removing one drops it.

### Action expansion

At test time, `loader.ts` reads the three JSON files and resolves action-name → primitive-op references against the registered `PRIMITIVES` table. A reference to a non-existent primitive is a hard error.

Each action becomes a small ordered template the chain generator can expand. Actions with N primitives in their table emit a chain segment of N ops. Multiple actions in a single chain are concatenated with optional reordering inside an action permitted by an explicit `unordered: true` marker (default: ordered).

---

## Personas

A persona is a weighted distribution over actions, defining "what kind of user is this chain pretending to be." Personas are declared in `src/chaos/catalog/personas.ts` (hand-curated; only 7-8 entries) and reference action names by string:

| Persona | Primary actions | What user is doing |
|---|---|---|
| explorer | Browse files, Reveal in tree, Hover on tree item | Browsing the file tree |
| editor | Edit a file, Rename a file, Save credential | Editing files |
| operator | Run terminal, Run command, Save snippet | Running commands |
| watcher | Watch file, Tail logs, Stop watcher | Following log files |
| networker | Forward port, Stop forward, List forwards | Port forwarding |
| monitor | Quick status, Recent logs, List services, Diagnose slowness | Watching server health |
| searcher | Cross-file search, Open match, Reveal match | Cross-file search |
| admin | Save credential, Delete credential, Add host, Delete host | Configuration tasks |

A persona's missing weight on an action means the action is never drawn for that persona; the action remains available to other personas.

---

## Topologies

| Code | Distribution | What runs | What it stresses |
|---|---|---|---|
| **A. Single** | ~60% (quick), ~50% (deep) | 1 connection -> 1 server, k chains concurrent (k drawn from [1, 4]) | ChannelSemaphore, single-connection registries, listener leaks |
| **B. Fan-out** | ~25% (quick), ~25% (deep) | 1 user -> 2-4 servers; each server has its own per-server session (chains, fault) | ConnectionManager isolation, cross-connection state, parallel handshakes |
| **C. Fan-in** | ~12% (quick), ~17% (deep) | M users (3-6 fresh ConnectionManager instances) -> 1 server | sshd MaxSessions saturation, our auth-race handling, server-side load |
| **D. Mesh** | ~3% (quick), ~8% (deep) | M users x N servers | Full system; invariants must hold under everything simultaneous |

Topology drawn at session start from a weighted distribution. Per-mode rates above. Multi-server topologies (B/D) iterate primitives across `Promise.all` over per-server sub-sessions; multi-user topologies (C/D) instantiate fresh `ConnectionManager` instances and ensure singleton resets between sessions.

---

## Concurrency model

- **Per-server session**: one shared `SSHConnection` exercised by k chains via `Promise.all`, with random per-chain `startDelayMs` in [0, 500] ms.
- **Long-running primitives**: any primitive flagged `longRunning: true` (`watchFile`, `forwardPort`, log-tail commands) is fire-and-forget; the chain immediately advances to its next op. The session generator inserts a matching cancellation primitive (`unwatchFile`, `stopForward`, exec-channel close) somewhere later in the same chain or in a sibling chain.
- **Per-chain error handling**: each chain catches its own primitive errors and records them; sibling chains continue. Session is judged on invariants, not on per-op errors.
- **Topology B/C/D**: each per-server or per-user sub-session is itself a `Promise.all` over its own chains; the top-level session is `Promise.all` over sub-sessions.

---

## Fault injection

### Catalog (final, this release)

| Layer | Fault | Mechanism | Recovery |
|---|---|---|---|
| Network | dockerPause | `docker pause <container>` | `docker unpause` |
| Network | netem | `tc qdisc add dev eth0 root netem delay <ms> loss <pct>` | `tc qdisc del root` |
| Network | iptablesRst | `iptables -I INPUT -p tcp --tcp-flags ALL RST -j DROP` | `iptables -D` the rule |
| Server | sshdSignal | `pkill -STOP sshd` | `pkill -CONT sshd` |
| Server | sshdKill | `pkill -KILL sshd` | container entrypoint restarts sshd |
| Server | maxSessions | spawn dummy ssh channels until MaxSessions hit | close dummy channels |
| Resource | diskFill | `dd if=/dev/zero of=/var/log/fill bs=1M count=N` | `rm /var/log/fill` |
| Resource | fdExhaust | spawn dummy sockets until `ulimit -n` | close them |
| Resource | stressCpu | `stress-ng --cpu N --timeout Ts` | runs out (Ts) |
| Resource | stressMem | `stress-ng --vm 1 --vm-bytes 80% --timeout Ts` | runs out (Ts) |
| Time | clockSkew | `date -s "+30 minutes"` | `date -s` back to NTP |
| FS | chmodLock | `chmod 000` working dir | `chmod` restore |
| FS | yankFile | delete a path another chain is reading | none (test cleanup) |

### Scheduling

- 0 or 1 fault per session. Mode-dependent rate: quick ~30% of sessions get a fault; deep ~70%.
- Some sessions stay clean to provide baseline behaviour data.
- Fault `inject` runs at a uniform-random offset in [0.2 x estimated session duration, 0.8 x estimated session duration].
- `recover` runs when the session's `Promise.all` settles or after a hard cap (e.g. 30 s), whichever first.
- Faults requiring elevated container caps (`tc`, `iptables`, `pkill`) are gated on `--cap-add NET_ADMIN/SYS_ADMIN` availability; missing caps trigger an explicit skip with a log line.

---

## Invariants

Every primitive call snapshots all enabled invariants before execution and checks them after; some invariants additionally check at session end. Violations record `{invariant, where, before, after, detail}` and mark the session failed; the session continues running so we can collect a complete picture.

Full list in the module tree above. Each invariant lives in its own file; all are registered into `INVARIANTS[]` and selected by mode (quick mode skips expensive invariants like `disposalCleanup`).

---

## Replay format

Each session writes one JSONL line to `logs/chaos-results.jsonl`:

```json
{
  "run_id": "uuid-v4",
  "timestamp": "2026-05-06T10:00:00.000Z",
  "seed": 1234567890,
  "mode": "deep",
  "topology": "B",
  "perServerSessions": [
    {
      "server": {"label": "alpine-server", "os": "Alpine", "port": 2210},
      "chains": [
        {
          "persona": "editor",
          "startDelayMs": 0,
          "actions": ["Edit a file", "Browse files"],
          "ops": [
            {"primitive": "connect"},
            {"primitive": "readFile", "path": "/tmp/chaos-abc", "encoding": "utf8"},
            {"primitive": "writeFile", "path": "/tmp/chaos-abc", "bytesLen": 1024, "bytesSeed": 42},
            {"primitive": "listFiles", "path": "/tmp"},
            {"primitive": "disconnect"}
          ]
        },
        {
          "persona": "operator",
          "startDelayMs": 142,
          "actions": ["Run terminal"],
          "ops": []
        }
      ],
      "fault": {
        "name": "netem",
        "atMs": 1500,
        "params": {"delay_ms": 200, "loss_pct": 5},
        "recoveredAtMs": 4250
      }
    },
    {
      "server": {"label": "ubuntu-server", "os": "Ubuntu", "port": 2211},
      "chains": [],
      "fault": null
    }
  ],
  "outcome": "passed",
  "duration_ms": 4321,
  "primitives_exercised": ["connect", "readFile", "writeFile", "listFiles", "disconnect"],
  "actions_used": ["Edit a file", "Browse files", "Run terminal"],
  "faults_injected": ["netem"],
  "invariant_checks": 47,
  "invariant_violations": []
}
```

`outcome` is `"passed"` or an object: `{"violation": "<invariant>", "chain": <i>, "opIndex": <j>, "detail": "..."}` or `{"exception": "<message>"}`.

---

## Replayer and shrinker

### `npm run chaos:replay -- <jsonl-line | run-id>`

`ChaosReplayer` loads the JSONL entry and re-executes deterministically:

- Sets `SeededRandom` to the recorded seed.
- Skips the generator entirely; replays the recorded `perServerSessions.chains.ops` directly.
- Honours `startDelayMs`, `fault.atMs`, `fault.recoveredAtMs`.
- Asserts the same outcome.

### `npm run chaos:shrink -- <jsonl-line | run-id>`

`Shrinker` runs delta-debugging on a failing session:

1. Try removing each chain one at a time; if the failure persists, drop that chain from the candidate.
2. For each remaining chain, try halving its op list; recurse.
3. Try dropping the fault; if the failure persists, drop it.
4. Try collapsing topology (multi-server -> single-server) where invariants permit.
5. Repeat until a single round produces no further reduction.

Output: minimal failing session printed to console and appended to `logs/chaos-shrunken.jsonl`.

Caveats explicitly documented:
- Shrinker assumes determinism. A non-deterministic failure (genuinely flaky) may not shrink cleanly.
- Shrinker has its own time budget (default 5 min per failure); times out with the smallest reproduction found so far.

---

## Real VS Code extension-host suite

A parallel test target that exercises the same primitives, personas, and invariants under a real Electron VS Code instance.

### Files

```
test-vscode-host/
  globalSetup.ts              launches VS Code via @vscode/test-electron
  globalTeardown.ts           cleanly shuts the VS Code instance
  chaos-e2e.test.ts           jest entry inside the extension host
  hostFaults.ts               extension-host-specific faults:
                                - command timeout (block command for > vscode default timeout)
                                - main-thread block (synchronous busy-loop for N ms)
                                - reload during active connection (workbench.action.reloadWindow)

jest.chaos-e2e.config.js      separate jest config (real vscode runtime, not mocked)
package.json                  new script: test:chaos:e2e
```

### Reuse

- Imports `PRIMITIVES`, `PERSONAS`, `INVARIANTS`, `FAULTS` (the Docker-side ones) from `src/chaos/`.
- Reuses `SessionGenerator` and `ChainGenerator` unchanged; the only swap is the `vscode` import (real vs mocked).
- Adds `hostFaults.ts` to the fault catalog only for this target.

### Cadence and budget

- Quick mode: 5-10 sessions, ~5 min budget.
- Deep mode: 20-30 sessions, ~25 min budget.
- Run weekly, not per-PR. Surfaces real-host-only bugs (extension activation order, command registration timing, real command-dispatch round-trips, real workbench events).

### Integration points

- The action catalog is shared. New `.adn` features extend coverage in both targets.
- The replayer can replay a host-target failure deterministically (host-specific faults use the same `inject/recover` contract).
- Shrinker works on host-target failures with the same algorithm; only the budget differs.

---

## Decommissioned

The following are deleted in this release:

- `src/chaos/scenarios/` — entire directory, 11 files (`connection-lifecycle.ts`, `file-operations.ts`, `command-guard.ts`, `server-monitor.ts`, `concurrent-operations.ts`, `error-paths.ts`, `mixed-workflows.ts`, `ssh-tools.ts`, `ssh-tools-keys.ts`, `channel-semaphore.ts`, `port-forward.ts`).
- `src/chaos/coverage-manifest.json` — replaced by empirical primitive-call tracking.
- `src/chaos/ChaosCollector.ts` — output-channel scanning folded into invariant-level checks where useful, dropped where not.
- `src/chaos/ChaosDetector.ts` — replaced by the `INVARIANTS` registry.
- `src/chaos/ChaosValidator.ts` — replaced by the `INVARIANTS` registry.
- `ALL_KNOWN_ACTIONS` constant in `ChaosEngine.ts` — gone with the old engine.

The existing scenario files contain knowledge worth preserving (which method calls go together, which invariants must hold). Before deletion, the implementer reads each and lifts:
- Op groupings -> primitive registrations
- Invariant assertions -> `INVARIANTS[]` entries
- Historical bug references -> comments on the corresponding primitive or invariant

The files themselves are then deleted; their git history retains the original logic for reference.

---

## Kept unchanged

- `src/chaos/ContainerHealthMonitor.ts` — dead-server cascade detection still valuable.
- `test-docker/` — Docker container stack unchanged.
- `globalSetup.chaos.ts`, `globalTeardown.chaos.ts` — unchanged orchestration.
- `src/chaos/chaos-helpers.ts` — kept, slimmed: only `createChaosConnection`, `safeChaosDisconnect`, `SeededRandom` survive. The rest move into the new modules where they belong.

---

## Verification

### Unit tests (`npx jest --no-coverage`)

- `catalog/builder.test.ts` — round-trip: `.adn` fixture in -> JSON out -> re-parse -> identical
- `catalog/loader.test.ts` — drift detection: in-memory rebuild matches checked-in JSON
- `generator/SessionGenerator.test.ts` — deterministic for fixed seed across all four topologies
- `generator/ChainGenerator.test.ts` — persona weight respected across 1000-trial draws (within statistical bounds); action expansion correct
- `generator/TopologyChooser.test.ts` — distribution within statistical bounds for both modes
- `generator/FaultScheduler.test.ts` — fault rate per mode matches declared rate within bounds
- `generator/DataGenerator.test.ts` — random paths/bytes/cmds deterministic for fixed seed; "weird" cases hit at expected rate
- `primitives/<surface>/*.test.ts` — each primitive class isolated and tested with mocked SSH connection
- `invariants/*.test.ts` — each invariant correctly identifies violations on synthetic before/after pairs and passes on clean ones
- `faults/*.test.ts` — each fault's `inject` and `recover` issue the correct shell commands (mocked); cap-gated faults skip cleanly when caps absent
- `replay/ChaosReplayer.test.ts` — given a recorded session, replays produce identical primitive-call trace
- `replay/Shrinker.test.ts` — given a synthetic failing session, shrinker finds the documented minimal subset

### Integration tests

- `npm run chaos:catalog` is idempotent; second run produces no diff.
- `chaos.test.ts` (`npm run test:chaos`, 5 min target):
  - ~30 sessions
  - Topologies A and B appear at least once (C and D may appear, deep mode required for full distribution)
  - Every primitive surface (sshOps, vscodeCommands, treeOps, hoverOps, decorationOps, serviceOps, backgroundOps) exercised >= 1x
  - At least 5 distinct fault types fire >= 1x
  - 0 invariant violations
  - JSONL summary lists `actions_used` >= 60% of registered actions
- `chaos.test.ts` (`npm run test:chaos:deep`, 13 min target):
  - ~150 sessions
  - All four topologies appear >= 3 times each
  - All faults fire >= 2 times each (cap-permitted)
  - Every primitive surface exercised; >= 80% of individual primitives exercised
  - 0 invariant violations
  - Full action x topology x fault matrix surfaced in `post_run_analysis`

### Real-host tests

- `npm run test:chaos:e2e` (25 min target): ~25 sessions in real Electron VS Code; reuses primitives/personas/invariants; surfaces only host-specific issues; runs weekly.

### Replay verification

- Capture one real chaos failure (during dev). Verify `npm run chaos:replay -- <id>` reproduces the failure deterministically. Verify `npm run chaos:shrink -- <id>` reduces to a smaller still-failing session. Both cases logged in the v0.8.0 release notes.

---

## Documentation updates

- `.adn/testing/chaos-testing.md` — full rewrite to describe the new engine, catalog, topologies, fault catalog, invariants, replay, shrinker, real-host suite. Old "scenarios" terminology removed; new "session / chain / action" terminology defined.
- `.adn/CHANGELOG.md` — `## v0.8.0 — Chaos engine rebuild` entry summarising the rebuild and the deleted/added modules.
- `README.md` — version badge bump, new "Release Notes" section.
- `docs/COMMANDS.md` — auto-regenerated by hook; no manual edit.
- `package.json` — version bump 0.7.7 -> 0.8.0; new scripts `chaos:catalog`, `chaos:replay`, `chaos:shrink`, `test:chaos:e2e`.
- `.adn/features/*.md` — every existing feature file gains a `## User Actions` table. The implementer fills these from current behaviour; subsequent feature additions extend coverage automatically.
- `.claude/settings.json` — new hook regenerates the catalog when `.adn/features/*.md` is saved.

---

## Migration / rollout

1. Land the new engine alongside the old one on a feature branch; CI runs both `test:chaos` (new) and `test:chaos:legacy` (old, against a frozen copy of `scenarios/`) for one release cycle.
2. After v0.8.0 ships and one weekly chaos run shows the new engine at green and exercising >= 80% of primitives, delete `scenarios/` and the legacy command.
3. Subsequent releases work only against the new engine.

---

## Open questions

None outstanding. All scope decisions resolved in brainstorm.

## Out of scope (final)

- Multi-extension-instance simulation (process-level multi-window).
- Visual / screenshot regression.
- Continuous-mode chaos (steady-state monitoring outside test runs).
- Replacing unit tests in `src/__tests__/` for parsers and synchronous getters.

These remain as candidate future work, each with its own brainstorm/spec/plan cycle when prioritised.
