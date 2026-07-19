# AI assistant compatibility

`AGENTS.md` is the canonical repository instruction file. Any assistant that supports repository instructions should read it before changing the project.

## Shared artifacts

| Artifact | Purpose |
| --- | --- |
| `AGENTS.md` | Canonical project rules, engineering constraints, documentation routing, and verification expectations. |
| `.adn/` | Project architecture, feature, flow, configuration, testing, and lessons documentation. |
| `.agents/skills/` | Repository-shared skills. Assistants that do not discover this directory automatically can be pointed to the required `SKILL.md` file. |
| `CLAUDE.md` | Claude Code compatibility entry point that imports `AGENTS.md`. |
| `.claude/` | Claude Code-only settings, hooks, and skill copies required by its directory convention. |

No assistant-specific runtime state belongs in the repository. Credentials, session data, checkpoints, caches, and user-global configuration remain local and are ignored by Git.

The two vendored design skills retain their native copies because they include upstream assets and licenses. Their behavior is verified by the project skill inventory; the text-only shared skills must remain byte-identical between `.agents/skills/` and `.claude/skills/`.

## Maintenance contract

Step 1: Edit the canonical rule or shared skill under `AGENTS.md`, `.adn/`, or `.agents/skills/`.

Step 2: Update the Claude Code counterpart under `.claude/` when the assistant needs the same capability through its native convention.

Step 3: Run `powershell -NoProfile -File scripts/verify-ai-infra.ps1` before committing. The check validates the instruction entry points, required shared skills, Claude Code settings JSON, and absence of obsolete project-level Codex hooks.

Step 4: Update this document if a new assistant integration introduces a committed convention, and keep any vendor-specific configuration narrow. Unknown future assistants should use `AGENTS.md` plus `.adn/` until a verified native integration is added.

The historic `D:\CT\Repos\3in1` source referenced by the porting catalog is not available in this workspace. Treat `.agents/skills/porting-ai-docs/references/catalog.md` as historical provenance, not a live upstream feed.
