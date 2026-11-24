<#
.SYNOPSIS
  Author the parts of the atlas-com deck that only PowerPoint can write (SmartArt, SVG pictures, picture effects)
  with the desktop Microsoft PowerPoint (COM), without a window.

.DESCRIPTION
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File author_com.ps1 -Pptx <base.pptx> -Plan <plan.json>
        -Assets <dir> -Out <authored.pptx> [-TimeoutSec <s>]

  harness/atlas/com_deck.py builds <base.pptx> with python-pptx (titles, captions, labels), writes <plan.json> (per slide:
  what to add, where) and the generated assets (SVG files, a JPEG) into <dir>, and runs this script. One PowerPoint run
  (Invoke-DeckbackPowerPoint, on a GUID-named temp copy of <base.pptx>, read-only, no window) adds to each slide
  of the plan:
    smartArt         Shapes.AddSmartArt with the layout of the plan (Application.SmartArtLayouts), the node texts set
                     in the deck's body font (latin, ea and cs)
    svgIcon          Shapes.AddPicture of an .svg file (PowerPoint keeps the SVG and writes a PNG fallback)
    artisticEffects  Shapes.AddPicture of a JPEG twice (the original, and one with Fill.PictureEffects.Insert)
  then brings the slide's label to the front and writes the result with SaveCopyAs to <authored.pptx>.

  A COM call that fails does not fail the run: the slide it belongs to is deleted from the copy before the copy is saved
  and recorded with its reason, which com_deck.py puts in the manifest's `excluded`. The run stays windowless: nothing
  here shows PowerPoint or opens a window, so a call that cannot work without one is recorded, not worked around. The one
  exception is PowerPoint refusing a call because it is busy (RPC_E_CALL_REJECTED, RPC_E_SERVERCALL_RETRYLATER: a dialog
  is open in it, possibly the author's): that is no fault of the slide (ruling M1-R74), so the whole run fails as
  powerpoint-busy (exit code 3, nothing written) and no slide is recorded as failed. This holds for every call the action
  makes, at any slide: method calls throw, and every property read and write goes through InvokeMember (Get-ComProperty,
  Set-ComProperty) because PowerShell's COM adapter can turn a failing read into $null without an error. Open: calls the
  module makes itself (opening and closing the copy, its checks before it quits an instance) are outside this script and
  follow the module's own rules.

  The last line of stdout is one ASCII JSON line:
    {"ok":bool,"exitCode":int,"seconds":n[,"reason":s][,"stuck":true][,"slideCount":n,"slides":[{"id":s,"ok":bool[,"reason":s]}]]}
  exitCode is 0 (the authored copy was written; look at slides[].ok), 2 (a timeout: possible repair or modal dialog), or 3
  (bad arguments, or the run failed otherwise: nothing is written). reason, when not ok, is one of: timeout,
  powerpoint-busy (PowerPoint refused a call because it was busy, as while a dialog is open in it, also in the middle of the
  run: ruling M1-R74), error,
  slide-count-mismatch (PowerPoint saw another number of slides than the plan has), no-output. Error text (which may contain
  paths) goes to stderr only, as do the progress lines.

  If a run comes back stuck (a PowerPoint call is blocked, for example by a dialog) the JSON line is written and the process
  ends with [Environment]::Exit, since a normal exit would wait for the blocked job (ruling M1-R19).

  This script runs on a PC where the author may have PowerPoint open with unsaved work. It drives PowerPoint only through
  harness/ppt/DeckbackCom.psm1: a GUID-named temp copy is opened (never the input file), closing and quitting follow the
  module's rules, and no process is ever stopped or ended. See harness/README.md.
#>
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$Plan,
    [Parameter(Mandatory = $true)][string]$Assets,
    [Parameter(Mandatory = $true)][string]$Out,
    # Default: 120 s + 4 s per slide (Get-DeckbackTimeout).
    [int]$TimeoutSec,
    # Test hooks only, as in export.ps1: the run waits before touching PowerPoint (-TestHangSec: a wait that stopping the job
    # interrupts; -TestBlockSec: one it cannot, like a call blocked by a dialog), or fails with PowerPoint's busy refusal
    # (-TestBusy).
    [double]$TestHangSec = 0,
    [double]$TestBlockSec = 0,
    [switch]$TestBusy,
    # Test hook only: the action raises PowerPoint's busy refusal (RPC_E_CALL_REJECTED) while it authors this slide (1-based;
    # 0 = off), a refusal in the middle of the run.
    [int]$TestBusyAtSlide = 0,
    # Test hook only: the action raises that refusal when it reads this PowerPoint property (Shapes, Fill, Count, ...);
    # with -TestBusyAtSlide, only while that slide is authored. Without it -TestBusyAtSlide raises it as the slide starts.
    [string]$TestBusyOnRead = ''
)
$ErrorActionPreference = 'Stop'

