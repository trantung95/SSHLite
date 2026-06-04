# Relaxation policy (solo-managed target)

A source repo built for a team and a production system encodes strictness that a solo, no-production-risk target does not need. When porting into such a target, downgrade enforcement to guidance. Keep the substance, drop the ceremony.

## Principle

The value of a rule is the behavior it produces. Strict framing (hard gates, "restart from root", "trust damage with reviewer", all-caps MANDATORY) is justified when a violation hits production or a teammate. In a solo repo with no production database and direct-to-master commits, that framing adds friction without adding safety. Convert it to a clear default the author follows by judgement.

## What to relax, and to what

| Strict source pattern | Relax to |
|---|---|
| Per-action git approval gate (every git verb needs explicit per-message authorization) | Normal git use. Commit directly; still never skip hooks or signing. |
| Mandatory multi-file read gate before ANY response (including clarifying questions) | "Read lessons and the matching doc when the task touches that area." A reminder, not a precondition for every reply. |
| "Skipping = restart from root" / "same mistake twice = broken process" | Plain guidance: read lessons, re-plan when a premise is disproved. Drop the punitive framing. |
| All-caps MANDATORY / CRITICAL on routine reminders | Normal sentence case. Reserve emphasis for the few things that genuinely break (data loss, backward-compat). |
| Production-database read-only enforcement, secrets-block gates, reviewer sign-off | Drop entirely if the target has no production system or reviewer. |

## What NOT to relax

- Data-correctness rules. "Never truncate or lose data" stays absolute - that is a correctness invariant, not ceremony.
- Backward-compatibility rules for shipped config / settings / keybindings. Breaking a user's saved hosts is still a real cost in a solo repo.
- Build-and-test-before-done. Verification is still the bar for "done"; relax the tone, not the requirement.
- Personal preferences the user explicitly keeps (here: no-em-dash, expand abbreviations). These are the user's choice, not source strictness.

## How it was applied for SSH Lite

- `.claude/settings.local.json`: the 6-step mandatory SessionStart checklist ("complete BEFORE any tool call or response, including clarifying questions ... Skipping = restart from root ... authorised the read cost") became a short reminder to read `.adn/lessons.md` and the relevant `.adn/` doc.
- `.claude/settings.json`: the SessionStart echo lost "MANDATORY ... before any work. Same mistake twice = broken process." in favor of a neutral pointer.
- `CLAUDE.md`: the AI Behavior section kept every actual instruction (plan first, sub-agents first, read related files, prove it works, self-fix) but lost the restart-from-root / broken-process / all-caps coercion.
