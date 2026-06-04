---
name: no-shorthand
description: Use when producing any text a person other than you will read (README, CHANGELOG, GitHub issue or PR text, hand-off notes, .adn docs). Expand every abbreviation on first use and tailor content to the reader. Banned placeholders TBD/TBC/???.
---

When writing anything another person will read - README sections, CHANGELOG entries, GitHub issue or pull request text, marketplace copy, hand-off notes, `.adn/` docs - apply these:

1. **Expand every abbreviation on first use, every time.** Examples: "Secure File Transfer Protocol (SFTP)" not just "SFTP" on first use; "Recurring Mandate Service (RMS)" not "RMS"; "No Response (NRSP)" not "NRSP". After the first expansion you may use the short form.

2. **Do NOT invent local shorthand.** Either use the full name every time, or introduce a named alias up front ("the progressive download manager") and use it consistently.

3. **Tailor content to the reader's role.** Do not default to the same "background + steps + summary" shape for everyone:
   - **Marketplace / end user** (reads README, CHANGELOG): they want the value and how to click it, not internals. Lead with what they do and see.
   - **Issue reporter**: they want bug summary + fix summary + how to confirm, not the code trace.
   - **A future maintainer** (could be you, months later): they want the why, the scope, the risk, and the `.adn/` pointer.

4. **Just enough info; no bloat.** Strip every line that does not advance the reader's task. No "Background / What is X?" sections for readers who already work in the system. Drop verbose adjectives, keep concrete predicates. Do not restate what an earlier section already covered.

5. **Step labels:** write "Step 1", "Step 2" rather than bare numbers so a reader scanning can tell instructions from list items.

6. **Banned placeholders: `TBD`, `TBC`, `???`.** These signal an unfinished decision. Either name the decider and trigger, or fill in the actual answer. Never park a placeholder in reader-facing text.

**Why:** This is a stricter restatement of the global rule "always expand abbreviations on first use" plus "assume a newcomer reader". The reflex to write thoroughly is usually wrong - keep cutting until only the minimum the reader needs remains.

**How to apply:**
- Trigger on: any README / CHANGELOG edit, GitHub issue or PR body, hand-off note, marketplace copy, `.adn/` doc meant for a reader.
- First identify the reader's role; if unknown, ask. Then write only what that role needs.
- Before saving, scan for any all-caps token (SFTP, SSH, RMS, NRSP, etc.) and confirm the full term appears on first use; if not, expand it.
- Also scan for `TBD` / `TBC` / `???` and replace each with a decision-trigger or the actual answer.
- Internal scratch notes for yourself (debugging traces, root-cause jottings) may still use shorthand - this rule only applies to text meant for another reader.
