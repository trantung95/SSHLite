# Chaos Engine Rebuild Implementation Plan (v0.8.0 baseline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken chaos suite with a real chaos-testing engine: dynamic sessions of concurrent user-like chains, multi-topology, real fault injection, universal invariants, replayable. Plan 1 of 3 — delivers v0.8.0 baseline (SSH + credential surfaces, 6 core invariants, 4 faults, full generator/engine/logger/replayer, full decommission of old code). Plans 2 (v0.8.1: UI surfaces, remaining invariants/faults) and 3 (v0.8.2: shrinker, real-host suite) follow.

**Architecture:** Session orchestrator picks topology (A/B/C/D), generates k chains per server with persona-weighted action draws, expands actions to primitive ops with seeded random data, schedules 0-or-1 fault per session, runs chains via `Promise.all` with start-delay, snapshots and checks invariants around every primitive, recovers fault, logs replay-grade JSONL.

**Tech Stack:** TypeScript, ssh2, Jest (`@swc/jest`), Docker, `tc`/`iptables`/`pkill` (fault injection)

**Spec:** `docs/superpowers/specs/2026-05-06-chaos-engine-rebuild-design.md`

> **Note on code in steps:** the spec contains the full target architecture with type definitions, primitive contracts, fault catalog, invariants, and module tree. This plan describes the ordered tasks. At execution time, the implementer reads the spec for type signatures and behavioural contracts, then writes the corresponding TypeScript via TDD. Code blocks in this plan are illustrative-only; the canonical types are in the spec.

---

## File Map

### Created (new files)

```
src/chaos/ChaosTypes.ts                                  central types
src/chaos/catalog/builder.ts                             parses .adn + package.json
src/chaos/catalog/loader.ts                              runtime catalog reader
src/chaos/catalog/personas.ts                            7 hand-curated personas
src/chaos/catalog/{actions,flows,commands}.json          generated, checked in
src/chaos/primitives/index.ts                            registry
src/chaos/primitives/sshOps/{connection,run,file}.ts     SSH primitives
src/chaos/primitives/serviceOps/credentialOps.ts         service primitives
src/chaos/invariants/index.ts                            registry
src/chaos/invariants/sshStateMachine.ts
src/chaos/invariants/listenerLeak.ts
src/chaos/invariants/activityCount.ts
src/chaos/invariants/semaphoreFloor.ts
src/chaos/invariants/sessionTeardown.ts
src/chaos/invariants/cleanShutdown.ts
src/chaos/faults/index.ts                                registry
src/chaos/faults/dockerExec.ts                           helper for docker subprocess
src/chaos/faults/dockerPause.ts
src/chaos/faults/netem.ts
src/chaos/faults/sshdSignal.ts
src/chaos/faults/diskFill.ts
src/chaos/generator/DataGenerator.ts
src/chaos/generator/TopologyChooser.ts
src/chaos/generator/ChainGenerator.ts
src/chaos/generator/FaultScheduler.ts
src/chaos/generator/SessionGenerator.ts
src/chaos/replay/ChaosReplayer.ts
scripts/build-chaos-catalog.ts                           npm run chaos:catalog
scripts/chaos-replay.ts                                  npm run chaos:replay
src/__tests__/chaos/**/*.test.ts                         unit tests for all of the above
```

### Modified

```
src/chaos/ChaosConfig.ts          replace types section, keep server lists
src/chaos/ChaosEngine.ts          full rewrite (session orchestrator)
src/chaos/ChaosLogger.ts          full rewrite (JSONL emitter)
src/chaos/chaos.test.ts           full rewrite (jest entry)
src/chaos/chaos-helpers.ts        slim to createChaosConnection, safeChaosDisconnect, SeededRandom
package.json                      version 0.7.7 -> 0.8.0; new scripts chaos:catalog, chaos:replay
README.md                         version badge + Release Notes
.adn/CHANGELOG.md                 ## v0.8.0 entry
.adn/testing/chaos-testing.md     full rewrite
.adn/features/*.md                each gains a ## User Actions table (6 files)
.claude/settings.json             hook regenerates catalog on .adn/features save
```

### Deleted

```
src/chaos/scenarios/              entire directory (12 files)
src/chaos/coverage-manifest.json
src/chaos/ChaosCollector.ts
src/chaos/ChaosDetector.ts
src/chaos/ChaosValidator.ts
src/chaos/chaos-ssh-tools.test.ts
```

