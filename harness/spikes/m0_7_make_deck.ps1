<#
.SYNOPSIS
  Spike M0-7: build the 51-slide test deck as a PDF with Microsoft PowerPoint (COM).

.DESCRIPTION
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File m0_7_make_deck.ps1
        [-Pptx corpus/private/probe/original.pptx] [-OutPdf out/m0/deck51.pdf] [-Slides 51] [-TimeoutSec <s>]

  Copies the 3-slide probe deck, duplicates its slides (1, 2, 3, 1, 2, 3, ...) until the copy has -Slides
  slides, and saves that copy as a PDF (SaveAs, ppSaveAsPDF = 32). Then asks PyMuPDF (harness/.venv) for the
  page count of the PDF and fails unless it equals -Slides. Relative paths are relative to the repository root.
  -TimeoutSec defaults to 120 s + 4 s per slide of the finished deck (Get-DeckbackTimeout -SlideCount -Slides).

  Exit codes:
    0  ok (stdout: "OK slides=<n> pages=<n> pdf=<path>")
    2  timeout: PowerPoint did not answer within TimeoutSec (possible repair or modal dialog)
    3  open/export error (message on stderr)
    4  the PDF was written but PyMuPDF does not report -Slides pages (or could not be asked)
  On every failure exit (2, 3, 4) the output PDF written by this run is deleted, and only that file. -OutPdf must
  end in .pdf and must not be the input file: whatever it names is deleted before the run, so a bad value exits 3
  before anything is touched.

  PowerPoint safety. This runs on a PC where the author may have PowerPoint open with unsaved work, so it drives
  PowerPoint only through harness/ppt/DeckbackCom.psm1 (Invoke-DeckbackPowerPoint), like render.ps1: the module
  opens a GUID-named temp copy of the input (read-only, without a window), closes only that copy, quits only a
  PowerPoint it started (decided by process id), never stops or kills a PowerPoint process and runs all COM work
  in a job with a timeout. Duplicating slides edits that copy in memory only; the copy is never saved, and the
  module marks it saved before closing so PowerPoint does not ask about it. See harness/README.md.
#>
param(
    [string]$Pptx = 'corpus/private/probe/original.pptx',
    [string]$OutPdf = 'out/m0/deck51.pdf',
    [int]$Slides = 51,
    # Default: 120 s + 4 s per slide of the finished deck (Get-DeckbackTimeout).
    [int]$TimeoutSec,
    # Test hooks only: the job waits this long before touching PowerPoint, to exercise exit code 2; a wait that
    # stopping the job can interrupt (-TestHangSec) or cannot (-TestBlockSec, like a call blocked by a dialog).
    [double]$TestHangSec = 0,
    [double]$TestBlockSec = 0
)
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pdfPath = $null
# True once this run has made sure $pdfPath did not exist: from then on a file there was written by this run.
$pdfOwned = $false

# A failed run must not leave a partial or wrong deck behind that a later step could take for the real one.
# Only the file this run wrote is deleted: nothing else, and nothing at all before the output path was cleared.
function Remove-OutputPdf {
    if ($pdfOwned -and $null -ne $pdfPath -and (Test-Path -LiteralPath $pdfPath)) {
        try { Remove-Item -LiteralPath $pdfPath -Force }
        catch { [Console]::Error.WriteLine("m0_7_make_deck.ps1: could not delete the failed output (still open in PowerPoint?): $pdfPath") }
    }
}

function Stop-WithError([int]$Code, [string]$Message, [bool]$Stuck = $false) {
    [Console]::Error.WriteLine("m0_7_make_deck.ps1: $Message")
    Remove-OutputPdf
    # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
    if ($Stuck) { [Environment]::Exit($Code) }
    exit $Code
}

function Resolve-FullPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $repo $Path }
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

try { Import-Module -Name (Join-Path $repo 'harness\ppt\DeckbackCom.psm1') -Force }
catch { Stop-WithError 3 "cannot load harness/ppt/DeckbackCom.psm1: $($_.Exception.Message)" }

