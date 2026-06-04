---
name: auto-document-reusable
description: Use after every turn. For every piece of data that entered context (user prompts, tool results, file contents, sub-agent reports, errors, code read), evaluate whether it has reusable value and auto-document it without asking.
---

For EVERY piece of data that enters context - not just user prompts - run a quick check: does anything here have generalizable value for future work? If yes, document it immediately in the same response. Do NOT wait for the user to ask. This is the actionable form of CLAUDE.md AI Behavior "Auto-document after every prompt".

Data sources to scan (non-exhaustive):
- User prompts (corrections, validations, preferences, new context)
- Tool results: Read, Grep, Glob, Bash/PowerShell output
- File contents (code, configs, `.adn/` docs, other CLAUDE.md files)
- codebase-memory-mcp graph results, WebFetch/WebSearch output
- Sub-agent reports
- Error messages, stack traces, hook failures, test/CI output
- Git log, blame, diff output

Generalizable signals to watch for:
- New gotcha or quirk about the code, the VS Code API, ssh2/SFTP, tooling, or the build -> `CLAUDE.md` (a reusable convention) or `.adn/lessons.md` (a tactical one-off)
- Reusable code or test pattern -> `CLAUDE.md` or the relevant `.adn/growth/` doc
- Preference or behavior correction from the user -> `CLAUDE.md` or `.adn/lessons.md`
- Project context (why, constraints, intent not derivable from code) -> `CLAUDE.md` or auto-memory
- External pointer (URL, dashboard, repo, where a credential lives) -> the relevant doc

Decide WHERE to put it:
1. Cross-cutting reusable pattern or convention -> project `CLAUDE.md`
2. Tactical lesson tied to a specific incident -> `.adn/lessons.md` (dated entry)
3. Area-specific knowledge -> the matching `.adn/` doc per CLAUDE.md routing

**Why:** Generalizable insight can come from any data, not only from what the user types. Missing it in a tool result is just as costly as missing it in a prompt - and tool results are often where the surprising fact lives (a VS Code API quirk, an ssh2 event-order gotcha, a test-runner behavior under @swc/jest).

**How to apply:**
1. At the end of each response turn, mentally scan ALL data that entered context that turn against the signals above.
2. If you spot something generalizable, document it in the same response. No queue, no permission-asking.
3. Briefly mention what was saved and where so the user can verify or correct.
4. If unsure whether it is generalizable, save it anyway - a false positive costs one line; a false negative repeats a mistake later.
5. Before saving, check existing `CLAUDE.md` / `.adn/lessons.md` to update rather than duplicate.