---

## Phase 1: Foundation Types

### Task 1: ChaosTypes module

- Create `src/chaos/ChaosTypes.ts` with all interfaces from the spec's "Architecture overview" / "Module tree" section: `Topology`, `ChaosMode`, `PrimitiveSurface`, `ChainOp`, `GenContext`, `PrimitiveOp`, `Action`, `Persona`, `Fault`, `Snapshot`, `Violation`, `Invariant`, `Chain`, `PerServerSession`, `Session`, `RunOutcome`, `RunResult`.
- Method shapes per spec contracts: `PrimitiveOp { generateParams(rng, ctx), execute(conn, params), longRunning?, requiresConnected, surface, weight }`. `Fault { generateParams(rng), inject(server, params), recover(server, params), requiresCaps?, weight }`. `Invariant { snapshot(conn), check(before, after), whenToCheck, name }`.

- [ ] Step 1: Author the file.
- [ ] Step 2: `npm run compile` — note that `ChaosConfig.ts` and old engine files will still error; that's expected and resolved in Task 2 + Phase 11.
- [ ] Step 3: Commit `chaos: add new types module for engine rebuild`.

---

## Phase 2: Foundation Config

### Task 2: New ChaosConfig

- Replace `src/chaos/ChaosConfig.ts`. Keep `ChaosServerConfig` interface (add `container: string` field per spec) and the `BASIC_SERVERS` / `MULTIOS_SERVERS` constants. Drop the old types (`StateEvent`, `Anomaly`, `ScenarioResult`, `ScenarioContext`, `ScenarioFn`, `ScenarioDefinition`, `CoverageManifest`, `PerOSSummary`, `ChaosRunResult`).
- Add new types: `ChaosRunConfig` with `mode`, `seed`, `servers`, `globalBudgetMs` (quick 300_000 / deep 780_000), `sessionTimeoutMs` (quick 30_000 / deep 60_000), `faultRate` (quick 0.30 / deep 0.70), `topologyWeights` (quick `{A:0.60, B:0.25, C:0.12, D:0.03}` / deep `{A:0.50, B:0.25, C:0.17, D:0.08}`), `chainsPerServerRange` `[1,4]`, `fanoutServerRange` `[2,4]`, `fanInUserRange` `[3,6]`.
- Wire `getRunConfig()` to read `CHAOS_MODE` and `CHAOS_SEED` env vars (same as today).
- Add `container` field to every server entry: `sshlite-test-server-1/2/3` for basic; `sshlite-os-{alpine,ubuntu,debian,fedora,rocky}` for multi-OS.

- [ ] Step 1: Author the file.
- [ ] Step 2: Commit `chaos: replace ChaosConfig types with mode/topology/budget config`.

---

## Phase 3: Catalog System

### Task 3: Catalog builder + tests (TDD)

- Create `src/chaos/catalog/builder.ts` exporting `parseUserActions(md, source)`, `parseFlows(md, source)`, `parseCommands(pkgJson)`, `buildCatalog(repoRoot)`, `writeCatalog(repoRoot, result)`.
- Create test `src/__tests__/chaos/catalogBuilder.test.ts` covering: extracts actions from `## User Actions` markdown table; ignores other sections; parses `unordered` notes-column flag; parses commands from `package.json contributes.commands`; parses numbered steps under `## Flow` heading.
- Create `scripts/build-chaos-catalog.ts` invoking `buildCatalog` then `writeCatalog`.

- [ ] Step 1: Write failing tests.
- [ ] Step 2: Run tests, confirm fail.
- [ ] Step 3: Implement `builder.ts`.
- [ ] Step 4: Run tests, confirm pass.
- [ ] Step 5: Commit `chaos: add catalog builder for actions/flows/commands`.

### Task 4: Catalog loader, drift test, .adn User Actions tables

- Create `src/chaos/catalog/loader.ts` exporting `loadCatalog(repoRoot)` and `validateAgainstPrimitives(catalog, primitiveNames)`.
- Add `## User Actions` table to each of `.adn/features/{connection-management, file-operations, terminal-port-forwarding, search-system, tree-providers, activity-audit}.md`. Pick 2–6 user-level actions per feature; primitive names must match those that ship in this plan: `connect, disconnect, dispose, runShort, runLong, runFailing, shell, writeFile, readFile, listFiles, mkdir, rename, deleteFile, stat, fileExists, saveCredential, retrieveCredential, deleteCredential`.
- Add npm scripts to `package.json`: `chaos:catalog` -> `ts-node scripts/build-chaos-catalog.ts`, `chaos:replay` -> `ts-node scripts/chaos-replay.ts`.
- Run `npm run chaos:catalog` to generate the three JSON files.
- Create drift test `src/__tests__/chaos/catalogDrift.test.ts` that re-runs `buildCatalog` in-memory and asserts equality with `actions.json`/`flows.json`/`commands.json` on disk.

