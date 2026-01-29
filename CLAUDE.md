# SSH Lite - Project Rules

**IMPORTANT: These rules apply to ALL prompts (agents, skills, regular chat).**

## Required Actions

1. **READ `.claude-workflow.md`** at the start of every prompt
2. **UPDATE `.claude-workflow.md`** after any flow/feature/implementation changes
3. **SYNC** workflow file and source code - they must always match

## LITE Principles (CRITICAL)

SSH Lite must be **LITE** - minimize server resources and UI complexity.

| Rule | Bad | Good |
|------|-----|------|
| No auto server commands | `find` on every keystroke | User clicks "Search" button |
| No polling by default | Auto-refresh enabled | User enables in settings |
| Cache aggressively | Preload 5 subdirs | Load on user expand |
| Single connection | Multiple SSH sessions | Reuse connection |
| Debounce actions | Immediate server call | 300ms+ debounce |

**Before implementing, ask:**
- Does this run server commands automatically? → Make it user-triggered
- Does this poll the server? → Make it opt-in, default OFF
- Does this preload data? → Make it lazy-load on demand

## Code Quality

- Remove unused files/code - no dead code
- Use `log()` for output channel logging
- Don't log in loops - log summaries
- Keep source clean and consolidated

## Testing

- Run `npx jest --no-coverage` before committing
- Add tests for new functionality
- Use shared mocks from `src/__mocks__/testHelpers.ts`
