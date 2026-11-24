<#
.SYNOPSIS
  Render every slide of a .pptx to slide<N>.png with Microsoft PowerPoint (COM).

.DESCRIPTION
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File render.ps1 -Pptx <path> -OutDir <dir>
        [-Width 1920] [-Height 1080] [-TimeoutSec <s>]

  -TimeoutSec defaults to 120 s + 4 s per slide (Get-DeckbackTimeout).

  Exit codes:
    0  ok, one slide<N>.png per slide written to OutDir (stdout: "OK slides=<n> dir=<dir>")
    2  timeout: PowerPoint did not answer within TimeoutSec (possible repair or modal dialog)
    3  open/export error (message on stderr)
    5  PowerPoint is busy: it refused a call (RPC_E_CALL_REJECTED / RPC_E_SERVERCALL_RETRYLATER), as it does while a
       dialog is open in it, possibly the author's (ruling M1-R74: recorded as powerpoint-busy, not as a fault of the
       deck)

  Old slide<N>.png files in OutDir are deleted before exporting, so OutDir never mixes runs.

  Every slide<N>.png is 8-bit RGB (PNG colour type 2), never a palette PNG: PowerPoint's own PNG export writes a
  palette PNG (type 3) for slides with few colours, which would add noise to every pixel metric. So each slide is
  exported as a 24-bit BMP and re-encoded with System.Drawing (Format24bppRgb). If PowerPoint ever writes a BMP that
  is not 24-bit, that slide goes through a TIF instead (a note on stderr says how many). The intermediate .bmp/.tif
  files are deleted.

  This script runs on a PC where the author may have PowerPoint open with unsaved work. It drives PowerPoint
  only through harness/ppt/DeckbackCom.psm1 (Invoke-DeckbackPowerPoint), which renders a GUID-named temp copy
  (never the input file itself), closes only that copy, quits only a PowerPoint it started (decided by process
  id), never stops or kills a PowerPoint process and runs all COM work in a job with a timeout. See the module
  and harness/README.md.
#>
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$Width = 1920,
    [int]$Height = 1080,
    # Default: 120 s + 4 s per slide (Get-DeckbackTimeout).
    [int]$TimeoutSec,
    # Test hooks only: the job waits this long before touching PowerPoint, to exercise exit code 2; a wait that
    # stopping the job can interrupt (-TestHangSec) or cannot (-TestBlockSec, like a call blocked by a dialog).
    [double]$TestHangSec = 0,
    [double]$TestBlockSec = 0,
    # Test hook only: export every slide through the TIF fallback, as if the BMP were not 24-bit.
    [switch]$TestForceTif,
    # Test hook only: the module's job fails with PowerPoint's busy refusal before it touches PowerPoint (exit code 5).
    [switch]$TestBusy
)
$ErrorActionPreference = 'Stop'

function Stop-WithError([int]$Code, [string]$Message, [bool]$Stuck = $false) {
    [Console]::Error.WriteLine("render.ps1: $Message")
    # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
    if ($Stuck) { [Environment]::Exit($Code) }
    exit $Code
}

function Resolve-FullPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

try { Import-Module -Name (Join-Path $PSScriptRoot 'DeckbackCom.psm1') -Force }
catch { Stop-WithError 3 "cannot load harness/ppt/DeckbackCom.psm1: $($_.Exception.Message)" }

$pptxPath = Resolve-FullPath $Pptx
$outPath = Resolve-FullPath $OutDir
if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) {
    Stop-WithError 3 "file not found: $pptxPath"
}
try {
    New-Item -ItemType Directory -Force -Path $outPath | Out-Null
    Get-ChildItem -LiteralPath $outPath -Filter 'slide*' -File |
        Where-Object { $_.Name -match '^slide\d+\.(png|bmp|tif)$' } |
        Remove-Item -Force
}
catch { Stop-WithError 3 "cannot prepare the output directory $outPath : $($_.Exception.Message)" }

# Runs inside the module's job against the opened temp copy (the text is shared with harness/atlas/export.ps1).
# $args: output dir, width, height, force-TIF flag; see harness/ppt/slide_png_action.ps1.
$action = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'slide_png_action.ps1'))

$invoke = @{
    Pptx = $pptxPath; Action = $action; ActionArgs = @($outPath, $Width, $Height, [bool]$TestForceTif)
    TestHangSec = $TestHangSec; TestBlockSec = $TestBlockSec; TestBusy = [bool]$TestBusy
}
# Without -TimeoutSec the module scales the limit to the deck (120 s + 4 s per slide).
if ($PSBoundParameters.ContainsKey('TimeoutSec')) { $invoke.TimeoutSec = $TimeoutSec }
$r = Invoke-DeckbackPowerPoint @invoke

# Intermediate BMP/TIF exports: the action deletes them; this catches what a failed or timed-out run left behind.
try {
    Get-ChildItem -LiteralPath $outPath -Filter 'slide*' -File |
        Where-Object { $_.Name -match '^slide\d+\.(bmp|tif)$' } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
catch { }

if ($r.busy) { Stop-WithError 5 $r.message ([bool]$r.stuck) }
if ($r.exitCode -ne 0) { Stop-WithError $r.exitCode $r.message ([bool]$r.stuck) }
if ($r.message) { [Console]::Error.WriteLine("render.ps1: $($r.message)") }
$slideCount = @($r.result)[0]
$tifCount = @($r.result)[1]
if ($tifCount -gt 0) {
    [Console]::Error.WriteLine("render.ps1: $tifCount of $slideCount slide(s) went through the TIF fallback (the BMP export was not 24-bit)")
}
Write-Output "OK slides=$slideCount dir=$outPath"
exit 0
