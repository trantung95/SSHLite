# UserPromptSubmit hook - anti-drift context injection for SSH Lite
#   Mechanism 1 (always-inject): inject .claude/critical-rules.md every prompt
#   Mechanism 2 (threshold refresh): re-inject CLAUDE.md "LITE Principles" past turn 30 or 30 min idle
#   Mechanism 3 (lazy lessons): grep .adn/lessons.md for dated entries matching the prompt's keywords
# Stdout becomes injected context for the new prompt.

$ErrorActionPreference = 'Stop'

# UTF-8 output so Unicode in critical-rules.md / CLAUDE.md / lessons.md survives PowerShell 5.1's default codepage stdout
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Hook usage tracking (best-effort, never blocks the hook). See .claude/hooks/lib/hook-usage-log.ps1
try { . "$env:CLAUDE_PROJECT_DIR\.claude\hooks\lib\hook-usage-log.ps1"; Write-HookUsage -HookName 'prompt-context-injector' -EventName 'UserPromptSubmit' | Out-Null } catch { }

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { 'D:\CT\Repos\SSHLite' }
$stateFile = Join-Path $projectRoot '.claude\_session_state.json'
$criticalFile = Join-Path $projectRoot '.claude\critical-rules.md'
$lessonsFile = Join-Path $projectRoot '.adn\lessons.md'
$claudeMdFile = Join-Path $projectRoot 'CLAUDE.md'

# Load / increment session state (used here for the refresh threshold and by pre-compact-backup)
$state = if (Test-Path $stateFile) {
    Get-Content $stateFile -Raw | ConvertFrom-Json
} else {
    [PSCustomObject]@{ turnCount = 0; lastInjectUtc = [DateTime]::UtcNow.AddDays(-1).ToString('o'); sessionStartUtc = [DateTime]::UtcNow.ToString('o') }
}
$state.turnCount = [int]$state.turnCount + 1
$lastInject = try { [DateTime]::Parse($state.lastInjectUtc).ToUniversalTime() } catch { [DateTime]::UtcNow.AddDays(-1) }
$minutesSinceLastInject = ([DateTime]::UtcNow - $lastInject).TotalMinutes

# Helper: extract a markdown section from a header line up to the next "## " header
function Get-MdSection {
    param([string[]]$AllLines, [string]$StartHeader)
    $startIdx = ($AllLines | Select-String -Pattern $StartHeader -SimpleMatch | Select-Object -First 1).LineNumber
    if (-not $startIdx) { return $null }
    $endIdx = $AllLines.Count
    for ($i = $startIdx; $i -lt $AllLines.Count; $i++) {
        if ($AllLines[$i] -match '^## ') { $endIdx = $i; break }
    }
    return $AllLines[($startIdx - 1)..($endIdx - 1)]
}

# Mechanism 1: ALWAYS inject critical-rules.md
if (Test-Path $criticalFile) {
    "<critical-rules>"
    Get-Content $criticalFile -Raw -Encoding UTF8
    "</critical-rules>"
}

# Mechanism 2: threshold refresh - re-inject the single most load-bearing CLAUDE.md section past turn 30 OR 30 min idle
$shouldRefresh = ($state.turnCount -gt 30) -or ($minutesSinceLastInject -gt 30)
if ($shouldRefresh -and (Test-Path $claudeMdFile)) {
    $lines = Get-Content $claudeMdFile -Encoding UTF8
    $lite = Get-MdSection -AllLines $lines -StartHeader '## LITE Principles'
    if ($lite) {
        "<context-refresh-after-$($state.turnCount)-turns>"
        "# CLAUDE.md LITE Principles re-injected (anti-drift, turn $($state.turnCount), $([Math]::Round($minutesSinceLastInject)) min since last refresh):"
        ""
        $lite -join "`n"
        "</context-refresh-after-$($state.turnCount)-turns>"
        $state.lastInjectUtc = [DateTime]::UtcNow.ToString('o')
    }
}

# Mechanism 3: lazy-grep .adn/lessons.md for dated entries matching the prompt keywords.
# SSH Lite lessons are blocks delimited by "## YYYY-MM-DD ..." headers, so split on "## ".
$userPrompt = $payload.prompt
if ($userPrompt -and (Test-Path $lessonsFile)) {
    $stopwords = @('this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which', 'they', 'them', 'will', 'would', 'should', 'could', 'about', 'just', 'like', 'into', 'than', 'more', 'some', 'such', 'these', 'those', 'their', 'over', 'only')
    $tokens = [regex]::Matches($userPrompt.ToLower(), '\b[a-z][a-z0-9_]{3,}\b') | ForEach-Object { $_.Value } | Sort-Object -Unique | Where-Object { $stopwords -notcontains $_ }

    if ($tokens.Count -gt 0) {
        $lessonsContent = Get-Content $lessonsFile -Raw -Encoding UTF8
        # Split into entries; each lesson entry starts with a "## " header line
        $entries = [regex]::Split($lessonsContent, '(?m)^(?=## )')
        $matchedEntries = @()
        foreach ($entry in $entries) {
            if ($entry -notmatch '^## ') { continue }   # skip the file preamble chunk
            $entryLower = $entry.ToLower()
            $hitCount = ($tokens | Where-Object { $entryLower.Contains($_) }).Count
            if ($hitCount -ge 2) {
                $matchedEntries += $entry.TrimEnd()
            }
        }
        if ($matchedEntries.Count -gt 0) {
            ""
            "<lessons-matching-prompt-keywords>"
            "# .adn/lessons.md entries matching $($tokens.Count) prompt keywords (showing $($matchedEntries.Count) of $($entries.Count) entries):"
            ""
            $matchedEntries -join "`n`n"
            "</lessons-matching-prompt-keywords>"
        }
    }
}

# Persist state
$state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding utf8

exit 0
