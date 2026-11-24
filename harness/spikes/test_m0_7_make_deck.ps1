<#
.SYNOPSIS
  Tests for m0_7_make_deck.ps1: -OutPdf validation, failure exits that must not leave a PDF behind, and that an
  author's own PowerPoint session is not disturbed.

.DESCRIPTION
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test_m0_7_make_deck.ps1 [-TimeoutSec 300]
  Prints DECK SCRIPT TESTS OK and exits 0 when every check holds. Exit codes: 0 ok, 1 failed, 2 timeout.

  Needs corpus/private/probe/original.pptx and the harness venv; prints "SKIP local fixture missing" and exits 0
  without the fixture.

  Steps:
    - Without PowerPoint: -OutPdf equal to the input, -OutPdf not ending in .pdf (exit 3, the named file is not
      deleted), and the timeout hooks (exit 2, no PDF, no temp copy left): a hang that stopping the job can
      interrupt, and one it cannot (-TestBlockSec, as in a PowerPoint call blocked by a dialog), where the script
      must still exit 2 within 30 s, read to the end of its output pipes as Python's capture_output reads it.
    - Failure after the PDF was written: a scratch copy of the script in a tree without the harness venv exits 4.
      The PDF it wrote must be gone, a neighbouring file must be untouched.
    - Author-session check, in a Start-Job under a timeout. Only when no PowerPoint is running: this test starts
      its own instance, opens an untitled unsaved presentation and the very file the script is about to use
      (edited, unsaved) as stand-ins for the author's work, runs the script with that file as input and asserts
      that the process, the presentation count, both stand-ins and the file on disk are unchanged. It closes only
      what it opened without saving and quits only the instance it started (decided by process id). If a
      PowerPoint is already running, this part is skipped rather than adding test documents to someone's session.
    - Never stops or kills a PowerPoint process. The author-session check attaches to PowerPoint and quits it
      through harness/ppt/DeckbackCom.psm1 (Connect-/Disconnect-DeckbackPowerPoint), the only file that creates a
      PowerPoint COM object. The script's temp copies are the module's: %TEMP%\deckback-com-<id>.pptx.
#>
param([int]$TimeoutSec = 300)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $PSScriptRoot 'm0_7_make_deck.ps1'
$modulePath = Join-Path $root 'harness\ppt\DeckbackCom.psm1'
$orig = Join-Path $root 'corpus\private\probe\original.pptx'
if (-not (Test-Path -LiteralPath $orig -PathType Leaf)) {
    Write-Output 'SKIP local fixture missing: original.pptx'
    exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'harness\.venv\Scripts\python.exe'))) {
    Write-Output 'SKIP the harness venv is missing (see harness/README.md)'
    exit 0
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('deckback-deck51-test-{0}' -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$failures = New-Object System.Collections.Generic.List[string]

function Check([string]$Name, [bool]$Condition) {
    Write-Output ('{0,-60} {1}' -f $Name, $(if ($Condition) { 'ok' } else { 'FAIL' }))
    if (-not $Condition) { $failures.Add($Name) }
}

# Runs a script in its own powershell process; returns exit code and what it wrote to stderr.
function Invoke-Script([string]$File, [string[]]$ScriptArgs) {
    $outFile = [IO.Path]::GetTempFileName()
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $File))
        foreach ($a in $ScriptArgs) { if ($a.StartsWith('-')) { $argList += $a } else { $argList += ('"{0}"' -f $a) } }
        $p = Start-Process -FilePath powershell.exe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        [pscustomobject]@{ Code = $p.ExitCode; Err = [string](Get-Content -Raw -LiteralPath $errFile) }
    }
    finally { Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue }
}