function Write-Err([string]$Message) { [Console]::Error.WriteLine("author_com.ps1: $Message") }

function Resolve-FullPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

# JSON with every non-ASCII character as \uXXXX, so that the line reads the same in any console code page.
function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Depth 6 -Compress
    [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Write-Result($Record, [int]$Code, [bool]$Stuck) {
    [Console]::Out.WriteLine((ConvertTo-AsciiJson $Record))
    [Console]::Out.Flush()
    # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
    if ($Stuck) { [Environment]::Exit($Code) }
    exit $Code
}

function Stop-WithError([int]$Code, [string]$Message) {
    Write-Err $Message
    # Bad arguments: nothing was written and PowerPoint was not touched.
    exit $Code
}

try { Import-Module -Name (Join-Path $PSScriptRoot '..\ppt\DeckbackCom.psm1') -Force }
catch { Stop-WithError 3 "cannot load harness/ppt/DeckbackCom.psm1: $($_.Exception.Message)" }

# ---- Arguments: all checked before anything is written or PowerPoint is touched ---------------------------------
$pptxPath = Resolve-FullPath $Pptx
$planPath = Resolve-FullPath $Plan
$assetsPath = Resolve-FullPath $Assets
$outPath = Resolve-FullPath $Out
if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) { Stop-WithError 3 "file not found: $pptxPath" }
if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) { Stop-WithError 3 "file not found: $planPath" }
if (-not (Test-Path -LiteralPath $assetsPath -PathType Container)) { Stop-WithError 3 "directory not found: $assetsPath" }
if ($outPath -notmatch '\.pptx$') { Stop-WithError 3 'the output must be a .pptx file' }
if ($outPath -ieq $pptxPath) { Stop-WithError 3 'the output must not be the input deck' }
$planText = [IO.File]::ReadAllText($planPath, (New-Object Text.UTF8Encoding($false)))
try {
    $planData = $planText | ConvertFrom-Json
    if ($null -eq $planData.slides -and $null -eq $planData.slideCount) { throw 'no slides' }
}
catch { Stop-WithError 3 "the plan is not usable: $($_.Exception.Message)" }
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
    # An old result is removed first, so a failed run never leaves one that looks like this run's.
    if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }
}
catch { Stop-WithError 3 "cannot prepare the output location: $($_.Exception.Message)" }

# ---- What runs inside the module's job (against the opened temp copy) --------------------------------------------
# $args: the plan (JSON text), the assets directory, the output path, the slide of the test hook (0 = off). Returns one JSON
# text: the slide count PowerPoint sees and one record per plan slide. The text may not mention the names DeckbackCom.psm1
# forbids in an action.
$authorAction = @'
param($pres, $app, $args)
$plan = [string]$args[0] | ConvertFrom-Json
$assets = [string]$args[1]
$target = [string]$args[2]
$busyAtSlide = [int]$args[3]
$busyOnRead = [string]$args[4]
$currentSlide = 0