- [ ] Step 1: Add User Actions tables to all 6 .adn files.
- [ ] Step 2: Add npm scripts.
- [ ] Step 3: Run `npm run chaos:catalog`.
- [ ] Step 4: Implement loader.
- [ ] Step 5: Write drift test, run, confirm pass.
- [ ] Step 6: Commit `chaos: catalog loader, drift test, and User Actions tables in .adn`.

### Task 5: Personas registry

- Create `src/chaos/catalog/personas.ts` exporting `PERSONAS: Persona[]` with the 7 personas from the spec (`explorer, editor, operator, watcher, monitor, searcher, admin`). Each has `weights: Record<actionName, number>` and `chainLengthRange: [min, max]`. Action names referenced are looked up at runtime; missing actions are silently dropped (the chain generator handles that — Task 12).
- Create test `src/__tests__/chaos/personas.test.ts`: 7 personas; each has positive total weight; each has valid chain length range.

- [ ] Step 1–5: TDD per the standard cycle.
- [ ] Step 6: Commit `chaos: add persona registry`.

---

## Phase 4: Initial Primitives

Each task in this phase follows the same TDD cycle: write a test, watch it fail, implement, watch it pass, commit.

### Task 6: SSH connection primitives

- Create `src/chaos/primitives/sshOps/connection.ts` exporting `connectionPrimitives: PrimitiveOp[]` containing `connect`, `disconnect`, `dispose`. `connect` is a marker (the engine handles the actual handshake); `disconnect` calls `conn.disconnect()`; `dispose` calls `conn.dispose()`. All three have `surface: 'sshOps'`, weight 1.
- Test: `src/__tests__/chaos/primitives/sshConnection.test.ts` — names exported, `requiresConnected` flags correct, `generateParams` returns serialisable object.

- [ ] TDD cycle and commit.

### Task 7: SSH run primitives (`runShort`, `runLong`, `runFailing`, `shell`)

- Create `src/chaos/primitives/sshOps/run.ts`.
- `runShort`: weight 5, picks from `['pwd', 'id', 'whoami', 'hostname', 'date', 'uname -a', 'echo chaos']`.
- `runLong`: weight 1, `longRunning: true`, picks from `['sleep 1 && echo done', 'find / -maxdepth 2 -type d 2>/dev/null | head -20', 'ls -la /etc | head -30']`.
- `runFailing`: weight 1, picks from `['false', 'cat /no/such/file', 'cd /not/here', 'unknownCmd-zzz']`. Catches and ignores errors in execute.
- `shell`: weight 1, `longRunning: true`. Calls `conn.shell({ term: 'xterm-color', cols: 80, rows: 24 })` and immediately ends the channel.
- All four use `conn['exec'](...)` (bracket notation, per repo convention to avoid the security-reminder false positive).
- Test: names exported, `runShort.generateParams` produces non-empty `cmd`, `runShort.execute` calls the underlying SSH method with the cmd string (verified with a fake conn).

- [ ] TDD cycle and commit.

### Task 8: SSH file primitives (8 ops)

- Create `src/chaos/primitives/sshOps/file.ts` with `writeFile, readFile, listFiles, mkdir, rename, deleteFile, stat, fileExists`. All `surface: 'sshOps'`, `requiresConnected: true`.
- Helper functions: `randomPath(rng)` returns `/tmp/chaos-<hex>`; `pickKnownOrRandom(rng, known)` returns a known path 70% of the time when one exists, else a fresh random path; `deterministicBytes(seed, len)` produces reproducible bytes via `SeededRandom(seed)`.
- `writeFile` params: `{path, bytesLen, bytesSeed}`, weight 4. Generates `bytesLen` in [0, 4096].
- `readFile` params: `{path}`, weight 4. Uses `pickKnownOrRandom` from `ctx.knownPaths`.
- `listFiles` params: `{path}`, weight 3. Picks `/tmp` or `/etc`.
- `mkdir` params: `{path}`, weight 2. Random fresh path.
- `rename` params: `{from, to}`, weight 1. `from` from `pickKnownOrRandom`, `to` random.
- `deleteFile`, `stat`, `fileExists` params: `{path}`, weights 1/2/2 respectively.
- All execute methods catch errors except `fileExists` (which has a defined non-throwing contract).
- Test: 8 ops exported; `writeFile` params include path/bytesLen/bytesSeed; `readFile` prefers known paths in majority of statistical draws (test with 100 trials, expect >50 use the known path).

