# Shared hook-usage logger. Dot-sourced from the top of every hook script.
#
# Design contract (do NOT break - these keep it safe to inject into blocking /
# context-injecting hooks):
#   1. NEVER reads stdin. The host hook needs the event JSON on stdin; if this
#      helper consumed it, the hook would break.
#   2. NEVER writes to stdout. Several hooks (prompt-context-injector,
#      subagent-rules-inject, post-compact-reinject) turn their stdout into injected
#      context - any stray output here would corrupt that. Every statement that could
#      emit is captured or piped to Out-Null.
#   3. NEVER sets script-scope side effects (the file is dot-sourced, so top-level
#      assignments would leak into the host hook's scope). Only function definitions
#      live at top level; preferences are set locally inside functions.
#   4. Best-effort only. Any failure is swallowed so a logging problem can never
#      change the outcome of the hook it instruments.
#
# Output it maintains (all under .claude_hook_report/, gitignored):
#   hook_usage_state\<hook>.json   per-hook count + rolling last-10 detail rows
#   hook-usage-report.md           human-readable summary + last-10-per-hook report

function Get-HookUsageRoot {
    $base = $env:CLAUDE_PROJECT_DIR
    if (-not $base) {
        # this file = <root>\.claude\hooks\lib\hook-usage-log.ps1  ->  root is 3 levels up
        $base = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
    }
    return (Join-Path $base '.claude_hook_report')
}

function Get-HookUsageStateDir {
    $dir = Join-Path (Get-HookUsageRoot) 'hook_usage_state'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    return $dir
}

function Get-HookUsageReportFile {
    return (Join-Path (Get-HookUsageRoot) 'hook-usage-report.md')
}

function Get-ProjectRootFromHere {
    if ($env:CLAUDE_PROJECT_DIR) { return $env:CLAUDE_PROJECT_DIR }
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
}

function Get-ConfiguredHookScripts {
    # The .ps1 paths wired into .claude/settings.json hooks - the source of truth for
    # "what counts as a hook". ANY hook added to settings.json in the future is picked up
    # here automatically, so the un-instrumented check below covers future hooks too.
    $ErrorActionPreference = 'SilentlyContinue'
    $settings = Join-Path (Get-ProjectRootFromHere) '.claude\settings.json'
    if (-not (Test-Path -LiteralPath $settings)) { return @() }
    try { $cfg = Get-Content -Raw -LiteralPath $settings -Encoding UTF8 | ConvertFrom-Json } catch { return @() }
    $root = Get-ProjectRootFromHere
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($evt in $cfg.hooks.PSObject.Properties) {
        foreach ($matcher in @($evt.Value)) {
            foreach ($h in @($matcher.hooks)) {
                $argstr = ($h.args -join ' ')
                $mm = [regex]::Match($argstr, '([A-Za-z0-9_$:.\\/-]+\.ps1)')
                if ($mm.Success) {
                    $p = ($mm.Groups[1].Value -replace '\$env:CLAUDE_PROJECT_DIR', $root).Trim()
                    [void]$paths.Add($p)
                }
            }
        }
    }
    return @($paths | Select-Object -Unique)
}

function Get-UninstrumentedHooks {
    # Configured hook scripts that do NOT yet call Write-HookUsage.
    # ('Write-HookUsage' is ASCII so the match works regardless of a hook file's encoding.)
    $ErrorActionPreference = 'SilentlyContinue'
    $missing = @()
    foreach ($p in (Get-ConfiguredHookScripts)) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if ((Split-Path $p -Leaf) -eq 'hook-usage-report.ps1') { continue }  # the tool, not a hook
        $c = Get-Content -Raw -LiteralPath $p -Encoding UTF8
        if ($c -notmatch 'Write-HookUsage') { $missing += $p }
    }
    return @($missing)
}