# Runs a script with its stdout and stderr on pipes and reads both to the end, as a caller such as Python's subprocess
# with capture_output does. Returns once the script has exited and nothing holds those pipes any more, or after
# $LimitSec (then Done is false; nothing is stopped).
function Invoke-ScriptPiped([string]$File, [string[]]$ScriptArgs, [int]$LimitSec) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $File))
    foreach ($a in $ScriptArgs) { if ($a.StartsWith('-')) { $argList += $a } else { $argList += ('"{0}"' -f $a) } }
    $psi = New-Object Diagnostics.ProcessStartInfo 'powershell.exe'
    $psi.Arguments = $argList -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    $drained = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($out, $err), $LimitSec * 1000)
    $exited = $p.WaitForExit(1000)
    $code = $null
    if ($exited) { $code = $p.ExitCode }
    $errText = ''
    if ($drained) { $errText = $err.Result }
    [pscustomobject]@{ Done = ($drained -and $exited); Code = $code; Err = $errText; Seconds = $clock.Elapsed.TotalSeconds }
}

function Get-Hash([string]$Path) { (Get-FileHash -LiteralPath $Path).Hash }
function Get-PowerPointPids { @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
# The module's temp copies of the input (the script never opens the input itself).
function Get-TempCopyCount { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'deckback-com-*.pptx' -ErrorAction SilentlyContinue).Count }

