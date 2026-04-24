# Per-Connection Channel Semaphore Design

**Date:** 2026-04-24  
**Status:** Approved

## Problem

During parallel content search (SearchPanel firing multiple grep commands), opening a terminal can fail silently because the SSH server channel limit (typically 10) is exhausted. The current retry logic backs off blindly without signalling other operations to reduce load, and there is no coordination between concurrent commands on the same connection.

## Goal

- Search adapts concurrency dynamically when the channel limit is hit
- Terminal open queues visibly and retries automatically when a slot frees up
- Terminal gives up after 30s and shows a clear error
- All behaviour is **per-connection (per-server)** — one server's pressure never affects another

---

## Architecture

### New: `ChannelSemaphore` (`src/services/ChannelSemaphore.ts`)

One instance per active server connection, owned by CommandGuard.

**State:**

| Field | Type | Description |
|---|---|---|
| `maxSlots` | number | Current ceiling (starts at `sshLite.maxChannelsPerServer`, default 8) |
| `initialMax` | number | Starting value, used as recovery ceiling |
| `activeCount` | number | Channels currently executing |
| `waitQueue` | Array&lt;Waiter&gt; | FIFO queue of pending acquires |
| `consecutiveSuccesses` | number | Counts successes since last failure for recovery |

**API:**

- `acquire(timeoutMs?: number): Promise<() => void>` — returns a release fn; optional timeout for terminal use
- `reduceMax(): void` — called on open-failure; floor at 1
- `increaseMax(): void` — called after 5 consecutive successes; ceiling at `initialMax`
- `get available(): number`
- `get queued(): number`

**Acquire logic:**
- If `activeCount < maxSlots`: increment `activeCount`, return `release()` immediately
- Otherwise: push a `{ resolve, reject }` waiter. If `timeoutMs` provided, set a timer that rejects and removes the waiter on expiry
- `release()`: decrement `activeCount`, wake next waiter in queue (FIFO)

**Adaptive concurrency:**
- `reduceMax()`: `maxSlots = Math.max(1, maxSlots - 1)`, reset `consecutiveSuccesses = 0`
- On each successful exec: `consecutiveSuccesses++`; when `>= 5` call `increaseMax()`
- `increaseMax()`: `maxSlots = Math.min(initialMax, maxSlots + 1)`, reset counter

---

### CommandGuard changes (`src/services/CommandGuard.ts`)

Add a `Map<connectionId, ChannelSemaphore>`. Lazy-create on first use; delete on disconnect.

**`exec()` wrapper:**
1. `acquire()` — no timeout; search waits indefinitely
2. Run the SSH command
3. `release()` in `finally`
4. On "open failure": `semaphore.reduceMax()`, throw `ChannelLimitError`
5. Retry loop max 3: if `ChannelLimitError` and `retries < 3` — wait 100ms, re-acquire, retry
6. After 3 failures: propagate `ChannelLimitError` to caller (SearchPanel shows partial results)
7. On success: `consecutiveSuccesses++` path via semaphore

**`shell()` wrapper (terminal):**
1. `acquire(30_000)` — 30s timeout
2. On `ChannelTimeoutError`: throw to caller, no retry
3. Run `connection.shell()`
4. `release()` in `finally`

---

### Terminal command handlers (`src/extension.ts`)

`openTerminal` and `openTerminalHere` wrap `commandGuard.shell()` with a progress notification:

```
withProgress "Waiting for a free channel to open terminal..."
  -> commandGuard.shell(connection)
     [resolves] -> open terminal, notification dismissed automatically
     [ChannelTimeoutError] -> show error:
       "Failed to open terminal: all SSH channels are busy (30s timeout).
        Stop a search or wait and try again."
```

---

## Configuration

New setting in `package.json`:

```json
"sshLite.maxChannelsPerServer": {
  "type": "number",
  "default": 8,
  "minimum": 1,
  "description": "Max concurrent SSH channels per server. Default 8 leaves headroom on servers with MaxSessions 10."
}
```

Semaphores read this at creation time. Existing connections keep their current (possibly adapted) value; new connections pick up config changes.

---

## Data Flow