function Write-HookUsage {
    param(
        [Parameter(Mandatory = $true)][string]$HookName,
        [string]$EventName = 'unknown'
    )
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $stateDir = Get-HookUsageStateDir
        $file     = Join-Path $stateDir ($HookName + '.json')

        $now    = [DateTimeOffset]::Now
        $ts     = $now.ToString('yyyy-MM-dd HH:mm:ss zzz')
        $sess   = if ($env:CLAUDE_SESSION_ID) { $env:CLAUDE_SESSION_ID } else { '' }
        $sessShort = if ($sess.Length -gt 8) { $sess.Substring($sess.Length - 8) } else { $sess }

        $entry = [ordered]@{ ts = $ts; session = $sessShort }

        $mtx = New-Object System.Threading.Mutex($false, "Global\CC_hookusage_$HookName")
        $got = $false
        try { $got = $mtx.WaitOne(2000) } catch [System.Threading.AbandonedMutexException] { $got = $true } catch { $got = $false }

        if ($got) {
            try {
                if (Test-Path -LiteralPath $file) {
                    $state = Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json
                } else {
                    $state = [pscustomobject]@{ hook = $HookName; event = $EventName; count = 0; first = $ts; last = $ts; recent = @() }
                }

                if (-not $state.PSObject.Properties['first']) { Add-Member -InputObject $state -NotePropertyName first -NotePropertyValue $ts -Force }
                $state.hook  = $HookName
                $state.event = $EventName
                $state.count = [int]$state.count + 1
                $state.last  = $ts

                $recent = @($entry) + @($state.recent | Where-Object { $_ })
                if ($recent.Count -gt 10) { $recent = $recent[0..9] }
                $state.recent = $recent

                ($state | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $file -Encoding UTF8
            } finally {
                $mtx.ReleaseMutex()
                $mtx.Dispose()
            }
        }

        Update-HookReport
    } catch { }
}

function ConvertTo-CellText {
    param([string]$Value)
    # Pipe breaks GitHub/GitLab markdown table columns; backslash-escape it.
    if ($null -eq $Value) { return '' }
    return ($Value -replace '\|', '\|')
}

function Update-HookReport {
    param([switch]$Force)  # -Force kept for API compatibility; rebuild is always run now
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $stateDir = Get-HookUsageStateDir
        $report   = Get-HookUsageReportFile

        $files = @(Get-ChildItem -LiteralPath $stateDir -Filter '*.json' -ErrorAction SilentlyContinue)
        if ($files.Count -eq 0) { return }

        $states = @()
        foreach ($f in $files) {
            try { $states += (Get-Content -Raw -LiteralPath $f.FullName -Encoding UTF8 | ConvertFrom-Json) } catch { }
        }
        $states = @($states | Where-Object { $_ } | Sort-Object -Property @{ Expression = { [int]$_.count } } -Descending)
        if ($states.Count -eq 0) { return }

        $gen   = [DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz')
        $total = ($states | Measure-Object -Property count -Sum).Sum

        $sb = New-Object System.Text.StringBuilder
        [void]$sb.AppendLine('# Hook Usage Report')
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('> Auto-generated by `.claude/hooks/lib/hook-usage-log.ps1`. Every hook records one row when it fires; this report keeps a running count plus the last 10 detail rows per hook.')
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine("Generated: ${gen}")
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine("Total hook invocations: ${total} across $($states.Count) hooks tracked.")
        [void]$sb.AppendLine('')

        [void]$sb.AppendLine('## Summary')
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('| Hook | Event | Count | First used | Last used |')
        [void]$sb.AppendLine('|------|-------|------:|------------|-----------|')
        foreach ($s in $states) {
            $h = ConvertTo-CellText $s.hook
            $e = ConvertTo-CellText $s.event
            $fu = ConvertTo-CellText $s.first
            $lu = ConvertTo-CellText $s.last
            [void]$sb.AppendLine("| $h | $e | $($s.count) | $fu | $lu |")
        }
        [void]$sb.AppendLine('')

        [void]$sb.AppendLine('## Recent activity (last 10 per hook)')
        foreach ($s in $states) {
            [void]$sb.AppendLine('')
            [void]$sb.AppendLine("### $(ConvertTo-CellText $s.hook)")
            [void]$sb.AppendLine('')
            [void]$sb.AppendLine("Event: $($s.event)  /  Count: $($s.count)")
            [void]$sb.AppendLine('')
            [void]$sb.AppendLine('| # | Timestamp | Session |')
            [void]$sb.AppendLine('|--:|-----------|---------|')
            $i = 1
            foreach ($r in @($s.recent | Where-Object { $_ })) {
                $sv = if ($r.session) { ConvertTo-CellText $r.session } else { '-' }
                $tv = ConvertTo-CellText $r.ts
                [void]$sb.AppendLine("| $i | $tv | $sv |")
                $i++
            }
        }

        $md = $sb.ToString()

        $rmtx = New-Object System.Threading.Mutex($false, 'Global\CC_hookusage_report')
        $rgot = $false
        try { $rgot = $rmtx.WaitOne(1000) } catch [System.Threading.AbandonedMutexException] { $rgot = $true } catch { $rgot = $false }
        if ($rgot) {
            try {
                Set-Content -LiteralPath $report -Value $md -Encoding UTF8
            } finally {
                $rmtx.ReleaseMutex()
                $rmtx.Dispose()
            }
        }
    } catch { }
}