$pptxPath = Resolve-FullPath $Pptx
$pdfPath = Resolve-FullPath $OutPdf
if ($Slides -lt 1) { Stop-WithError 3 "-Slides must be at least 1" }
if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) {
    Stop-WithError 3 "file not found: $pptxPath"
}
# The next step deletes whatever -OutPdf names, so it must be a PDF path and must not be the input.
if ([IO.Path]::GetExtension($pdfPath) -ine '.pdf') {
    Stop-WithError 3 "-OutPdf must end in .pdf (it is deleted before the run): $pdfPath"
}
if ($pdfPath -ieq $pptxPath) {
    Stop-WithError 3 "-OutPdf is the input file (it is deleted before the run): $pdfPath"
}
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pdfPath) | Out-Null
    # A stale PDF must never pass for this run's output.
    Remove-Item -LiteralPath $pdfPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $pdfPath) { throw "the old PDF is still there (open in a viewer?)" }
}
catch { Stop-WithError 3 "cannot prepare the output $pdfPath : $($_.Exception.Message)" }
$pdfOwned = $true

# Runs inside the module's job against the opened temp copy. $args: output PDF path, wanted slide count.
$action = @'
param($pres, $app, $args)
$pdfPath = [string]$args[0]
$want = [int]$args[1]
$slides = $pres.Slides
try {
    $original = $slides.Count
    if ($original -lt 1) { throw "the probe deck has no slides" }
    # Duplicate the original slides in turn and move each copy to the end: 1, 2, 3, 1, 2, 3, ...
    for ($i = 0; $slides.Count -lt $want; $i++) {
        $source = $slides.Item(1 + ($i % $original))
        $copies = $null
        try {
            $copies = $source.Duplicate()
            $copies.MoveTo($slides.Count)
        }
        finally {
            if ($null -ne $copies) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($copies) }
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($source)
        }
    }
    $count = $slides.Count
    if ($count -ne $want) { throw "the copy has $count slides, wanted $want" }
    # SaveAs(FileName, FileFormat = ppSaveAsPDF)
    $pres.SaveAs($pdfPath, 32)
    if (-not (Test-Path -LiteralPath $pdfPath -PathType Leaf)) { throw "SaveAs wrote no PDF" }
    $count
}
finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($slides) }
'@

if (-not $PSBoundParameters.ContainsKey('TimeoutSec')) { $TimeoutSec = Get-DeckbackTimeout -SlideCount $Slides }
$r = Invoke-DeckbackPowerPoint -Pptx $pptxPath -Action $action -ActionArgs @($pdfPath, $Slides) -TimeoutSec $TimeoutSec `
    -TestHangSec $TestHangSec -TestBlockSec $TestBlockSec

if ($r.exitCode -eq 2) {
    Stop-WithError 2 ("$($r.message) The output PDF, if PowerPoint had already written one, is deleted; if PowerPoint" +
        " is still working on it, a late file may appear at $pdfPath and must not be used.") ([bool]$r.stuck)
}
if ($r.exitCode -ne 0) { Stop-WithError $r.exitCode $r.message ([bool]$r.stuck) }
if ($r.message) { [Console]::Error.WriteLine("m0_7_make_deck.ps1: $($r.message)") }

# Ask PyMuPDF (the harness oracle) how many pages the PDF really has.
$python = Join-Path $repo 'harness\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    Stop-WithError 4 "the harness Python environment is missing ($python); see harness/README.md. The unverified PDF was deleted."
}
$pages = & $python -I -c 'import sys, pymupdf; print(pymupdf.open(sys.argv[1]).page_count)' $pdfPath
if ($LASTEXITCODE -ne 0 -or "$pages".Trim() -ne "$Slides") {
    Stop-WithError 4 "PyMuPDF reports '$pages' pages in $pdfPath, expected $Slides. The PDF was deleted."
}

Write-Output "OK slides=$($r.result) pages=$("$pages".Trim()) pdf=$pdfPath"
exit 0