function Remove-ComRef($Object) {
    if ($null -ne $Object -and [Runtime.InteropServices.Marshal]::IsComObject($Object)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)
    }
}

# The innermost message of an error, its first line (PowerShell wraps a COM error; the inner text is PowerPoint's own),
# and the HRESULT of a COM error.
function Get-RootReason($Exception) {
    $e = $Exception
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    $text = ([regex]::Split([string]$e.Message, '\r?\n')[0]).Trim()
    if ($e -is [Runtime.InteropServices.COMException]) {
        $text = '{0} (0x{1:X8})' -f $text, [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$e.ErrorCode), 0)
    }
    $text
}

# True if the error, or one it wraps (PowerShell wraps a COM error), is PowerPoint refusing a call because it is busy, as it
# does while a dialog is open in it: RPC_E_CALL_REJECTED (0x80010001) or RPC_E_SERVERCALL_RETRYLATER (0x8001010A), by HRESULT
# or by message. The module has the same test (ruling M1-R74) but keeps it private.
function Test-BusyError($Exception) {
    for ($e = $Exception; $null -ne $e; $e = $e.InnerException) {
        if (@(-2147418111, -2147417846) -contains $e.HResult) { return $true }
        if ("$($e.Message)" -match '0x80010001|0x8001010A|RPC_E_CALL_REJECTED|RPC_E_SERVERCALL_RETRYLATER') { return $true }
    }
    return $false
}

# What PowerPoint says while it is busy, for the test hooks.
function New-BusyRefusal {
    New-Object Runtime.InteropServices.COMException('Call was rejected by callee. (Exception from HRESULT: 0x80010001 (RPC_E_CALL_REJECTED)) [test hook]', -2147418111)
}

# Reads and writes a PowerPoint property through InvokeMember, which throws the COM error. PowerShell's own COM adapter can
# turn a failing property read into $null without any error (the SmartArt layouts error did): that hides why, and hides
# PowerPoint refusing the call because it is busy, which Test-BusyError would then never see (ruling M1-R74). So the action
# reads and writes every property through these two. The comma keeps a collection from being unrolled into its items. The
# test hook raises the busy refusal in Get-ComProperty, so a read that does not go through it is not covered by it.
function Get-ComProperty($Object, [string]$Name) {
    if ($busyOnRead -ne '' -and $busyOnRead -eq $Name -and ($busyAtSlide -eq 0 -or $currentSlide -eq $busyAtSlide)) { throw (New-BusyRefusal) }
    , $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::GetProperty, $null, $Object, $null)
}

function Set-ComProperty($Object, [string]$Name, $Value) {
    [void]$Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::SetProperty, $null, $Object, @($Value))
}

# The SmartArt layout with this id (Application.SmartArtLayouts, which a windowless PowerPoint may not have).
function Get-SmartArtLayout($App, [string]$LayoutId) {
    $layouts = Get-ComProperty $App 'SmartArtLayouts'
    try { $layout = $layouts.Item($LayoutId) }
    finally { Remove-ComRef $layouts }
    if ($null -eq $layout) { throw "no SmartArt layout with the id $LayoutId" }
    , $layout
}

$slideTotal = 0
$slides = Get-ComProperty $pres 'Slides'
try { $slideTotal = [int](Get-ComProperty $slides 'Count') } finally { Remove-ComRef $slides }
if ($slideTotal -ne [int]$plan.slideCount) { throw "slide-count-mismatch: PowerPoint sees $slideTotal slides, the plan has $($plan.slideCount)" }

