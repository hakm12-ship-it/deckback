<#
.SYNOPSIS
  Safety test: running render.ps1 must not disturb the author's own PowerPoint session, because
  the author may be working in PowerPoint while a render runs.

.DESCRIPTION
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test_render_safety.ps1 [-TimeoutSec 300]
  Prints SAFETY OK and exits 0 when everything holds. Exit codes: 0 ok, 1 failed, 2 timeout.

  Steps:
    - Builds a small pptx with harness/spikes/pptx_xml.py and checks render.ps1's exit codes that
      do not need PowerPoint (3 = file not found, 2 = timeout, 5 = PowerPoint busy: a refusal the
      -TestBusy hook raises before PowerPoint is touched, ruling M1-R74). The timeout is checked twice: with a
      hang that stopping the job can interrupt, and with one it cannot (-TestBlockSec, as in a
      PowerPoint call blocked by a dialog). In the second case render.ps1 must still exit 2 within
      30 s, read the way Python's capture_output reads it: to the end of its output pipes, which a
      job host left behind must not hold.
    - Notes whether PowerPoint is already running. If it is not, first checks that render.ps1
      starts and quits its own instance without leaving a process behind.
    - Attaches to (or starts) PowerPoint and adds one untitled presentation as a stand-in for the
      author's unsaved work. Runs render.ps1. Asserts that the stand-in is still open and
      unsaved, the window and presentation counts did not change, POWERPNT is still running,
      stale slide PNGs were cleared and no temp copy was left behind.
    - Same-file case: opens the very file render.ps1 is about to render as an author-style,
      edited, unsaved presentation. Runs render.ps1 on it. That presentation must stay open and
      unchanged (still unsaved, same content, file on disk untouched).
    - Closes only what this test opened, without saving. Never stops or kills a PowerPoint process
      and never calls Quit() itself. When this test started PowerPoint, its stand-in windows made
      that instance visible, so Disconnect leaves it running (ruling M1-R73); the test then opens its
      own deck in Protected View in that instance, releases the application and closes that window,
      after which the instance ends by itself (measured on PowerPoint 16), and checks it is gone.
  All COM work runs in a Start-Job under a timeout. The test attaches to PowerPoint and quits it
  through harness/ppt/DeckbackCom.psm1 (Connect-/Disconnect-DeckbackPowerPoint), the only file that
  creates a PowerPoint COM object.
#>
param([int]$TimeoutSec = 300)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$python = Join-Path $root 'harness\.venv\Scripts\python.exe'
$render = Join-Path $PSScriptRoot 'render.ps1'
$modulePath = Join-Path $PSScriptRoot 'DeckbackCom.psm1'
$work = Join-Path $root 'out\m0\render-safety'
$pptx = Join-Path $work 'safety.pptx'
New-Item -ItemType Directory -Force -Path $work | Out-Null

# Runs render.ps1 in its own process; returns exit code and captured output. It also runs inside the
# job below, where a child must not inherit the job host's stdin/stdout, so all three are redirected.
$helper = @'
function Invoke-Render([string]$Render, [string[]]$RenderArgs) {
    $inFile = [IO.Path]::GetTempFileName()
    $outFile = [IO.Path]::GetTempFileName()
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $Render))
        foreach ($a in $RenderArgs) { if ($a.StartsWith('-')) { $argList += $a } else { $argList += ('"{0}"' -f $a) } }
        $p = Start-Process -FilePath powershell.exe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
            -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        [pscustomobject]@{
            Code = $p.ExitCode
            Out  = [string](Get-Content -Raw -LiteralPath $outFile)
            Err  = [string](Get-Content -Raw -LiteralPath $errFile)
        }
    }
    finally { Remove-Item -LiteralPath $inFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue }
}
'@
Invoke-Expression $helper

function Stop-Failed([string]$Message) {
    Write-Output "SAFETY FAIL: $Message"
    exit 1
}

# Runs render.ps1 with its stdout and stderr on pipes and reads both to the end, as a caller such as Python's
# subprocess with capture_output does. Returns once render.ps1 has exited and nothing holds those pipes any more, or
# after $LimitSec (then Done is false; nothing is stopped).
function Invoke-RenderPiped([string[]]$RenderArgs, [int]$LimitSec) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $render))
    foreach ($a in $RenderArgs) { if ($a.StartsWith('-')) { $argList += $a } else { $argList += ('"{0}"' -f $a) } }
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

