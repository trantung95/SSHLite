# PreCompact hook - snapshot state before context compaction
# Writes .claude/_context_checkpoint.md (session state + most recently touched files), restored by post-compact-reinject.ps1.

$ErrorActionPreference = 'Stop'

# Hook usage tracking (best-effort, never blocks the hook). See .claude/hooks/lib/hook-usage-log.ps1
try { . "$env:CLAUDE_PROJECT_DIR\.claude\hooks\lib\hook-usage-log.ps1"; Write-HookUsage -HookName 'pre-compact-backup' -EventName 'PreCompact' | Out-Null } catch { }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { 'D:\CT\Repos\SSHLite' }
$checkpointFile = Join-Path $projectRoot '.claude\_context_checkpoint.md'
$stateFile = Join-Path $projectRoot '.claude\_session_state.json'

$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { $null }

$transcriptSummary = if ($payload.transcript_path -and (Test-Path $payload.transcript_path)) {
    "Transcript path: $($payload.transcript_path) (full transcript persisted by Claude Code)"
} else {
    "Transcript path not provided in PreCompact payload"
}

# Snapshot the most recently modified working files (the "what was I working on" hint).
$recentBlock = "No recently modified files found"
try {
    $scanDirs = @('.adn', 'docs\superpowers', 'src') | ForEach-Object { Join-Path $projectRoot $_ } | Where-Object { Test-Path $_ }
    $recent = Get-ChildItem -Path $scanDirs -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 6
    if ($recent) {
        $recentBlock = ($recent | ForEach-Object {
            $rel = $_.FullName.Substring($projectRoot.Length).TrimStart('\')
            "- $rel (last mod: $($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"
        }) -join "`n"
    }
} catch {}

$checkpoint = @"
# Context Checkpoint - $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss UTC'))

Auto-written by PreCompact hook before context compaction. Restored by PostCompact hook into post-compact context.

## Session state at compact time
- Turn count: $($state.turnCount)
- Session start: $($state.sessionStartUtc)
- Last inject: $($state.lastInjectUtc)

## Most recently modified files (top 6 across .adn / docs/superpowers / src)
$recentBlock

## Compact event payload
$transcriptSummary

## Next-turn priorities (for me-after-compaction to resume)
- Re-read .claude/critical-rules.md (LITE Principles + Working method) - re-injected by PostCompact hook
- Re-read the matching .adn/ doc for the area in flight
- Continue from where the transcript left off

## Notes
This file is per-session and gitignored. Safe to delete after the session ends.
"@

Set-Content -Path $checkpointFile -Value $checkpoint -Encoding utf8

[Console]::Error.WriteLine("PreCompact: state checkpointed to .claude/_context_checkpoint.md")
exit 0