$results = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[int]
foreach ($item in @($plan.slides)) {
    $currentSlide = [int]$item.slide
    $slides = $null; $slide = $null; $shapes = $null; $shape = $null; $original = $null; $fill = $null; $effects = $null
    $effect = $null; $layout = $null; $smart = $null; $nodes = $null; $node = $null; $frame = $null; $range = $null
    $font = $null; $label = $null
    $step = 'Slides.Item'
    try {
        $slides = Get-ComProperty $pres 'Slides'
        $slide = $slides.Item([int]$item.slide)
        $shapes = Get-ComProperty $slide 'Shapes'
        $boxes = @($item.boxes)
        $box = $boxes[0]
        if ($busyAtSlide -gt 0 -and $busyOnRead -eq '' -and [int]$item.slide -eq $busyAtSlide) {
            $step = 'test hook'
            throw (New-BusyRefusal)
        }
        switch ([string]$item.kind) {
            'svgIcon' {
                $step = 'AddPicture (svg)'
                $shape = $shapes.AddPicture((Join-Path $assets ([string]$item.file)), 0, -1, [single]$box.x, [single]$box.y, [single]$box.w, [single]$box.h)
                Set-ComProperty $shape 'Name' ('COM SVG ' + $item.variant)
            }
            'artisticEffects' {
                # The original on the left, the same picture with the effect on the right.
                $step = 'AddPicture (jpeg)'
                $original = $shapes.AddPicture((Join-Path $assets ([string]$item.file)), 0, -1, [single]$box.x, [single]$box.y, [single]$box.w, [single]$box.h)
                Set-ComProperty $original 'Name' 'COM Picture original'
                $box = $boxes[1]
                $shape = $shapes.AddPicture((Join-Path $assets ([string]$item.file)), 0, -1, [single]$box.x, [single]$box.y, [single]$box.w, [single]$box.h)
                Set-ComProperty $shape 'Name' ('COM Picture ' + $item.variant)
                $step = 'Fill.PictureEffects'
                $fill = Get-ComProperty $shape 'Fill'
                $effects = Get-ComProperty $fill 'PictureEffects'
                $step = 'PictureEffects.Insert'
                $effect = $effects.Insert([int]$item.effect)
            }
            'smartArt' {
                $step = 'SmartArtLayouts'
                $layout = Get-SmartArtLayout $app ([string]$item.layout)
                $step = 'AddSmartArt'
                $shape = $shapes.AddSmartArt($layout, [single]$box.x, [single]$box.y, [single]$box.w, [single]$box.h)
                Set-ComProperty $shape 'Name' ('COM SmartArt ' + $item.variant)
                $step = 'SmartArt.AllNodes'
                $smart = Get-ComProperty $shape 'SmartArt'
                $nodes = Get-ComProperty $smart 'AllNodes'
                $texts = @($item.nodes)
                $count = [math]::Min([int](Get-ComProperty $nodes 'Count'), $texts.Count)
                for ($i = 1; $i -le $count; $i++) {
                    $step = "node $i text"
                    $node = $nodes.Item($i)
                    $frame = Get-ComProperty $node 'TextFrame2'
                    $range = Get-ComProperty $frame 'TextRange'
                    Set-ComProperty $range 'Text' ([string]$texts[$i - 1])
                    $font = Get-ComProperty $range 'Font'
                    # latin, ea and cs name the deck's body font, as every run of the atlas does.
                    Set-ComProperty $font 'Name' ([string]$item.font)
                    Set-ComProperty $font 'NameFarEast' ([string]$item.font)
                    Set-ComProperty $font 'NameComplexScript' ([string]$item.font)
                    foreach ($o in @($font, $range, $frame, $node)) { Remove-ComRef $o }
                    $font = $null; $range = $null; $frame = $null; $node = $null
                }
            }
            default { throw "unknown kind $($item.kind)" }
        }
        # The label stays the last, topmost shape of the slide, as in every atlas deck.
        $step = 'ZOrder'
        $label = $shapes.Item([string]$plan.labelName)
        $label.ZOrder(0)
        $results.Add([ordered]@{ id = [string]$item.id; ok = $true })
    }
    catch {
        # PowerPoint refusing a call because it is busy (a dialog is open in it, possibly the author's) is no fault of this
        # slide (ruling M1-R74). It goes up again, so that the module reports it as busy and nothing is written, instead of
        # the slide being deleted and recorded as one PowerPoint cannot author. The finally below still releases the references.
        if (Test-BusyError $_.Exception) { throw }
        $failed.Add([int]$item.slide)
        $results.Add([ordered]@{ id = [string]$item.id; ok = $false; reason = ('{0}: {1}' -f $step, (Get-RootReason $_.Exception)) })
    }
    finally {
        foreach ($o in @($label, $font, $range, $frame, $node, $nodes, $smart, $layout, $effect, $effects, $fill, $original, $shape, $shapes, $slide, $slides)) { Remove-ComRef $o }
    }
}

