[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Require-Path {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        $script:failures.Add("Missing required path: $Path")
    }
}

Require-Path (Join-Path $repoRoot 'AGENTS.md')
Require-Path (Join-Path $repoRoot 'CLAUDE.md')
Require-Path (Join-Path $repoRoot '.adn')
Require-Path (Join-Path $repoRoot '.agents/skills')
Require-Path (Join-Path $repoRoot '.claude/settings.json')

$requiredSkills = @(
    'auto-document-reusable',
    'auto-gotcha',
    'canvas-design',
    'frontend-design',
    'no-shorthand',
    'porting-ai-docs',
    'short-simple-answers'
)

foreach ($skill in $requiredSkills) {
    Require-Path (Join-Path $repoRoot ".agents/skills/$skill/SKILL.md")
}

$mirroredSkillFiles = @(
    'auto-document-reusable/SKILL.md',
    'auto-gotcha/SKILL.md',
    'porting-ai-docs/SKILL.md',
    'porting-ai-docs/references/catalog.md',
    'short-simple-answers/SKILL.md'
)

foreach ($relativePath in $mirroredSkillFiles) {
    $sharedPath = Join-Path $repoRoot ".agents/skills/$relativePath"
    $claudePath = Join-Path $repoRoot ".claude/skills/$relativePath"
    Require-Path $claudePath
    if ((Test-Path -LiteralPath $sharedPath) -and (Test-Path -LiteralPath $claudePath)) {
        $sharedContent = (Get-Content -Raw -LiteralPath $sharedPath) -replace "`r`n", "`n"
        $claudeContent = (Get-Content -Raw -LiteralPath $claudePath) -replace "`r`n", "`n"
        if ($sharedContent -cne $claudeContent) {
            $failures.Add("Claude Code skill copy drifted from shared skill: $relativePath")
        }
    }
}

$legacyFallback = 'D:\\CT\\Repos\\SSHLite'
Get-ChildItem -Path (Join-Path $repoRoot '.claude/hooks') -Filter '*.ps1' -Recurse | ForEach-Object {
    if ((Get-Content -Raw -LiteralPath $_.FullName) -match $legacyFallback) {
        $failures.Add("Claude Code hook retains the obsolete repository fallback: $($_.FullName)")
    }
}

try {
    $null = Get-Content -Raw (Join-Path $repoRoot '.claude/settings.json') | ConvertFrom-Json
}
catch {
    $failures.Add("Invalid Claude Code settings JSON: $($_.Exception.Message)")
}

$agentsText = Get-Content -Raw (Join-Path $repoRoot 'AGENTS.md')
$claudeText = Get-Content -Raw (Join-Path $repoRoot 'CLAUDE.md')
if ($agentsText -notmatch 'AI assistant compatibility') {
    $failures.Add('AGENTS.md does not identify the canonical compatibility contract.')
}
if ($claudeText -notmatch '@AGENTS\.md') {
    $failures.Add('CLAUDE.md does not import the canonical AGENTS.md instructions.')
}
$trackedCodex = @(& git -C $repoRoot ls-files -- '.codex')
if ($trackedCodex.Count -gt 0) {
    $failures.Add('Obsolete project-level .codex automation is tracked. Use AGENTS.md and documented native integrations instead.')
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Output 'AI infrastructure verification passed.'