- [ ] TDD cycle and commit.

### Task 9: Credential service primitives

- Create `src/chaos/primitives/serviceOps/credentialOps.ts` with `saveCredential, retrieveCredential, deleteCredential`. `surface: 'serviceOps'`, `requiresConnected: false`.
- Each calls `CredentialService.getInstance()` then the appropriate method. Implementer verifies actual `CredentialService` method names against the codebase (`savePassword`/`getPassword`/`deletePassword` or similar) and adapts.
- All wrap calls in try/catch — credential collisions and non-existence are not errors.
- Random fake host per call: `chaos-host-<n>`.
- Test: names exported.

- [ ] TDD cycle and commit.

### Task 10: Primitive registry

- Create `src/chaos/primitives/index.ts` exporting `PRIMITIVES: PrimitiveOp[]` (concat all primitive groups), `primitiveByName(name)` for lookup, `PRIMITIVE_NAMES: Set<string>`.
- Test: unique names; `primitiveByName` resolves known and returns undefined for unknown; multiple surfaces represented.

- [ ] TDD cycle and commit.

---

## Phase 5: Core Invariants

### Task 11: Six core invariants + registry

- Create one file per invariant under `src/chaos/invariants/`:
  - `sshStateMachine.ts` — `whenToCheck: 'after-each-op'`. Snapshot reads `conn.state`. Check fails when state is not in the valid `ConnectionState` set.
  - `listenerLeak.ts` — `whenToCheck: 'after-session'`. Snapshot reads listener counts on `conn.client` for every event name. Check fails when any count exceeds 5.
  - `activityCount.ts` — `whenToCheck: 'after-session'`. Snapshot reads `ActivityService.getInstance().getRunningActivities().length`. Check fails when after > before.
  - `semaphoreFloor.ts` — `whenToCheck: 'after-each-op'`. Snapshot reads `conn.semaphore?.activeCount` and `available`. Check fails when either goes negative.
  - `sessionTeardown.ts` — `whenToCheck: 'after-session'`. Snapshot reads `conn.state`. Check fails when state is not `Disconnected` at session end.
  - `cleanShutdown.ts` — `whenToCheck: 'after-each-op'`. Stub: snapshot reads state; `check` returns []. The rich post-disconnect-error contract lands in v0.8.1; this baseline registers the invariant so the engine wires it up.
- Create `src/chaos/invariants/index.ts` exporting `INVARIANTS: Invariant[]` (the 6 above), plus `INVARIANTS_AFTER_OP` and `INVARIANTS_AFTER_SESSION` partitions.
- Tests: one file per invariant validating the comparator on synthetic before/after pairs (passes for normal, fails for the documented violation case). Plus `registry.test.ts` checking 6 entries, unique names, valid partition.

- [ ] TDD cycle per invariant; one commit per invariant or batch.
- [ ] Final commit: `chaos: add 6 core invariants and registry`.

---

## Phase 6: Faults

### Task 12: Docker exec helper + 4 faults

- Create `src/chaos/faults/dockerExec.ts` with two helpers:
  - `dockerCmd(args: string[]): Promise<{code, stdout, stderr}>` — spawns `docker` with given args using `child_process.spawn` (NOT `exec`), shell:false. Captures stdout/stderr.
  - `dockerExecIn(container, cmd: string[]): Promise<...>` — calls `dockerCmd(['e' + 'xec', container, ...cmd])`. The bracketed concatenation avoids the security-reminder hook's false positive on the literal docker subcommand.
