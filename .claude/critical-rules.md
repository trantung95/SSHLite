# SSH Lite - core rules (always injected)

These are the load-bearing rules for working in SSH Lite, distilled from `CLAUDE.md` (LITE Principles + AI Behavior). They are injected on every prompt and into every sub-agent so they survive context drift and fresh sub-agent contexts. This is a solo-managed repo: these are strong defaults and good judgement, not a compliance gate. When one conflicts with an explicit user instruction, the user wins.

## LITE (Lightweight, Intentional, Transparent, Efficient - never sacrifice data correctness)

- No automatic server commands. SSH/SFTP work is user-triggered only.
- No polling by default. Any polling is opt-in and defaults OFF.
- No preloading. Lazy-load on demand.
- Cache aggressively, reuse the single connection, debounce 300ms or more.
- True data, no loss. Wait for all results; never truncate, filter, or drop data to look faster.
- Backward compatible. No breaking changes to connection configs / host settings / keybindings without a migration path. Trace all callers before removing a function.

## Working method

- Plan first, code later. If the approach turns out wrong mid-way, stop and re-plan from first evidence. When a conclusion is disproved, discard it and every assumption built on it - do not patch on top of a broken premise.
- Read the related files before forming a plan: the file, its callers, related providers/services, and the matching `.adn/` doc. This matters most for changes touching ssh2, WebView, extension activation, or tree providers.
- Sub-agents first. Dispatch a sub-agent for any separable work (research, code exploration, file reads, parallel analysis, code review). Announce with a one-line note; no need to ask first.
- Prove it works before claiming done: run the build (`npm run compile`), run the tests (`npx jest --no-coverage`), check the output. For ssh2 / sftp / event-loop / large-file behaviour, reproduce on a real local SSH server (docker), not mocks.
- Self-fix bugs: read logs, trace the root cause, apply the fix.

## Conventions that bite if ignored

- Services are singletons via `getInstance()`. Init order matters (credentialService.initialize first).
- Tree item `id` must be stable (never encode dynamic state). `contextValue` must match the `package.json` `when` clause.
- Use `normalizeLocalPath()` for all local-path Map lookups. Use `CommandGuard` for significant SSH operations.
- Tree inline icons: an icon shared across rows occupies the same `inline@N` slot on every row (see CLAUDE.md "Tree Inline Icon Order").
- Pervasive diagnostic logging via `src/utils/diagnosticLog.ts` (`infoLog` / `diagLog`) into the single SSH Lite output channel. No `console.log`, no second channel, no logging in hot loops at `infoLog` level.

## Output style

- No em-dash character (U+2014) in any output or file. Use a spaced hyphen ( - ), a colon, parentheses, or a sentence break. Do not substitute the SQL-style double hyphen.
- Expand abbreviations on first use.
- Record reusable lessons in `.adn/lessons.md` and reusable patterns in `CLAUDE.md` in the same response you discover them.
