# PostToolUse hook for Edit|Write - blocks the em-dash character (U+2014) from being written to files
# Per .claude/skills/no-em-dash/SKILL.md and .claude/critical-rules.md (Output style)
# Exit 2 = block

$ErrorActionPreference = 'Stop'

# Decode stdin as UTF-8 so an em-dash in the tool payload arrives as U+2014 regardless of console codepage.
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Hook usage tracking (best-effort, never blocks the hook). See .claude/hooks/lib/hook-usage-log.ps1
try { . "$env:CLAUDE_PROJECT_DIR\.claude\hooks\lib\hook-usage-log.ps1"; Write-HookUsage -HookName 'block-em-dash' -EventName 'PostToolUse:Edit/Write' | Out-Null } catch { }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

# For Write the whole file is in .content; for Edit the replacement text is in .new_string
$content = $null
if ($payload.tool_input.content) {
    $content = $payload.tool_input.content
} elseif ($payload.tool_input.new_string) {
    $content = $payload.tool_input.new_string
}

if (-not $content) { exit 0 }

$filePath = $payload.tool_input.file_path

# Allow the character in files that legitimately contain it: the skill that documents it,
# lessons.md (older entries quote it), and this hook itself.
$allowedFiles = @(
    '*.claude\skills\no-em-dash\SKILL.md',
    '*lessons.md',
    '*\.claude\hooks\block-em-dash.ps1'
)
foreach ($pattern in $allowedFiles) {
    if ($filePath -like $pattern) {
        exit 0
    }
}

# U+2014 EM DASH (matched by codepoint so it is immune to .ps1 file-encoding and console codepage)
if ($content.Contains([char]0x2014)) {
    [Console]::Error.WriteLine(@"
BLOCKED: em-dash character (U+2014) detected in $filePath.

Per .claude/skills/no-em-dash/SKILL.md and .claude/critical-rules.md - the user's keyboard cannot type this character.

Replace each em-dash with one of:
  - hyphen with spaces:  ` - `
  - colon:               `:`
  - parentheses:         `(like this)`
  - sentence break:      end one sentence, start another

Do NOT auto-substitute with the double hyphen `--`.
"@)
    exit 2
}

exit 0
