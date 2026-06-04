# 3in1 -> SSH Lite port catalog

The concrete classification of every AI-doc artifact in `D:\CT\Repos\3in1`, and what was done with it for SSH Lite. Use this to re-run the port, extend it, or re-sync after 3in1 changes. Method is in `../SKILL.md`.

Legend: **PORT** = installed adapted. **DROP** = source-specific, not installed. **OPT** = personal preference, installed because the user asked.

## Hooks (source: `D:\CT\Repos\3in1\.claude\hooks\`)

| Source hook | Event | Decision | Adaptation done (or reason to drop) |
|---|---|---|---|
| `lib/hook-usage-log.ps1` | dependency | PORT | Copied verbatim; project-agnostic, writes to `.claude_hook_report/` (gitignored). |
| `prompt-context-injector.ps1` | UserPromptSubmit | PORT | Fallback path -> SSH Lite root. Lessons source -> `.adn/lessons.md`. Lesson split changed from `^- \*\*` to `^## ` (SSH Lite lessons are `## YYYY-MM-DD` blocks). Refresh re-injects `## LITE Principles` instead of Init Rules / Production DB. |
| `pre-compact-backup.ps1` | PreCompact | PORT | `z_tickets/*/.adn/*` scan replaced with a top-6 recently-modified-files snapshot across `.adn/`, `docs/superpowers/`, `src/`. Next-turn priorities rewritten to SSH Lite (re-read critical-rules + matching `.adn/` doc). |
| `post-compact-reinject.ps1` | PostCompact | PORT | Extracts `## LITE Principles` + `## AI Behavior` + `## Git Workflow` instead of Init Rules / Production DB / Writing Style. Repointed `critical-rules.md` + checkpoint paths. |
| `subagent-rules-inject.ps1` | SubagentStart | PORT | Cartrack stack/DB/XML/branch block + named-agent list replaced with SSH Lite context (VS Code SSH extension, TypeScript + ssh2, OS-agnostic, `.adn/` docs, solo-master git, codebase-memory-mcp). |
| `block-em-dash.ps1` | PostToolUse Edit/Write | OPT | Allowlist repointed (no-em-dash skill, `.adn/lessons.md`, the hook); SQL `--` caveat replaced with a generic note. |
| `deny-auto-git.ps1` | PreToolUse Bash | DROP | Per-action git approval gate; SSH Lite is solo and commits directly to master. |
| `enforce-db-readonly.ps1` | PreToolUse | DROP | SSH Lite has no production database. |
| `block-mcp-unrestricted.ps1` | PostToolUse | DROP | Guards a `.mcp.json` restricted-access mode SSH Lite does not use. |
| `block-secrets.ps1` | PostToolUse | DROP (not selected) | Generic and reasonable, but the user opted out for this repo. Re-evaluate if secrets handling becomes a concern. |
| `build-flag.ps1` / `build-on-stop.ps1` | PostToolUse / Stop | DROP (not selected) | C# CAMS build trigger. The SSH Lite analogue would run `npm run compile`; user opted out. |
| `gitlab-logwork-reminder.ps1` | UserPromptSubmit | DROP | GitLab time-logging; not applicable. |
| `session-start.ps1` / `daily-doc-review.ps1` / `daily-cleanup.ps1` | SessionStart | DROP (not selected) | 3in1 session housekeeping; SSH Lite keeps its existing lighter SessionStart reminder. |
| `stop-auto-do-recheck.ps1` | Stop | DROP (not selected) | Auto-do recheck / loop guard; heavier than a solo repo needs. |

## Skills (source: `D:\CT\Repos\3in1\.claude\skills\`)