```
openTerminal
  -> commandGuard.shell(connection)
      -> semaphore.acquire(30_000)
          [slot free]   -> proceed immediately
          [busy]        -> show "Waiting for a free channel..." progress
                        -> wait in FIFO queue
                        -> [slot freed by search] -> proceed -> open terminal
                        -> [30s timeout]          -> ChannelTimeoutError -> error popup
      -> connection.shell()
      -> semaphore.release()   <- wakes next waiter

SearchPanel grep
  -> commandGuard.exec(connection, grepCmd)
      -> semaphore.acquire()        <- waits if busy (no timeout)
      -> connection.exec(grepCmd)
          [open failure] -> semaphore.reduceMax() -> ChannelLimitError
                         -> retry up to 3x (re-acquire each time)
                         -> 3rd failure -> propagate to SearchPanel (partial results)
      -> semaphore.release()        <- wakes terminal if queued
      -> on success: consecutiveSuccesses++ -> maybe increaseMax()
```

---

## Error Types

Two typed errors exported from `src/services/ChannelSemaphore.ts`:

- `ChannelLimitError` — SSH server rejected channel open; triggers retry in search, propagates after 3 failures
- `ChannelTimeoutError(timeoutMs)` — semaphore acquire timed out; triggers error popup in terminal handler

---

## Testing

### Unit (`npx jest`)
- `ChannelSemaphore`: acquire/release ordering (FIFO), timeout expiry, `reduceMax` floor at 1, `increaseMax` ceiling at `initialMax`, recovery resets after 5 successes
- CommandGuard `exec` retry: mock throws `ChannelLimitError` 1x / 2x / 3x — verify retry count, final success, final failure propagation
- CommandGuard `shell` timeout: mock `acquire` timing out — verify `ChannelTimeoutError` propagates, progress notification disposed
- `removeSemaphore`: verify semaphore removed from map on disconnect

### Integration (mock SSH, no Docker)
- N concurrent `exec()` calls exhausting slots — later callers queue and unblock in FIFO order when slots free
- "open failure" on exec — `maxSlots` decrements, command retried transparently, caller receives success
- Terminal `acquire` timeout — error message shown, progress notification disposed
- **Per-connection isolation:** server A's semaphore exhausted does not block server B's `exec` or `shell`
- **Per-user isolation:** two users on same host each have their own semaphore; saturating one does not block the other

### E2E / Docker (`npm run test:docker`)
- Saturate channels with long-running commands, open terminal — terminal waits and opens once a slot frees
- Saturate channels, trigger terminal — verify 30s timeout fires and error popup text is correct
- Search + terminal race — search adapts concurrency, terminal eventually opens
- **Multi-server (1 user):** saturate server A's channels — server B's terminal opens instantly (independent semaphores)
- **Multi-user (1 server):** two SSH users on same host — saturating one user's channels does not block the other user's terminal

### Chaos (`npm run test:chaos`)
- Random concurrent mix of exec, shell, searchFiles on 1 connection — no deadlock, no slot leak, `activeCount` returns to 0 after all complete
- Random "open failure" injection at varying concurrency levels — `maxSlots` never drops below 1, recovery increments correctly
- Abrupt connection drop mid-queue — all waiters rejected cleanly, semaphore removed from map
- Rapid acquire/release cycles under load — wait queue never grows unbounded
- **Multi-server chaos:** random ops across 3 simultaneous servers with independent channel exhaustion — no cross-server slot leakage
- **Multi-user chaos:** 2 users on same host with overlapping heavy search + terminal opens — each user's `maxSlots` adapts independently, neither starves the other

---

## Files Affected

| File | Change |
|---|---|
| `src/services/ChannelSemaphore.ts` | **New** — semaphore class + error types |
| `src/services/CommandGuard.ts` | Add semaphore map, wrap `exec()` and `shell()` |
| `src/extension.ts` | `openTerminal` + `openTerminalHere` — progress notification + error handling |
| `package.json` | Add `sshLite.maxChannelsPerServer` setting |
| `src/__tests__/ChannelSemaphore.test.ts` | **New** — unit tests |
| `src/__tests__/CommandGuard.channel.test.ts` | **New** — unit + integration tests |
| `test/docker-channel-semaphore.test.ts` | **New** — E2E tests |
| `src/chaos/channel-semaphore.chaos.ts` | **New** — chaos scenarios |
| `.adn/configuration/settings-reference.md` | Add `maxChannelsPerServer` |
| `.adn/features/terminal-port-forwarding.md` | Document channel wait behaviour |
