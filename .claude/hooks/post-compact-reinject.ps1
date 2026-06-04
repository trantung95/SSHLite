# PostCompact hook - anti-drift re-injection after context compaction
# Re-injects .claude/critical-rules.md + key CLAUDE.md sections + restores _context_checkpoint.md.
# Stdout becomes injected context for the post-compact conversation.

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so Unicode in CLAUDE.md content survives the codepage default
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Hook usage tracking (best-effort, never blocks the hook). See .claude/hooks/lib/hook-usage-log.ps1
try { . "$env:CLAUDE_PROJECT_DIR\.claude\hooks\lib\hook-usage-log.ps1"; Write-HookUsage -HookName 'post-compact-reinject' -EventName 'PostCompact' | Out-Null } catch { }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { 'D:\CT\Repos\SSHLite' }
$claudeMdFile = Join-Path $projectRoot 'CLAUDE.md'
$criticalFile = Join-Path $projectRoot '.claude\critical-rules.md'
$checkpointFile = Join-Path $projectRoot '.claude\_context_checkpoint.md'

@"
<post-compact-reinject>

Context was just compacted. The following sections are RE-INJECTED so load-bearing rules and active state survive compaction. Treat as authoritative.

"@

# Critical rules (always-on tier)
if (Test-Path $criticalFile) {
    "## Critical rules (anti-drift re-inject)"
    Get-Content $criticalFile -Raw -Encoding UTF8
    ""
}

# CLAUDE.md LITE Principles + AI Behavior + Git Workflow sections
if (Test-Path $claudeMdFile) {
    $lines = Get-Content $claudeMdFile -Encoding UTF8

    function Extract-Section {
        # From a header line (SimpleMatch on $StartHeader) up to the next "## " header.
        param([string[]]$AllLines, [string]$StartHeader)
        $startIdx = ($AllLines | Select-String -Pattern $StartHeader -SimpleMatch | Select-Object -First 1).LineNumber
        if (-not $startIdx) { return $null }
        $endIdx = $AllLines.Count
        for ($i = $startIdx; $i -lt $AllLines.Count; $i++) {
            if ($AllLines[$i] -match '^## ') { $endIdx = $i; break }
        }
        return $AllLines[($startIdx - 1)..($endIdx - 1)]
    }

    foreach ($hdr in @('## LITE Principles', '## AI Behavior', '## Git Workflow')) {
        $sec = Extract-Section -AllLines $lines -StartHeader $hdr
        if ($sec) {
            "## CLAUDE.md $($hdr.TrimStart('# ')) (re-injected)"
            $sec -join "`n"
            ""
        }
    }
}

# Restore checkpoint
if (Test-Path $checkpointFile) {
    "## Restored from _context_checkpoint.md (pre-compact state)"
    Get-Content $checkpointFile -Raw -Encoding UTF8
    ""
}

@"
**Action after this re-inject:**
1. Re-read the above sections - they are the load-bearing rules that may have been summarized away during compaction
2. Confirm the file/area in flight from the checkpoint above
3. Continue work; keep the LITE principles and no-em-dash rule in force

</post-compact-reinject>
"@

exit 0
