---
name: auto-gotcha
description: Use right after fixing any bug or discovering a reusable pattern. If it could bite again on different work, auto-add it to CLAUDE.md or .adn/lessons.md in the same response, without asking.
---

When any fix or pattern discovered during work is reusable for the future, AUTOMATICALLY record it immediately after the fix. Do NOT wait for the user to ask.

- General convention or repeatable pattern -> `CLAUDE.md`
- Tactical one-off tied to a specific incident -> `.adn/lessons.md` (dated entry)

**Why:** The reflex is to fix the issue and move on without recording the reusable part, which means the same class of mistake can recur. SSH Lite already states this as a rule ("same mistake twice = broken process"); this skill is the mechanical habit that makes it happen in the same response, not "next time".

**How to apply:** After every fix, ask: "Could this bite us again on a different change?" If yes, add it to the right place right away, in the same response as the fix. No confirmation needed. Before saving, check whether `CLAUDE.md` / `.adn/lessons.md` already covers it and update rather than duplicate.

**Counter-example (the failure mode this prevents):** a fix is made, the root cause is understood, but the reusable insight is only kept in the chat and never written down. A later change hits the same trap and the work is redone from scratch. The cost of one line of documentation now is far less than re-debugging later.