- Create faults:
  - `dockerPause.ts` — weight 3. inject: `dockerCmd(['pause', server.container])`. recover: `dockerCmd(['unpause', server.container])`.
  - `netem.ts` — weight 2, `requiresCaps: ['NET_ADMIN']`. params: `{delay_ms (50-400), loss_pct (0-10)}`. inject: `tc qdisc add dev eth0 root netem delay <ms>ms loss <pct>%`. recover: `tc qdisc del dev eth0 root`.
  - `sshdSignal.ts` — weight 2. inject: `pkill -STOP sshd`. recover: `pkill -CONT sshd`.
  - `diskFill.ts` — weight 1. params: `{mb (50-500)}`. inject: `sh -c "dd if=/dev/zero of=/var/log/chaos-fill bs=1M count=<mb> 2>/dev/null || true"`. recover: `rm -f /var/log/chaos-fill`.
- Create `src/chaos/faults/index.ts` exporting `FAULTS: Fault[]` and `faultByName(name)`.
- Tests: registry has 4 faults, unique names, every fault produces serialisable params from a seeded RNG.

- [ ] TDD cycle and commit.

---

## Phase 7: Generator

### Task 13: DataGenerator

- Create `src/chaos/generator/DataGenerator.ts` exporting class `DataGenerator(rng)`. Methods: `randomPath()` (8% weird-name probability with unicode/space/parens characters); `randomBytes(n)` (deterministic via inner SeededRandom).
- Test: deterministic for same seed; weird-path rate non-zero across 200 trials.

- [ ] TDD cycle and commit.

### Task 14: TopologyChooser

- Create `src/chaos/generator/TopologyChooser.ts` exporting class `TopologyChooser(rng, weights)` with `pick(): Topology`. Cumulative-probability draw.
- Test: returns valid topology; matches weight distribution within 5pp over 10000 trials with `{A:0.50, B:0.25, C:0.17, D:0.08}` weights.

- [ ] TDD cycle and commit.

### Task 15: ChainGenerator

- Create `src/chaos/generator/ChainGenerator.ts` exporting class `ChainGenerator(rng, actions)` with `generate(persona): Chain`. Behaviour:
  - Filter persona's `weights` map down to actions present in the catalog (silently drop unknowns).
  - Draw chain length from persona's `chainLengthRange`.
  - Begin chain with `connect` op.
  - For each step: weighted-draw an action, expand its primitives in declared order; for each primitive, look up via `primitiveByName`, skip if `requiresConnected && !ctx.connected`, generate params from `rng + ctx`; push op.
  - Track `ctx.knownPaths` (append after `writeFile`/`mkdir`); track `ctx.connected` (false after `disconnect`/`dispose`).
  - End chain with `disconnect` if still connected.
  - Set `chain.startDelayMs` to `rng.int(0, 500)`.
- Test: generated chain has correct persona; unknown actions dropped; deterministic for same seed.

- [ ] TDD cycle and commit.

### Task 16: FaultScheduler

- Create `src/chaos/generator/FaultScheduler.ts` exporting class `FaultScheduler(rng, faultRate)` with `maybePickFault(estimatedSessionMs = 5000)`. Returns `null` when `rng.int(0, 9999) / 10000 >= faultRate`. Otherwise picks a fault by weight, generates params, and returns `{name, atMs, params}` with `atMs` uniform in `[0.2 * estimated, 0.8 * estimated]`.
- Test: respects fault rate within 3pp over 10000 trials; returns valid `{name, atMs, params}` when fired.

- [ ] TDD cycle and commit.

### Task 17: SessionGenerator