# 1. A pptx made by pptx_xml.py: a custGeom with two overlapping subpaths and a gradient fill.
$py = "import sys; sys.path.insert(0, sys.argv[1]); from pptx import Presentation; from pptx.util import Emu; " +
      "import pptx_xml; prs = Presentation(); prs.slide_width = Emu(960*12700); prs.slide_height = Emu(540*12700); " +
      "s = prs.slides.add_slide(prs.slide_layouts[6]); " +
      "sh = pptx_xml.add_custgeom(s, [[(100,100),(300,100),(300,300),(100,300)],[(200,200),(400,200),(400,400),(200,400)]], '1F4E79'); " +
      "pptx_xml.add_gradfill(sh, [(0,'1F4E79'),(1,'FFFFFF')], 45); prs.save(sys.argv[2])"
& $python -I -c $py (Join-Path $root 'harness\spikes') $pptx
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pptx)) { Stop-Failed 'could not build the test pptx' }

# 2. Exit codes that never touch PowerPoint.
$r = Invoke-Render $render @('-Pptx', (Join-Path $work 'does-not-exist.pptx'), '-OutDir', (Join-Path $work 'x'))
if ($r.Code -ne 3) { Stop-Failed "missing file: expected exit 3, got $($r.Code)" }
$r = Invoke-Render $render @('-Pptx', $pptx, '-OutDir', (Join-Path $work 'x'), '-TestBusy')
if ($r.Code -ne 5) { Stop-Failed "PowerPoint busy: expected exit 5, got $($r.Code): $($r.Err)" }
if ($r.Err -notmatch 'busy') { Stop-Failed "PowerPoint busy: stderr does not say PowerPoint is busy: $($r.Err)" }
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-Render $render @('-Pptx', $pptx, '-OutDir', (Join-Path $work 'x'), '-TimeoutSec', '2', '-TestHangSec', '60')
if ($r.Code -ne 2) { Stop-Failed "timeout: expected exit 2, got $($r.Code): $($r.Err)" }
if ($clock.Elapsed.TotalSeconds -gt 30) { Stop-Failed "timeout path took $([int]$clock.Elapsed.TotalSeconds) s" }
$pidsBlock = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$r = Invoke-RenderPiped @('-Pptx', $pptx, '-OutDir', (Join-Path $work 'x'), '-TimeoutSec', '2', '-TestBlockSec', '60') 30
if (-not $r.Done) { Stop-Failed "blocked job: render.ps1 or a process it left behind still held its output after $([int]$r.Seconds) s (nothing was stopped)" }
if ($r.Code -ne 2) { Stop-Failed "blocked job: expected exit 2, got $($r.Code): $($r.Err)" }
if ($r.Err -notmatch 'did not stop') { Stop-Failed "blocked job: stderr does not say the job did not stop: $($r.Err)" }
$pidsNow = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (($pidsNow -join ',') -ne ($pidsBlock -join ',')) { Stop-Failed 'blocked job: the POWERPNT processes changed' }
Write-Output "exit codes: 3 (file not found), 5 (PowerPoint busy), 2 (timeout) and 2 with a job that cannot be stopped (output closed after $([int]$r.Seconds) s) ok"

