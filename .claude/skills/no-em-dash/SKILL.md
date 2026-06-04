---
name: no-em-dash
description: Use when writing or editing any file or output in this repo. Never emit the em-dash character (U+2014); the user's keyboard cannot type it. Enforced by the block-em-dash PostToolUse hook.
---

Do not use the em-dash character (U+2014) `—` in any output or file. Use a single regular hyphen with spaces ( - ), a colon ( : ), parentheses, or a sentence break instead.

**Why:** The user's keyboard has no em-dash key, so they cannot easily edit or retype text that contains it. Do NOT auto-substitute with the double hyphen `--` either - it reads as an ambiguous token (and is a comment prefix in several languages).

**How to apply:** All output and all files - code, comments, commit messages, docs (README, CHANGELOG, .adn/), chat replies, GitHub issue/PR text. Use ` - ` (spaced hyphen) where you would reach for an em-dash.

**Enforcement:** `.claude/hooks/block-em-dash.ps1` runs on every Write/Edit and rejects content containing U+2014 with exit 2 (the `no-em-dash` skill, `.adn/lessons.md`, and the hook itself are allowlisted because they legitimately contain the character). If an edit is blocked, replace the em-dash and retry.