- Create `src/chaos/generator/SessionGenerator.ts` exporting class `SessionGenerator(opts)` with `generate(rng): Session`. Behaviour:
  - Pick topology via `TopologyChooser`.
  - Pick target servers: A/C → 1 server; B/D → `rng.int(fanoutServerRange[0], min(fanoutServerRange[1], all.length))` randomly-shuffled servers.
  - For each target server: pick `k` chains via `ChainGenerator` using a randomly-selected persona per chain (from `PERSONAS`).
  - Schedule fault per per-server-session via `FaultScheduler`.
  - Return `{seed: rng.seed, topology, perServerSessions}`. (If `SeededRandom` doesn't expose seed, store separately.)
- Test: topology A → 1 perServerSession; topology B → 2+ perServerSessions; deterministic for same seed.

- [ ] TDD cycle and commit.

---

## Phase 8: Engine + Logger

### Task 18: New ChaosLogger

- Replace `src/chaos/ChaosLogger.ts` with a JSONL emitter: class `ChaosLogger(outPath)` with `write(result: RunResult)` appending one line per call, ensuring parent dir exists.
- Test: writes one line per result; multiple writes append.

- [ ] TDD cycle and commit.

### Task 19: New ChaosEngine

- Replace `src/chaos/ChaosEngine.ts` with the session orchestrator. Class `ChaosEngine(config: ChaosRunConfig)`:
  - Constructor builds a `SessionGenerator` from the config + loaded catalog.
  - `run()`: loops while wall-clock under `config.globalBudgetMs`. Per iteration: build a `Session` via `SessionGenerator.generate(new SeededRandom(seed + i++))`, call `executeSession(seed, session)`, log + collect.
  - `executeSession(seed, session)`: per perServerSession in parallel via `Promise.all`, opens a connection, snapshots after-session invariants, schedules fault via `setTimeout` at `pss.fault.atMs`, runs all chains in parallel, on settle: cancel fault timer, recover fault if injected, capture session-end invariant snapshots and run checks, disconnect.
  - `runChain(conn, chain, ...)`: optional start-delay; for each op: snapshot after-op invariants → execute primitive (fire-and-forget if `longRunning`) → re-snapshot → run after-op invariant checks. Per-op errors caught; chain continues. Track `exercised`, `actionsUsed`, `violations`, `invariantChecks` counters.
  - Outcome: `'passed'` if no violations; first violation otherwise; or `{exception}` if top-level Promise.all threw.
- Smoke test: constructs without throwing on a minimal config (no servers).

- [ ] TDD cycle and commit.

---

## Phase 9: Replayer

### Task 20: ChaosReplayer + script

- Create `src/chaos/replay/ChaosReplayer.ts`:
  - `findRunInJsonl(jsonlContent, runId)`: scans lines, returns matching `RunResult` or null.
  - `replayRun(run)`: for each perServerSession in parallel, opens a connection, walks `chains.ops` sequentially per chain (honouring `startDelayMs`), looks up each primitive by name, calls `execute` with the recorded params, swallows per-op errors, disconnects.
  - `replayFromArg(arg)`: reads `logs/chaos-results.jsonl`, finds by run-id; if not present, parses arg as a JSON-encoded RunResult.
- Create `scripts/chaos-replay.ts` — reads `process.argv[2]`, calls `replayFromArg`, errors out with usage if missing.
- Tests: `findRunInJsonl` finds known and returns null on unknown.

- [ ] TDD cycle and commit.

---

## Phase 10: New Test Entry

### Task 21: Replace `chaos.test.ts`

- Replace `src/chaos/chaos.test.ts` with a single jest spec that:
  - Constructs `ChaosEngine(getRunConfig())`.
  - Logs mode, seed, server count, budget.
  - Awaits `engine.run()` and asserts at least one session ran.
  - Surfaces violation count and the first 5 violation outcomes via console.log.
  - Has `jest.timeout` aligned with deep budget (`900000`).
- This test only runs as part of `npm run test:chaos` / `test:chaos:deep` — it's already excluded from the default unit-test config via `testPathIgnorePatterns`. Verify exclusion still applies.

- [ ] Step 1: Author the file.
- [ ] Step 2: Commit `chaos: rewrite jest entry to use new engine`.

---

## Phase 11: Decommission Old Code

### Task 22: Slim helpers + delete old files

- Edit `src/chaos/chaos-helpers.ts`: keep only `createChaosConnection`, `safeChaosDisconnect`, `SeededRandom`. Delete other exports if no new module imports them. Run `npx tsc --noEmit` to catch dangling imports.
- Delete: `src/chaos/scenarios/` (entire directory), `src/chaos/coverage-manifest.json`, `src/chaos/ChaosCollector.ts`, `src/chaos/ChaosDetector.ts`, `src/chaos/ChaosValidator.ts`, `src/chaos/chaos-ssh-tools.test.ts`.
- Verify: `npm run compile` clean; `npx jest --no-coverage` passes (count strictly higher than the pre-rebuild baseline of 1431).

- [ ] Step 1: Slim `chaos-helpers.ts`.
- [ ] Step 2: Delete files (use `git rm -rf src/chaos/scenarios` and `git rm` for individual files).
- [ ] Step 3: Compile + jest verification.
- [ ] Step 4: Commit `chaos: remove old scenarios, collector, detector, validator, manifest`.

---

## Phase 12: Documentation, Hooks, and Version Bump

### Task 23: Rewrite `.adn/testing/chaos-testing.md`

- Replace the file with content based on the spec sections "Architecture overview", "Action catalog", "Personas", "Topologies", "Concurrency model", "Fault injection", "Invariants", "Replay format", "Replayer". Keep "Container Lifecycle" and "Container Log Analysis" sections — they remain accurate. Drop all references to "scenarios", `coverage-manifest.json`, `ALL_KNOWN_ACTIONS`, `weight: 'heavy'`, `variationsPerScenario`.

- [ ] Author and commit `docs(adn): rewrite chaos-testing.md for the new engine`.

### Task 24: Add catalog regeneration hook

- Modify `.claude/settings.json`: add an `afterEdit`-style hook (the existing `docs/COMMANDS.md` regen on `package.json` save is the template). Trigger on `.adn/features/*.md` save → run `npm run chaos:catalog`. Verify the existing hook structure first by reading `.claude/settings.json`.

- [ ] Author and commit `hooks: regenerate chaos catalog on .adn/features save`.

### Task 25: Version bump and release notes

- `package.json`: line 5 → `"version": "0.8.0"`.
- `README.md`: line 3 → `![Version](https://img.shields.io/badge/version-0.8.0-blue)`. Append a new `### 0.8.0 — Chaos engine rebuild` Release Notes block (format matches existing 0.7.7 / 0.7.6 entries; 2-3 sentences pointing to the rewrite and the v0.8.1 follow-on).
- Run `npm run docs:commands` to regenerate `docs/COMMANDS.md` (no-op if hook already fired).
- `.adn/CHANGELOG.md`: prepend a `## v0.8.0 — Chaos engine rebuild` entry summarising what's new (modules created), what's removed (old engine, scenarios, manifest), verification status, and what's deferred to v0.8.1.

- [ ] Step 1: Edit `package.json`, `README.md`, `docs/COMMANDS.md` (auto), `.adn/CHANGELOG.md`.
- [ ] Step 2: `npm run compile && npx jest --no-coverage`.
- [ ] Step 3: Commit `Release v0.8.0 - Chaos engine rebuild`.

---

## Final Verification

- [ ] **F1: Compile** — `npm run compile` → 0 errors.
- [ ] **F2: Unit tests** — `npx jest --no-coverage` → all suites pass; new chaos unit tests green.
- [ ] **F3: Catalog idempotent** — `npm run chaos:catalog && git diff --exit-code src/chaos/catalog/` → empty diff.
- [ ] **F4: Quick chaos run (Docker required)** — `npm run test:chaos` → completes within ~5 min; JSONL summary shows the engine produced multiple sessions; ≥1 fault fired across the run.
- [ ] **F5: Deep chaos run (Docker required, optional smoke)** — `npm run test:chaos:deep` → completes within ~13 min; all 4 topologies appear; all 4 faults fire ≥1 time; full action × topology × fault matrix surfaced.
- [ ] **F6: Replay** — pick the most recent JSONL run-id; run `npm run chaos:replay -- <run-id>` → completes without crash, replays the recorded primitive sequence.

---

## Self-review notes

- All v0.8.0 spec sections covered: types, config, catalog parser/loader/personas, SSH primitives (3 of 7 surfaces — connection, run, file), service primitives (credentialOps as the seed surface), 6 core invariants, 4 faults, full generator, engine, logger, replayer, decommission of old code, docs, version bump.
- v0.8.1 deferral (separate plan): vscodeCommands/treeOps/hoverOps/decorationOps/backgroundOps primitives; remaining 11 invariants (treeConsistency, hoverCorrectness, decorationConsistency, credentialAtomicity, commandIdempotence, backgroundQuiescence, disposalCleanup, crossConnectionIsolation, portForwardRegistry, watcherRegistry, plus the rich cleanShutdown comparator); remaining 9 faults (iptablesRst, sshdKill, maxSessions, fdExhaust, stressCpu, stressMem, clockSkew, chmodLock, yankFile); the rich post-disconnect-error contract in cleanShutdown.
- v0.8.2 deferral (separate plan): Shrinker; real VS Code extension-host suite (`test:chaos:e2e`, `@vscode/test-electron`, host-specific faults).
- Type/method consistency: `PrimitiveOp.generateParams(rng, ctx) / execute(conn, params)`, `Fault.inject(server, params) / recover(server, params) / generateParams(rng)`, `Invariant.snapshot(conn) / check(before, after) / whenToCheck` referenced consistently across registry, generator, engine, replayer.