# 3. The author's session.
$wasRunning = [bool](Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
Write-Output "PowerPoint already running before the test: $wasRunning"

$job = Start-Job -ArgumentList $render, $pptx, $work, $wasRunning, $helper, $modulePath -ScriptBlock {
    param($Render, $Pptx, $Work, $WasRunning, $Helper, $ModulePath)
    $ErrorActionPreference = 'Stop'
    Invoke-Expression $Helper
    Import-Module -Name $ModulePath
    $log = New-Object System.Collections.Generic.List[string]
    $state = @{ failed = 0 }
    function Check([bool]$Ok, [string]$Message) {
        if ($Ok) { $log.Add("  ok: $Message") } else { $log.Add("  FAIL: $Message"); $state.failed++ }
    }
    function Test-Png([string]$Path) {
        if (-not (Test-Path -LiteralPath $Path)) { return $false }
        $b = [IO.File]::ReadAllBytes($Path)
        return ($b.Length -gt 100 -and $b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47)
    }
    function Get-PowerPointPids {
        @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    }
    function Wait-NoPowerPoint([int]$Seconds) {
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-PowerPointPids).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        return (Get-PowerPointPids).Count -eq 0
    }
    function Wait-PidGone([int]$TargetPid, [int]$Seconds) {
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        return -not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)
    }
    # Drop gives back one reference. Use it for objects fetched again from a collection: COM hands out
    # the same runtime wrapper for the same object, so a final release would also kill the wrapper
    # held in a variable such as $stand.
    function Drop($o) { if ($null -ne $o) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }
    function Release($o) { if ($null -ne $o) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } }
    function Get-WindowCount($application) {
        $w = $application.Windows
        try { return $w.Count } finally { Drop $w }
    }
    # True if a presentation whose file name (leaf of FullName; untitled ones have no path) is $Leaf is open.
    function Test-PresentationOpen($List, [string]$Leaf) {
        for ($k = 1; $k -le $List.Count; $k++) {
            $p = $List.Item($k)
            try { if ([IO.Path]::GetFileName($p.FullName) -ieq $Leaf) { return $true } } finally { Drop $p }
        }
        return $false
    }
    function Get-TempCopies { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'deckback-com-*.pptx' -ErrorAction SilentlyContinue) }
    # Ends a PowerPoint this test started and made visible, which Disconnect leaves running (M1-R73), without Quit(): the
    # deck opens in Protected View in it, the application is released, and that window is closed. Measured on PowerPoint
    # 16 (2026-11-05): an instance whose last window, a Protected View window, closes while nothing holds it ends by
    # itself. Only when that process is the only POWERPNT process. Returns $true once it is gone.
    function Close-OwnVisibleInstance([int]$TargetPid, [string]$DeckPath) {
        if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) { return $true }
        $now = @(Get-PowerPointPids)
        if ($now.Count -ne 1 -or $now[0] -ne $TargetPid) { $log.Add("  not ending process $TargetPid by hand: POWERPNT processes $($now -join ',')"); return $false }
        $attach = Connect-DeckbackPowerPoint -WasRunning $true
        $pvList = $null; $pv = $null
        try {
            $pvList = $attach.app.ProtectedViewWindows
            $pv = $pvList.Open($DeckPath)
        }
        finally {
            Drop $pvList; $pvList = $null
            [void](Disconnect-DeckbackPowerPoint -Session $attach)
        }
        try { $pv.Close() }
        finally {
            Release $pv; $pv = $null
            [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        }
        return (Wait-PidGone $TargetPid 30)
    }

    $session = $null; $app = $null; $presList = $null; $stand = $null; $slides = $null; $slide = $null; $shapes = $null
    $authorDoc = $null; $authorSlides = $null; $authorSlide = $null; $authorShapes = $null
    $standName = $null; $ownedPid = $null; $initialCount = $null
    $sameFile = Join-Path $Work 'same-file.pptx'
    $sameHash = $null
    try {
        # 3a. PowerPoint not running: render.ps1 starts its own instance and must clean it up.
        if (-not $WasRunning) {
            $r = Invoke-Render $Render @('-Pptx', $Pptx, '-OutDir', (Join-Path $Work 'phase-own'))
            Check ($r.Code -eq 0) "own instance: render.ps1 exit 0 (got $($r.Code)) $($r.Err)"
            Check (Test-Png (Join-Path $Work 'phase-own\slide1.png')) 'own instance: slide1.png written'
            $gone = Wait-NoPowerPoint 20
            Check $gone 'own instance: render.ps1 quit the PowerPoint it started (no POWERPNT left)'
            if (-not $gone) { throw 'a PowerPoint started by render.ps1 is still running; stopping (it is not killed)' }
        }

        # 3b. Attach. Ownership of the instance is decided by process id (Connect-DeckbackPowerPoint): a new
        # POWERPNT process, launched by COM activation, with no PowerPoint at all before. Anything else is not
        # ours to quit.
        $session = Connect-DeckbackPowerPoint -WasRunning $WasRunning
        $app = $session.app
        $ownedPid = $session.ownedPid
        if (-not $WasRunning) { Check ($null -ne $ownedPid) 'this test started PowerPoint and proved it by process id' }

        # The stand-in for the author's unsaved work.
        $presList = $app.Presentations
        $initialCount = $presList.Count
        $stand = $presList.Add(-1)            # msoTrue: with a window, untitled, never saved
        $standName = $stand.Name
        $slides = $stand.Slides
        $slide = $slides.Add(1, 12)           # ppLayoutBlank
        $shapes = $slide.Shapes
        $note = $shapes.AddTextbox(1, 50, 50, 400, 60)
        $note.TextFrame.TextRange.Text = 'unsaved work (render safety stand-in)'
        Release $note
        $countBefore = $presList.Count
        $windowsBefore = Get-WindowCount $app
        $shapesBefore = $shapes.Count
        $pidsBefore = Get-PowerPointPids
        $log.Add("stand-in '$standName' open; presentations=$countBefore windows=$windowsBefore POWERPNT pids=$($pidsBefore -join ',')")
        Check ($stand.Saved -eq 0) 'stand-in starts unsaved'

        # 3c. Render while the stand-in is open. Plant stale output first.
        $attachedDir = Join-Path $Work 'phase-attached'
        New-Item -ItemType Directory -Force -Path $attachedDir | Out-Null
        Set-Content -LiteralPath (Join-Path $attachedDir 'slide2.png') -Value 'stale'
        Set-Content -LiteralPath (Join-Path $attachedDir 'slide9.png') -Value 'stale'
        Set-Content -LiteralPath (Join-Path $attachedDir 'keep-me.txt') -Value 'not a slide'
        $copiesBefore = (Get-TempCopies).Count
        $r = Invoke-Render $Render @('-Pptx', $Pptx, '-OutDir', $attachedDir)
        Check ($r.Code -eq 0) "attached: render.ps1 exit 0 (got $($r.Code)) $($r.Err)"
        Check (Test-Png (Join-Path $attachedDir 'slide1.png')) 'attached: slide1.png written'
        Check (-not (Test-Path -LiteralPath (Join-Path $attachedDir 'slide2.png'))) 'attached: stale slide2.png cleared'
        Check (-not (Test-Path -LiteralPath (Join-Path $attachedDir 'slide9.png'))) 'attached: stale slide9.png cleared'
        Check (Test-Path -LiteralPath (Join-Path $attachedDir 'keep-me.txt')) 'attached: files that are not slide PNGs are kept'
        Check ((Get-TempCopies).Count -eq $copiesBefore) 'attached: no temp copy left behind'

        # 3d. Nothing of the author's session changed.
        Check (Test-PresentationOpen $presList $standName) "stand-in '$standName' is still open"
        Check ($stand.Saved -eq 0) 'stand-in is still unsaved (nothing was saved over it)'
        Check ($shapes.Count -eq $shapesBefore) 'stand-in content unchanged'
        Check ($presList.Count -eq $countBefore) "presentation count unchanged ($countBefore)"
        Check ((Get-WindowCount $app) -eq $windowsBefore) "window count unchanged ($windowsBefore)"
        $pidsAfter = Get-PowerPointPids
        Check ($pidsAfter.Count -gt 0) 'POWERPNT process still exists'
        Check (@($pidsBefore | Where-Object { $pidsAfter -notcontains $_ }).Count -eq 0) 'the same POWERPNT process survived'

        # 3e. Same-file case: the author has the very file that gets rendered open, edited, unsaved.
        Copy-Item -LiteralPath $Pptx -Destination $sameFile -Force
        $sameHash = (Get-FileHash -LiteralPath $sameFile).Hash
        $authorDoc = $presList.Open($sameFile, 0, 0, -1)     # read/write, with a window: like the author
        $authorSlides = $authorDoc.Slides
        $authorSlide = $authorSlides.Item(1)
        $authorShapes = $authorSlide.Shapes
        $edit = $authorShapes.AddTextbox(1, 50, 50, 300, 40)
        $edit.TextFrame.TextRange.Text = 'author edit (unsaved)'
        Release $edit
        $authorShapesBefore = $authorShapes.Count
        $countBefore2 = $presList.Count
        $windowsBefore2 = Get-WindowCount $app
        Check ($authorDoc.Saved -eq 0) 'same-file: the author copy of the render input is open and edited'
        $copiesBefore = (Get-TempCopies).Count
        $r = Invoke-Render $Render @('-Pptx', $sameFile, '-OutDir', (Join-Path $Work 'phase-samefile'))
        Check ($r.Code -eq 0) "same-file: render.ps1 exit 0 (got $($r.Code)) $($r.Err)"
        Check (Test-Png (Join-Path $Work 'phase-samefile\slide1.png')) 'same-file: slide1.png written'
        Check (Test-PresentationOpen $presList 'same-file.pptx') 'same-file: the author presentation is still open'
        Check ($authorDoc.Saved -eq 0) 'same-file: the author presentation is still unsaved'
        Check ($authorShapes.Count -eq $authorShapesBefore) 'same-file: the author presentation content is unchanged'
        Check ($presList.Count -eq $countBefore2) "same-file: presentation count unchanged ($countBefore2)"
        Check ((Get-WindowCount $app) -eq $windowsBefore2) "same-file: window count unchanged ($windowsBefore2)"
        Check ((Get-FileHash -LiteralPath $sameFile).Hash -eq $sameHash) 'same-file: the file on disk is unchanged'
        Check ((Get-TempCopies).Count -eq $copiesBefore) 'same-file: no temp copy left behind'
    }
    catch {
        $log.Add("  FAIL: $($_.Exception.Message)")
        $state.failed++
    }
    finally {
        # Close only what this test opened, without saving. Quit only an instance this test started.
        if ($null -ne $authorDoc) {
            try { $authorDoc.Saved = -1; $authorDoc.Close(); $log.Add('closed only the same-file presentation this test opened (not saved)') }
            catch { $log.Add("  FAIL: could not close the same-file presentation: $($_.Exception.Message)"); $state.failed++ }
            if ($null -ne $sameHash) {
                Check ((Get-FileHash -LiteralPath $sameFile).Hash -eq $sameHash) 'same-file: the file on disk is still unchanged after closing without saving'
            }
        }
        if ($null -ne $stand) {
            try { $stand.Saved = -1; $stand.Close(); $log.Add("closed only the stand-in '$standName' (not saved)") }
            catch { $log.Add("  FAIL: could not close the stand-in: $($_.Exception.Message)"); $state.failed++ }
        }
        if ($null -ne $presList -and $null -ne $stand) {
            try { Check ($presList.Count -eq $initialCount) "presentation count back to $initialCount" } catch { }
        }
        Release $authorShapes; Release $authorSlide; Release $authorSlides; Release $authorDoc
        Release $shapes; Release $slide; Release $slides; Release $stand; Release $presList
        $authorShapes = $null; $authorSlide = $null; $authorSlides = $null; $authorDoc = $null
        $shapes = $null; $slide = $null; $slides = $null; $stand = $null; $presList = $null; $app = $null
        # Releases the session. The stand-in's window made an instance this test started visible, so Disconnect leaves
        # it running (M1-R73) and the test ends it through a Protected View window of its own deck.
        $quit = Disconnect-DeckbackPowerPoint -Session $session
        if ($null -ne $ownedPid) {
            Check (-not $quit -and "$($session.leftRunning)" -match 'Visible') "Disconnect left this test's own PowerPoint running, visible after its stand-in window ($($session.leftRunning))"
            Check (Close-OwnVisibleInstance $ownedPid $Pptx) "the PowerPoint process this test started ($ownedPid) is gone"
        }
    }
    [pscustomobject]@{ Log = $log.ToArray(); Failed = $state.failed }
}

