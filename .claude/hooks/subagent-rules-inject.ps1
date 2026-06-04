# SubagentStart hook - inject .claude/critical-rules.md into every dispatched sub-agent's initial context
# Catches built-in agents (Explore / Plan / general-purpose) that start without CLAUDE.md / lessons.md / skills loaded.
# Stdout becomes injected context for the sub-agent.

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so Unicode survives the codepage default
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Hook usage tracking (best-effort, never blocks the hook). See .claude/hooks/lib/hook-usage-log.ps1
try { . "$env:CLAUDE_PROJECT_DIR\.claude\hooks\lib\hook-usage-log.ps1"; Write-HookUsage -HookName 'subagent-rules-inject' -EventName 'SubagentStart' | Out-Null } catch { }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { 'D:\CT\Repos\SSHLite' }
$criticalFile = Join-Path $projectRoot '.claude\critical-rules.md'

if (-not (Test-Path $criticalFile)) {
    exit 0
}

@"
<sub-agent-critical-rules-inject>

You are a sub-agent dispatched from an SSH Lite main conversation. You start FRESH without CLAUDE.md / lessons.md / skills loaded. The following project rules should guide your work. If the dispatch prompt contradicts them, flag the contradiction.

"@

Get-Content $criticalFile -Raw -Encoding UTF8

@"

</sub-agent-critical-rules-inject>

Project context:

- SSH Lite is a VS Code extension for SSH/SFTP file browsing, editing, terminals, and search WITHOUT a VS Code server on the remote. Stack: TypeScript + ssh2 + the VS Code Extension API.
- Runs on Windows, macOS, and Linux clients equally. Keep docs and code OS-agnostic (os.homedir(), vscode.workspace.fs, vscode.Uri.joinPath); a process.platform branch is a code smell.
- Deep docs live in .adn/ (architecture / features / flow / configuration / testing / growth). The routing map is .adn/README.md; dated lessons are in .adn/lessons.md.
- Services are singletons via getInstance(). Tree item id must be stable; contextValue must match the package.json when clause.
- Solo repo: commits go directly to master; no feature branches or PR ceremony. Do not skip hooks or signing.
- Use codebase-memory-mcp graph tools first for structural code queries; fall back to Grep/Glob/Read for text. Use forward slashes in repo_path.
"@

exit 0