$currentSlide = 0

# A slide that failed is deleted from the copy (highest number first), so the deck holds only what was authored.
foreach ($number in @($failed | Sort-Object -Descending)) {
    $slides = Get-ComProperty $pres 'Slides'
    $slide = $slides.Item([int]$number)
    try { $slide.Delete() }
    finally { Remove-ComRef $slide; Remove-ComRef $slides }
}
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
$pres.SaveCopyAs($target)
$json = [ordered]@{ slideCount = $slideTotal; slides = $results.ToArray() } | ConvertTo-Json -Depth 5 -Compress
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
'@

# ---- The run -----------------------------------------------------------------------------------------------------
$invoke = @{
    Pptx = $pptxPath; Action = $authorAction; ActionArgs = @($planText, $assetsPath, $outPath, [int]$TestBusyAtSlide, [string]$TestBusyOnRead)
    TestHangSec = $TestHangSec; TestBlockSec = $TestBlockSec; TestBusy = [bool]$TestBusy
}
# Without -TimeoutSec the module scales the limit to the deck (120 s + 4 s per slide).
if ($PSBoundParameters.ContainsKey('TimeoutSec') -and $TimeoutSec -gt 0) { $invoke.TimeoutSec = $TimeoutSec }
$watch = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-DeckbackPowerPoint @invoke
$watch.Stop()

$record = [ordered]@{ ok = $false; exitCode = 3; seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1) }
$code = 3
if ($r.exitCode -eq 0) {
    $parsed = $null
    try { $parsed = [string]@($r.result)[0] | ConvertFrom-Json } catch { }
    if ($null -eq $parsed -or $null -eq $parsed.slides) {
        Write-Err 'PowerPoint gave no readable result'
        $record.reason = 'error'
    }
    elseif (-not (Test-Path -LiteralPath $outPath -PathType Leaf)) {
        Write-Err 'PowerPoint wrote no file'
        $record.reason = 'no-output'
    }
    else {
        $record.ok = $true
        $record.exitCode = 0
        $record.slideCount = [int]$parsed.slideCount
        $record.slides = @($parsed.slides | ForEach-Object {
                $slideRecord = [ordered]@{ id = [string]$_.id; ok = [bool]$_.ok }
                if (-not $slideRecord.ok) { $slideRecord.reason = [string]$_.reason }
                $slideRecord
            })
        $code = 0
        foreach ($s in $record.slides) {
            if ($s.ok) { Write-Err "$($s.id) authored" } else { Write-Err "$($s.id) FAILED: $($s.reason)" }
        }
    }
}
else {
    Write-Err "$($r.message)"
    $code = $r.exitCode
    $record.exitCode = $code
    $record.reason = 'error'
    if ($r.busy) { $record.reason = 'powerpoint-busy' }
    elseif ($code -eq 2) { $record.reason = 'timeout' }
    elseif ("$($r.message)" -match 'slide-count-mismatch') { $record.reason = 'slide-count-mismatch' }
}
if ($r.stuck) { $record.stuck = $true }
if ("$($r.message)" -and $code -eq 0) { Write-Err "$($r.message)" }
Write-Result $record $code ([bool]$r.stuck)