try {
    $pidsAtStart = Get-PowerPointPids

    # 1. -OutPdf is the input file. 2. -OutPdf is not a .pdf path. Both exit 3 before anything is deleted.
    $same = Join-Path $work 'same.pdf'
    Set-Content -LiteralPath $same -Value 'a file that is both input and output'
    $hash = Get-Hash $same
    $r = Invoke-Script $script @('-Pptx', $same, '-OutPdf', $same)
    Check '-OutPdf equal to -Pptx: exit 3' ($r.Code -eq 3)
    Check '-OutPdf equal to -Pptx: names the input file' ($r.Err -match 'is the input file')
    Check '-OutPdf equal to -Pptx: the file is still there, unchanged' ((Test-Path -LiteralPath $same) -and (Get-Hash $same) -eq $hash)

    $copy = Join-Path $work 'input.pptx'
    Copy-Item -LiteralPath $orig -Destination $copy
    $hash = Get-Hash $copy
    $r = Invoke-Script $script @('-Pptx', $copy, '-OutPdf', $copy)
    Check '-OutPdf ending in .pptx: exit 3' ($r.Code -eq 3)
    Check '-OutPdf ending in .pptx: says it must be .pdf' ($r.Err -match 'must end in \.pdf')
    Check '-OutPdf ending in .pptx: the file is still there, unchanged' ((Test-Path -LiteralPath $copy) -and (Get-Hash $copy) -eq $hash)
    $notes = Join-Path $work 'notes.txt'
    Set-Content -LiteralPath $notes -Value 'keep me'
    $hash = Get-Hash $notes
    $r = Invoke-Script $script @('-Pptx', $copy, '-OutPdf', $notes)
    Check '-OutPdf ending in .txt: exit 3, the file is unchanged' ($r.Code -eq 3 -and (Get-Hash $notes) -eq $hash)
    Check 'the validation cases did not start PowerPoint' ((Get-PowerPointPids).Count -eq $pidsAtStart.Count)

    # 3. Timeout hook: exit 2, no PDF, no temp copy.
    $outDir = Join-Path $work 'out'
    New-Item -ItemType Directory -Path $outDir | Out-Null
    $copies = Get-TempCopyCount
    $r = Invoke-Script $script @('-Pptx', $orig, '-OutPdf', (Join-Path $outDir 'late.pdf'), '-TimeoutSec', '3', '-TestHangSec', '30')
    Check 'timeout: exit 2' ($r.Code -eq 2)
    Check 'timeout: no PDF and no temp copy left' (-not (Test-Path -LiteralPath (Join-Path $outDir 'late.pdf')) -and (Get-TempCopyCount) -eq $copies)
    $pidsBlock = Get-PowerPointPids
    $r = Invoke-ScriptPiped $script @('-Pptx', $orig, '-OutPdf', (Join-Path $outDir 'blocked.pdf'), '-TimeoutSec', '3', '-TestBlockSec', '60') 30
    Check "blocked job: exit 2, output closed within 30 s ($([int]$r.Seconds) s)" ($r.Done -and $r.Code -eq 2)
    Check 'blocked job: stderr says the job did not stop' ($r.Err -match 'did not stop')
    Check 'blocked job: no PDF, no temp copy, same POWERPNT processes' (-not (Test-Path -LiteralPath (Join-Path $outDir 'blocked.pdf')) -and (Get-TempCopyCount) -eq $copies -and ((Get-PowerPointPids) -join ',') -eq ($pidsBlock -join ','))

    # 4. Exit 4 after the PDF was written: no venv in a scratch tree. The PDF goes, a neighbour stays.
    $tree = Join-Path $work 'tree'
    New-Item -ItemType Directory -Path (Join-Path $tree 'harness\spikes') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tree 'harness\ppt') | Out-Null
    $scratchScript = Join-Path $tree 'harness\spikes\m0_7_make_deck.ps1'
    Copy-Item -LiteralPath $script -Destination $scratchScript
    Copy-Item -LiteralPath $modulePath -Destination (Join-Path $tree 'harness\ppt\DeckbackCom.psm1')
    $neighbour = Join-Path $outDir 'other.pdf'
    Set-Content -LiteralPath $neighbour -Value 'someone else'
    $hash = Get-Hash $neighbour
    $pdf = Join-Path $outDir 'deck.pdf'
    $copies = Get-TempCopyCount
    $r = Invoke-Script $scratchScript @('-Pptx', $orig, '-OutPdf', $pdf)
    Check 'PDF written, verification impossible: exit 4' ($r.Code -eq 4)
    Check 'exit 4: the output PDF is deleted' (-not (Test-Path -LiteralPath $pdf))
    Check 'exit 4: a neighbouring file is untouched' ((Test-Path -LiteralPath $neighbour) -and (Get-Hash $neighbour) -eq $hash)
    Check 'exit 4: no temp copy left' ((Get-TempCopyCount) -eq $copies)

    # 5. The author's session. Only in a PowerPoint this test starts itself.
    if ((Get-PowerPointPids).Count -gt 0) {
        Write-Output 'SKIP author-session check: PowerPoint is already running (not adding test documents to it)'
    }
    else {
        $inputFile = Join-Path $work 'author-same-file.pptx'
        Copy-Item -LiteralPath $orig -Destination $inputFile
        $inputHash = Get-Hash $inputFile
        $sessionPdf = Join-Path $work 'session.pdf'
        $copiesBeforeSession = Get-TempCopyCount
        $job = Start-Job -ArgumentList $script, $inputFile, $sessionPdf, $modulePath -ScriptBlock {
            param($Script, $InputFile, $Pdf, $ModulePath)
            $ErrorActionPreference = 'Stop'
            Import-Module -Name $ModulePath
            $session = $null; $app = $null; $untitled = $null; $same = $null; $slide = $null; $first = $null
            $checks = New-Object System.Collections.Generic.List[object]
            try {
                # Ours only if it is the single new process and COM activation started it (-Embedding); decided by
                # process id in Connect-DeckbackPowerPoint. No PowerPoint was running when this part started.
                $session = Connect-DeckbackPowerPoint -WasRunning $false
                $app = $session.app
                $mine = @(Get-Process -Name POWERPNT | ForEach-Object { $_.Id })
                # Stand-in 1: an untitled, unsaved presentation with text.
                $untitled = $app.Presentations.Add(0)
                $slide = $untitled.Slides.AddSlide(1, $untitled.SlideMaster.CustomLayouts.Item(7))
                $slide.Shapes.AddTextbox(1, 10, 10, 300, 40).TextFrame.TextRange.Text = 'author unsaved work'
                # Stand-in 2: the very file the script is about to use, open, edited and unsaved.
                $same = $app.Presentations.Open($InputFile, 0, 0, 0)
                $first = $same.Slides.Item(1)
                $first.Shapes.AddTextbox(1, 10, 10, 300, 40).TextFrame.TextRange.Text = 'edited, unsaved'
                $shapesBefore = $first.Shapes.Count
                $countBefore = $app.Presentations.Count

                # A job host talks to its parent over its stdin/stdout. A child that inherited them would write into
                # that channel and stall the job, so the child gets its own (empty input, output to files).
                $inFile = [IO.Path]::GetTempFileName()
                $outFile = [IO.Path]::GetTempFileName()
                $errFile = [IO.Path]::GetTempFileName()
                try {
                    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $Script), '-Pptx', ('"{0}"' -f $InputFile), '-OutPdf', ('"{0}"' -f $Pdf))
                    $p = Start-Process -FilePath powershell.exe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
                        -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
                }
                finally { Remove-Item -LiteralPath $inFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue }
                $now = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })

                $add = { param($n, $v) $checks.Add([pscustomobject]@{ Name = $n; Ok = [bool]$v }) }
                & $add 'author session: the script exits 0 and writes the PDF' ($p.ExitCode -eq 0 -and (Test-Path -LiteralPath $Pdf))
                & $add 'author session: same PowerPoint process still running' ($now.Count -eq $mine.Count -and ($now -join ',') -eq ($mine -join ','))
                & $add 'author session: presentation count unchanged' ($app.Presentations.Count -eq $countBefore)
                & $add 'author session: untitled stand-in still unsaved, text intact' ($untitled.Saved -eq 0 -and $untitled.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text -eq 'author unsaved work')
                & $add 'author session: same-file presentation still unsaved, edit intact' ($same.Saved -eq 0 -and $same.Slides.Count -eq 3 -and $same.Slides.Item(1).Shapes.Count -eq $shapesBefore)
            }
            finally {
                # Close only what this test opened; quit only the instance this test started (by process id).
                if ($null -ne $same) { try { $same.Saved = -1; $same.Close() } catch { } }
                if ($null -ne $untitled) { try { $untitled.Saved = -1; $untitled.Close() } catch { } }
                # Release every COM reference before the job host exits: a host that dies holding references keeps
                # the PowerPoint it started alive for minutes (DCOM waits for the dead client to time out).
                foreach ($o in @($first, $slide, $same, $untitled)) { if ($null -ne $o) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } }
                $first = $null; $slide = $null; $same = $null; $untitled = $null; $app = $null
                # Quits only the instance this test started (by process id) with nothing open in it, releases the
                # application and runs two GC rounds.
                [void](Disconnect-DeckbackPowerPoint -Session $session)
            }
            $checks
        }
        if ($null -eq (Wait-Job -Job $job -Timeout $TimeoutSec)) {
            # Ask our own job to stop (never PowerPoint) so its finally can close what it opened. Stop-Job blocks
            # while a PowerPoint call hangs, so it runs in a background runspace and this waits at most 10 s.
            $stopper = [PowerShell]::Create()
            [void]$stopper.AddCommand('Stop-Job').AddParameter('Job', $job)
            [void]$stopper.BeginInvoke()
            [void](Wait-Job -Job $job -Timeout 10)
            [Console]::Error.WriteLine('test_m0_7_make_deck.ps1: timeout in the author-session check; no PowerPoint process was stopped or killed. Close any untitled presentation and author-same-file.pptx it left in PowerPoint by hand (see harness/README.md).')
            # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
            [Environment]::Exit(2)
        }
        $sessionChecks = @(Receive-Job -Job $job | Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['Ok'] })
        Remove-Job -Job $job -Force
        Check 'author session: the checks ran' ($sessionChecks.Count -eq 5)
        foreach ($c in $sessionChecks) { Check $c.Name $c.Ok }
        Check 'author session: the input file on disk is byte-identical' ((Get-Hash $inputFile) -eq $inputHash)
        Check 'author session: no temp copy left' ((Get-TempCopyCount) -eq $copiesBeforeSession)
    }
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -eq 0) {
    Write-Output 'DECK SCRIPT TESTS OK'
    exit 0
}
Write-Output "DECK SCRIPT TESTS FAILED: $($failures -join '; ')"
exit 1