if ($null -eq (Wait-Job -Job $job -Timeout $TimeoutSec)) {
    # Ask our own job to stop (never PowerPoint) so its finally can close what it opened. Stop-Job blocks while a
    # PowerPoint call hangs, so it runs in a background runspace and this waits at most 10 s.
    $stopper = [PowerShell]::Create()
    [void]$stopper.AddCommand('Stop-Job').AddParameter('Job', $job)
    [void]$stopper.BeginInvoke()
    [void](Wait-Job -Job $job -Timeout 10)
    Write-Output "SAFETY TIMEOUT: no answer within $TimeoutSec s. No PowerPoint process was killed; untitled and same-file.pptx presentations opened by this test may still be open in PowerPoint (close them by hand, without saving; see harness/README.md)."
    # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
    [Console]::Out.Flush()
    [Environment]::Exit(2)
}
$result = @(Receive-Job -Job $job -ErrorAction SilentlyContinue) |
    Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['Failed'] } | Select-Object -Last 1
Remove-Job -Job $job -Force
if ($null -eq $result) { Stop-Failed 'the test job returned no result' }
$result.Log | ForEach-Object { Write-Output $_ }
if ($result.Failed -ne 0) { Stop-Failed "$($result.Failed) check(s) failed" }
Write-Output 'SAFETY OK'
exit 0