| Source skill | Decision | Notes |
|---|---|---|
| `no-em-dash` | OPT | Installed; SQL-comment reasoning genericized. Pairs with the block-em-dash hook. |
| `no-shorthand` | OPT | Installed; CAMS/Russell/David/CAMD/`.adn/2_database` examples stripped; reader roles retargeted to marketplace user / issue reporter / future maintainer. |
| `short-simple-answers` | OPT | Installed; MR/GitLab targets replaced with chat / commit / issue text. |
| `auto-document-reusable` | OPT | Installed; Zammad/CAMS/.rpt/function-touch-log/Ticket-Registry destinations replaced with `CLAUDE.md` + `.adn/lessons.md` + `.adn/` docs. |
| `auto-gotcha` | OPT | Installed; CAMD3711M / David counter-example replaced with a generic one. |
| `adaptive-plan-mode` | DROP (not selected) | Generic planning workflow but heavy and overlaps superpowers; not requested. Candidate for a future port. |
| `adn-system` | DROP (not selected) | `.adn` templates (mermaid / root-cause / QA). SSH Lite already has a mature `.adn/`; deeper template merge was declined. |
| `dispatch-subagent-brief` | DROP (not selected) | Generic sub-agent brief template; candidate for a future port. |
| `auto-commit` | DROP (not selected) | Auto git commit; not requested. |
| `db-probe-detail`, `ddl-export-load-warning`, `prelive-schema-changes`, `probe-vs-documented-fact`, `qa-steps-generic`, `sentinel-mr-detail`, `sql-script-detail`, `sql-target-engine-comment`, `validate-queries`, `verify-ddl-before-sql`, `secrets-blocklist`, `parent-ticket-sync` | DROP | Database / SQL / DDL / GitLab-MR / ticket domain skills. Not applicable to an SSH extension. |

## Agents (source: `D:\CT\Repos\3in1\.claude\agents\`)

| Source agent | Decision | Notes |
|---|---|---|
| `cartrack-db-prober` | DROP | Production PostgreSQL prober. |
| `release-script-reviewer` | DROP | SentinelMR SQL release-script reviewer. |
| `project-aware-explorer` | DROP (not selected) | Replaces built-in Explore with project rules. The SubagentStart hook already injects SSH Lite rules into built-in agents, so a custom agent is unnecessary here. |
| `project-aware-researcher` | DROP (not selected) | Same reasoning as above. |

## Docs / rules / reference

| Source artifact | Decision | Notes |
|---|---|---|
| `.claude/critical-rules.md` (13 rules) | DROP + rewrite | Replaced by a slim SSH Lite `.claude/critical-rules.md` distilled from LITE Principles + AI Behavior, with all production/DB/MR/git-deny rules removed. |
| `CLAUDE.md` (Cartrack rules) | DROP | SSH Lite keeps its own CLAUDE.md. |
| `lessons.md` (Cartrack incidents) | DROP | SSH Lite keeps its own `.adn/lessons.md`. |
| `CLAUDE-templates.md` | DROP (not selected) | SQL/script templates are domain-specific; folder/.adn templates were not requested. |
| `reference/` (apis, cartrack) | DROP | GitLab/Zammad API + Cartrack ecosystem docs; not applicable. |

## Settings wiring added to `.claude/settings.json`

- `UserPromptSubmit` -> prompt-context-injector.ps1
- `PreCompact` -> pre-compact-backup.ps1
- `PostCompact` -> post-compact-reinject.ps1
- `SubagentStart` -> subagent-rules-inject.ps1
- `PostToolUse` `Write|Edit` -> block-em-dash.ps1 (appended; existing commands-doc + chaos-catalog hooks preserved)

All use the Windows-safe form `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command & "$env:CLAUDE_PROJECT_DIR\.claude\hooks\<script>.ps1"; exit $LASTEXITCODE` (Claude Code does not expand `$CLAUDE_PROJECT_DIR` inside JSON args on Windows, so expansion happens PowerShell-side).

## Relaxation applied (see `relaxation-policy.md`)

- `.claude/settings.local.json` heavy mandatory SessionStart checklist -> light reminder.
- `.claude/settings.json` SessionStart echo -> non-coercive.
- `CLAUDE.md` "restart from root" / "same mistake twice = broken process" / all-caps MANDATORY framing -> normal guidance (substance kept).

## .gitignore additions

`.claude_hook_report/`, `.claude/_session_state.json`, `.claude/_context_checkpoint.md`.

## Verification

1. `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"` (and settings.local.json) - parses.
2. Pipe sample stdin JSON to each ported hook via `powershell.exe -NoProfile -File <hook>.ps1`:
   - block-em-dash: payload with U+2014 -> exit 2 + block message; clean payload -> exit 0.
   - prompt-context-injector: prompt with keywords present in `.adn/lessons.md` -> matched entries echoed; no critical-rules-not-found crash.
   - pre/post-compact + subagent-inject: `{}` stdin -> exit 0, output references SSH Lite (not Cartrack).
3. New skills appear in the available-skills list next session; spot-invoke `porting-ai-docs` and one personal skill.
4. `npm run compile` still clean (no code touched); existing commands-doc / chaos-catalog hooks still fire.
