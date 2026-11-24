<#
.SYNOPSIS
  Export a .pptx to the PDF variants every deckback test uses (and, optionally, to truecolour ground-truth PNGs),
  with the desktop Microsoft PowerPoint (COM).

.DESCRIPTION
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File export.ps1 -Pptx <path> -OutDir <dir>
        [-Variants std,min,notags,pdfa,hidden,msprint] [-GroundTruth] [-TimeoutSec <s>]

  Writes <OutDir>/<stem>_<variant>.pdf for each requested variant (default: all six), where <stem> is the file name
  of the deck without its extension. With -GroundTruth it also writes <OutDir>/gt/<stem>/slide<N>.png, 8-bit RGB
  (PNG colour type 2), 2 px per point of the slide size (1920 x 1080 for a 16:9 slide), by the same BMP route as
  harness/ppt/render.ps1 (harness/ppt/slide_png_action.ps1), and <OutDir>/gt/<stem>/map.json:
    {"slides":N,"stdPages":P,"stdPage":{"1":1,"2":2,...,"159":null,...}}
  which maps each slide number to its page number in the std PDF (null for a hidden slide; hidden slides are not in
  std, min, notags, pdfa or msprint, but are in hidden).

  Variants (ExportAsFixedFormat(path, 2, intent, 0, 1, 1, hidden, range 1..n, 1, '', -1, -1, tags, -1, pdfa)):
    std      intent 2 (print)   hidden slides skipped  tags on   PDF/A off
    min      intent 1 (screen = minimum size)          tags on
    notags   intent 2                                  tags off
    pdfa     intent 2                                  tags on   PDF/A (ISO 19005-1) on
    hidden   intent 2           hidden slides included tags on
    msprint  the printer 'Microsoft Print to PDF': PrintOptions.ActivePrinter, PrintInBackground = 0,
             PrintHiddenSlides = 0 (as std, ruling M1-R28), PrintOut(1, n, <path>).
             A printer setting may be application-wide, and the application is the author's when the author has
             PowerPoint open, so this variant runs only in a PowerPoint this run started
             (Invoke-DeckbackPowerPoint -RequireOwned, ruling M1-R27). With a POWERPNT process around it is recorded
             as ok: false, exitCode 4, reason 'skipped: PowerPoint already running (msprint changes the shared
             ActivePrinter)' and PowerPoint is not touched for it. If the printer is not installed it is recorded as
             ok: false, reason 'printer-missing'. Neither counts as a failure of the export.
             The print job may make 'Microsoft Print to PDF' the Windows default printer ("Let Windows manage my
             default printer"), so the default printer is read before msprint runs and put back afterwards if it
             changed (minor m5, harness/atlas/default_printer.ps1); the msprint record says how in "defaultPrinter":
             unchanged, restored, not-restored or unknown (no printer name in it).

  The last line of stdout is one JSON line:
    {"variants":{"<v>":{"ok":bool,"exitCode":int,"pages":int,"seconds":n[,"expectedPages":int][,"reason":s]
                        [,"defaultPrinter":s (msprint)]}},
     "groundTruth":{...}}
  "groundTruth" is present with -GroundTruth: {"ok","exitCode","slides","seconds"[,"reason"]}. exitCode is the
  Invoke-DeckbackPowerPoint code of that run (0 ok, 2 timeout, 3 error or not run, 4 skipped). pages is the page
  count of the PDF written, read from the file (no PowerPoint) and checked against expectedPages, which comes from
  the deck file, not from PowerPoint: the number of slides in ppt/presentation.xml, minus the hidden ones (show="0")
  for every variant but hidden. A different count, or PowerPoint seeing a different number of slides than the file
  has (a repaired deck), is ok: false (page-count-mismatch, slide-count-mismatch) and the PDF is deleted.
  reason is one of: the skipped text above, printer-missing, timeout, error, no-output, page-count-mismatch,
  slide-count-mismatch, skipped-after-stuck, powerpoint-busy (PowerPoint refused the calls because it was busy, as
  while a dialog is open in it: exitCode 3, not a fault of the deck; ruling M1-R74). Error text (which may contain
  paths) goes to stderr only, as do the progress lines. An unexpected exception during the run still writes the JSON line (the variants not yet
  done are ok: false, reason error) and exits 3.

  Each variant is a run of its own through Invoke-DeckbackPowerPoint, one after the other (the module also holds a
  PC-wide lock), so a variant that hangs costs one time limit and is recorded; the others still run. 'Microsoft Print
  to PDF' goes last, after the ground truth, because it is the one most likely to raise a dialog. If a run comes back
  stuck (a PowerPoint call is blocked, for example by a dialog) no further PowerPoint run is started: the variants not
  yet run are recorded as skipped-after-stuck, the JSON line is written and the process ends with
  [Environment]::Exit, since a normal exit would wait for the blocked job.

  Exit codes:
    0  every requested variant was exported (a missing printer or a skipped msprint does not count against it)
    2  at least one run timed out (possible repair or modal dialog)
    3  bad arguments (nothing written, no JSON line), or a variant failed otherwise (the JSON line says which)

  A PDF of a variant that failed is deleted (unless the run is stuck). Old PDFs of the requested variants, old
  slide*.png and map.json of the ground truth are deleted before the run, so a result never mixes runs.

  This script runs on a PC where the author may have PowerPoint open with unsaved work. It drives PowerPoint only
  through harness/ppt/DeckbackCom.psm1: a GUID-named temp copy is exported (never the input file), closing and
  quitting follow the module's rules, and no process is ever stopped or killed. See harness/README.md.
#>
param(
    [Parameter(Mandatory = $true)][string]$Pptx,
    [Parameter(Mandatory = $true)][string]$OutDir,
    # Also accepts one comma-separated string, as a -File invocation passes it.
    [string[]]$Variants = @('std', 'min', 'notags', 'pdfa', 'hidden', 'msprint'),
    [switch]$GroundTruth,
    # Per PowerPoint run. Default: 120 s + 4 s per slide (Get-DeckbackTimeout).
    [int]$TimeoutSec,
    # Test hooks only. -TestHangSec / -TestBlockSec (as in render.ps1): every run waits this long before touching
    # PowerPoint, to exercise exit code 2: a wait that stopping the job can interrupt (-TestHangSec) and one it cannot
    # (-TestBlockSec, like a call blocked by a dialog, which leaves the run stuck). -TestPageCountAdjust is added to
    # every expected page count, to exercise the page-count check.
    [double]$TestHangSec = 0,
    [double]$TestBlockSec = 0,
    [int]$TestPageCountAdjust = 0,
    # Test hook only: every run's job fails with PowerPoint's busy refusal before it touches PowerPoint (powerpoint-busy).
    [switch]$TestBusy
)
$ErrorActionPreference = 'Stop'

$printerName = 'Microsoft Print to PDF'
$msprintSkipReason = 'skipped: PowerPoint already running (msprint changes the shared ActivePrinter)'
# intent: 2 = ppFixedFormatIntentPrint, 1 = ppFixedFormatIntentScreen (minimum size). hidden, tags, pdfa: msoTrue = -1.
$exportSpec = @{
    std    = @{ intent = 2; hidden = 0;  tags = -1; pdfa = 0 }
    min    = @{ intent = 1; hidden = 0;  tags = -1; pdfa = 0 }
    notags = @{ intent = 2; hidden = 0;  tags = 0;  pdfa = 0 }
    pdfa   = @{ intent = 2; hidden = 0;  tags = -1; pdfa = -1 }
    hidden = @{ intent = 2; hidden = -1; tags = -1; pdfa = 0 }
}
$known = @('std', 'min', 'notags', 'pdfa', 'hidden', 'msprint')

function Write-Err([string]$Message) { [Console]::Error.WriteLine("export.ps1: $Message") }

function Stop-WithError([int]$Code, [string]$Message) {
    Write-Err $Message
    exit $Code
}

function Resolve-FullPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

# One entry of a zip as an XML document (no DTDs, no external resolver).
function Read-ZipXml($Zip, [string]$EntryName) {
    $entry = $Zip.GetEntry($EntryName)
    if ($null -eq $entry) { throw "not a usable .pptx (no $EntryName)" }
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $stream = $entry.Open()
    try {
        $reader = [Xml.XmlReader]::Create($stream, $settings)
        try {
            $doc = New-Object Xml.XmlDocument
            $doc.Load($reader)
            return $doc
        }
        finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

# One bool per slide of the deck file, in presentation order: true for a hidden slide (show="0" on p:sld). Read from
# the zip, not from PowerPoint, so that it is evidence about the deck itself.
function Get-PptxSlideHidden([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
        try {
            $presentation = Read-ZipXml $zip 'ppt/presentation.xml'
            $rels = Read-ZipXml $zip 'ppt/_rels/presentation.xml.rels'
            $targets = @{}
            foreach ($rel in $rels.SelectNodes("//*[local-name()='Relationship']")) { $targets[$rel.GetAttribute('Id')] = $rel.GetAttribute('Target') }
            $ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
            $hidden = New-Object System.Collections.Generic.List[bool]
            $ids = $presentation.SelectNodes("/*[local-name()='presentation']/*[local-name()='sldIdLst']/*[local-name()='sldId']")
            foreach ($id in $ids) {
                $target = [string]$targets[$id.GetAttribute('id', $ns)]
                if (-not $target) { throw 'not a usable .pptx (a slide id without a relationship)' }
                if ($target.StartsWith('/')) { $part = $target.TrimStart('/') } else { $part = "ppt/$target" }
                $show = (Read-ZipXml $zip $part).DocumentElement.GetAttribute('show')
                $hidden.Add($show -eq '0' -or $show -eq 'false')
            }
            return , $hidden.ToArray()
        }
        finally { $zip.Dispose() }
    }
    finally { $stream.Dispose() }
}

try { Import-Module -Name (Join-Path $PSScriptRoot '..\ppt\DeckbackCom.psm1') -Force }
catch { Stop-WithError 3 "cannot load harness/ppt/DeckbackCom.psm1: $($_.Exception.Message)" }
try { . (Join-Path $PSScriptRoot 'default_printer.ps1') }
catch { Stop-WithError 3 "cannot load harness/atlas/default_printer.ps1: $($_.Exception.Message)" }

# ---- Arguments: all checked before anything is written or PowerPoint is touched ---------------------------------
$requested = New-Object System.Collections.Generic.List[string]
foreach ($item in $Variants) {
    foreach ($name in ([string]$item -split '[,\s]+')) {
        if ($name -eq '') { continue }
        $name = $name.ToLowerInvariant()
        if ($known -notcontains $name) { Stop-WithError 3 "unknown variant '$name' (known: $($known -join ', '))" }
        if (-not $requested.Contains($name)) { $requested.Add($name) }
    }
}
if ($requested.Count -eq 0) { Stop-WithError 3 'no variant requested' }

$pptxPath = Resolve-FullPath $Pptx
$outPath = Resolve-FullPath $OutDir
if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) { Stop-WithError 3 "file not found: $pptxPath" }
try { $slideHidden = Get-PptxSlideHidden $pptxPath }
catch { Stop-WithError 3 "cannot read the slide list of the deck: $($_.Exception.Message)" }
$slideTotal = $slideHidden.Count
$hiddenTotal = @($slideHidden | Where-Object { $_ }).Count
$stem = [IO.Path]::GetFileNameWithoutExtension($pptxPath)
$gtPath = Join-Path (Join-Path $outPath 'gt') $stem
try {
    New-Item -ItemType Directory -Force -Path $outPath | Out-Null
}
catch { Stop-WithError 3 "cannot prepare the output directory $outPath : $($_.Exception.Message)" }

# ---- What runs inside the module's job (against the opened temp copy) --------------------------------------------
# $args: output path, intent, hidden, tags, pdfa. Returns the slide count PowerPoint sees.
$exportAction = @'
param($pres, $app, $args)
$path = [string]$args[0]
$slides = $pres.Slides
try { $n = [int]$slides.Count } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($slides) }
$options = $pres.PrintOptions
$ranges = $options.Ranges
$range = $null
try {
    $ranges.ClearAll()
    $range = $ranges.Add(1, $n)
    $pres.ExportAsFixedFormat($path, 2, [int]$args[1], 0, 1, 1, [int]$args[2], $range, 1, '', -1, -1, [int]$args[3], -1, [int]$args[4])
}
finally {
    if ($null -ne $range) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($range) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ranges)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($options)
}
$n
'@

# $args: output path, printer name. Runs only with -RequireOwned, in a PowerPoint this run started: a printer setting
# may be application-wide, and nobody else has this instance. The options are those of the throwaway copy. Returns
# the slide count PowerPoint sees.
$printAction = @'
param($pres, $app, $args)
$path = [string]$args[0]
$slides = $pres.Slides
try { $n = [int]$slides.Count } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($slides) }
$options = $pres.PrintOptions
try {
    $options.ActivePrinter = [string]$args[1]
    $options.PrintInBackground = 0
    # PowerPoint's default prints hidden slides; std does not, and msprint is std through another printer.
    $options.PrintHiddenSlides = 0
    $pres.PrintOut(1, $n, $path)
}
finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($options) }
$n
'@

$gtAction = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\ppt\slide_png_action.ps1'))

# ---- Helpers --------------------------------------------------------------------------------------------------------
function Test-PrinterInstalled([string]$Name) {
    Add-Type -AssemblyName System.Drawing
    foreach ($p in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) {
        if ($p -ieq $Name) { return $true }
    }
    return $false
}

# Page count of a PDF written by PowerPoint or the Microsoft print driver, read from the file: the number of page
# objects. 0 if there are none (not a plain PDF; the caller then records no-output). The file is opened so that a
# writer may still have it open.
function Get-PdfPageCount([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try {
        $memory = New-Object IO.MemoryStream
        $stream.CopyTo($memory)
        $text = [Text.Encoding]::GetEncoding(28591).GetString($memory.ToArray())
    }
    finally { $stream.Dispose() }
    return [int][regex]::Matches($text, '/Type\s*/Page(?![A-Za-z])').Count
}

# The page count, read again for up to ~4 s while it is not the expected one or the file cannot be read yet (a PDF that
# is still being written or still held by its writer).
function Read-PdfPages([string]$Path, [int]$Expected) {
    $count = 0
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try { $count = Get-PdfPageCount $Path } catch { $count = 0 }
        if ($count -gt 0 -and $count -eq $Expected) { break }
        Start-Sleep -Milliseconds 500
    }
    return $count
}

function Remove-IfPresent([string]$Path) {
    try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop; return $true }
    catch { return -not (Test-Path -LiteralPath $Path) }
}

# Common wrapper for one PowerPoint run: returns the module's result plus the elapsed seconds.
function Invoke-Run([string]$Action, [object[]]$ActionArgs, [bool]$RequireOwned = $false) {
    $invoke = @{ Pptx = $pptxPath; Action = $Action; ActionArgs = $ActionArgs; TestHangSec = $script:TestHangSec; TestBlockSec = $script:TestBlockSec; TestBusy = [bool]$script:TestBusy }
    # Without -TimeoutSec the module scales the limit to the deck (120 s + 4 s per slide).
    if ($script:TimeoutSec -gt 0) { $invoke.TimeoutSec = $script:TimeoutSec }
    if ($RequireOwned) { $invoke.RequireOwned = $true }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-DeckbackPowerPoint @invoke
    $watch.Stop()
    [pscustomobject]@{ run = $r; seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1) }
}

# ---- The run ----------------------------------------------------------------------------------------------------------
$results = [ordered]@{}
foreach ($name in $requested) { $results[$name] = $null }
$gt = $null
$stuck = $false
$anyTimeout = $false
$anyFailure = $false

function Set-Variant([string]$Name, [bool]$Ok, [int]$ExitCode, [int]$Pages, [double]$Seconds, [string]$Reason, [int]$Expected = -1) {
    $record = [ordered]@{ ok = $Ok; exitCode = $ExitCode; pages = $Pages; seconds = $Seconds }
    if ($Expected -ge 0) { $record.expectedPages = $Expected }
    if ($Reason) { $record.reason = $Reason }
    $results[$Name] = $record
    $line = "$Name ok=$Ok exitCode=$ExitCode pages=$Pages seconds=$Seconds"
    if ($Expected -ge 0) { $line += " expectedPages=$Expected" }
    if ($Reason) { $line += " reason=$Reason" }
    Write-Err $line
}

# One PDF variant. $Action: the export or the print action; $Extra: its arguments after the output path.
function Invoke-PdfVariant([string]$Name, [string]$Action, [object[]]$Extra, [int]$Expected, [bool]$RequireOwned = $false) {
    $pdf = Join-Path $outPath "${stem}_${Name}.pdf"
    if (-not (Remove-IfPresent $pdf)) {
        Write-Err "${Name}: cannot delete the old output file"
        Set-Variant $Name $false 3 0 0 'error' $Expected
        $script:anyFailure = $true
        return
    }
    $run = Invoke-Run $Action (@($pdf) + $Extra) $RequireOwned
    $r = $run.run
    if ($r.stuck) { $script:stuck = $true }
    $pages = 0
    if ($r.skipped) {
        # Not a failure: -RequireOwned and a PowerPoint was already running. PowerPoint was not touched.
        Set-Variant $Name $false 4 0 $run.seconds $script:msprintSkipReason $Expected
        return
    }
    if ($r.exitCode -eq 0) {
        $seen = [int]@($r.result)[0]
        if ($seen -ne $script:slideTotal) {
            Write-Err "${Name}: PowerPoint saw $seen slide(s), the deck file has $($script:slideTotal)"
            $reason = 'slide-count-mismatch'
            $code = 3
        }
        else {
            if (Test-Path -LiteralPath $pdf -PathType Leaf) { $pages = Read-PdfPages $pdf $Expected }
            if ($pages -gt 0 -and $pages -eq $Expected) {
                Set-Variant $Name $true 0 $pages $run.seconds '' $Expected
                if ($r.message) { Write-Err "${Name}: $($r.message)" }
                return
            }
            if ($pages -gt 0) {
                Write-Err "${Name}: the PDF has $pages page(s), expected $Expected"
                $reason = 'page-count-mismatch'
            }
            else {
                Write-Err "${Name}: PowerPoint wrote no readable PDF"
                $reason = 'no-output'
            }
            $code = 3
        }
    }
    else {
        Write-Err "${Name}: $($r.message)"
        $code = $r.exitCode
        $reason = 'error'
        if ($r.busy) { $reason = 'powerpoint-busy' }
        if ($code -eq 2) { $reason = 'timeout'; $script:anyTimeout = $true }
    }
    $script:anyFailure = $true
    if (-not $r.stuck) { [void](Remove-IfPresent $pdf) }
    Set-Variant $Name $false $code $pages $run.seconds $reason $Expected
}

function Set-Skipped([string]$Name) {
    $script:anyTimeout = $true
    $script:anyFailure = $true
    Set-Variant $Name $false 2 0 0 'skipped-after-stuck'
}

# gt/<stem>/map.json: slide number -> page number in the std PDF (null for a hidden slide), from the deck file.
function Write-SlidePageMap([string]$Path) {
    $map = [ordered]@{}
    $page = 0
    for ($i = 0; $i -lt $script:slideTotal; $i++) {
        if ($script:slideHidden[$i]) { $map["$($i + 1)"] = $null }
        else { $page++; $map["$($i + 1)"] = $page }
    }
    $doc = [ordered]@{ slides = $script:slideTotal; stdPages = $page; stdPage = $map }
    [IO.File]::WriteAllText($Path, (($doc | ConvertTo-Json -Depth 4 -Compress) + "`n"), (New-Object Text.UTF8Encoding($false)))
}

try {
    foreach ($name in $requested) {
        if ($name -eq 'msprint') { continue }
        if ($stuck) { Set-Skipped $name; continue }
        $s = $exportSpec[$name]
        $expected = $slideTotal - $hiddenTotal
        if ($name -eq 'hidden') { $expected = $slideTotal }
        Invoke-PdfVariant $name $exportAction @($s.intent, $s.hidden, $s.tags, $s.pdfa) ($expected + $TestPageCountAdjust)
    }

    if ($GroundTruth) {
        $gt = [ordered]@{ ok = $false; exitCode = 3; slides = 0; seconds = 0 }
        if ($stuck) {
            $gt.exitCode = 2; $gt.reason = 'skipped-after-stuck'
            $anyTimeout = $true; $anyFailure = $true
            Write-Err 'groundTruth skipped-after-stuck'
        }
        else {
            $prepared = $true
            try {
                New-Item -ItemType Directory -Force -Path $gtPath | Out-Null
                Get-ChildItem -LiteralPath $gtPath -File |
                    Where-Object { $_.Name -match '^(slide\d+\.(png|bmp|tif)|map\.json)$' } |
                    Remove-Item -Force
            }
            catch { $prepared = $false; Write-Err "groundTruth: cannot prepare the output directory: $($_.Exception.Message)"; $gt.reason = 'error' }
            if ($prepared) {
                # Width and height 0: 2 px per point of the slide size.
                $run = Invoke-Run $gtAction @($gtPath, 0, 0, $false)
                $r = $run.run
                if ($r.stuck) { $stuck = $true }
                $gt.seconds = $run.seconds
                $gt.exitCode = $r.exitCode
                if ($r.exitCode -eq 0) {
                    $count = [int]@($r.result)[0]
                    $written = @(Get-ChildItem -LiteralPath $gtPath -Filter 'slide*.png' -File).Count
                    $gt.slides = $written
                    if ($count -ne $slideTotal) {
                        $gt.exitCode = 3; $gt.reason = 'slide-count-mismatch'
                        Write-Err "groundTruth: PowerPoint saw $count slide(s), the deck file has $slideTotal"
                    }
                    elseif ($written -ne $count -or $count -le 0) {
                        $gt.exitCode = 3; $gt.reason = 'no-output'
                        Write-Err "groundTruth: $written PNG(s) written for $count slide(s)"
                    }
                    else {
                        Write-SlidePageMap (Join-Path $gtPath 'map.json')
                        $gt.ok = $true
                    }
                    if ($r.message) { Write-Err "groundTruth: $($r.message)" }
                }
                else {
                    Write-Err "groundTruth: $($r.message)"
                    $gt.reason = 'error'
                    if ($r.busy) { $gt.reason = 'powerpoint-busy' }
                    if ($r.exitCode -eq 2) { $gt.reason = 'timeout'; $anyTimeout = $true }
                }
                # What a failed or timed-out run left behind (the action deletes its intermediates itself).
                if (-not $r.stuck) {
                    Get-ChildItem -LiteralPath $gtPath -File -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -match '^slide\d+\.(bmp|tif)$' } |
                        Remove-Item -Force -ErrorAction SilentlyContinue
                }
            }
            if (-not $gt.ok) { $anyFailure = $true }
            Write-Err "groundTruth ok=$($gt.ok) exitCode=$($gt.exitCode) slides=$($gt.slides) seconds=$($gt.seconds)"
        }
    }

    if ($requested.Contains('msprint')) {
        if ($stuck) { Set-Skipped 'msprint' }
        elseif (-not (Test-PrinterInstalled $printerName)) {
            # Not a failure of the export: some PCs have no PDF printer. Recorded, PowerPoint not touched.
            Set-Variant 'msprint' $false 3 0 0 'printer-missing' ($slideTotal - $hiddenTotal + $TestPageCountAdjust)
        }
        else {
            # The print job may make the PDF printer the Windows default (m5): read the default before, put it back after.
            $printerBefore = $null
            try { $printerBefore = Read-DeckbackPrinterState }
            catch { Write-Err "msprint: cannot read the Windows default printer: $($_.Exception.Message)" }
            try {
                # Only in a PowerPoint this run started (M1-R27): the printer setting is application-wide.
                Invoke-PdfVariant 'msprint' $printAction @($printerName) ($slideTotal - $hiddenTotal + $TestPageCountAdjust) $true
            }
            finally {
                $printerOutcome = Restore-DeckbackPrinterState -Before $printerBefore
                if ($null -ne $results['msprint']) { $results['msprint'].defaultPrinter = $printerOutcome }
                Write-Err "msprint defaultPrinter=$printerOutcome"
            }
        }
    }
}
catch {
    # Whatever went wrong, the caller still gets the JSON line below.
    Write-Err "unexpected error: $($_.Exception.Message)"
    $anyFailure = $true
    if ($GroundTruth -and $null -eq $gt) { $gt = [ordered]@{ ok = $false; exitCode = 3; slides = 0; seconds = 0; reason = 'error' } }
}
foreach ($name in $requested) {
    if ($null -eq $results[$name]) { Set-Variant $name $false 3 0 0 'error' }
}

# ---- Result ---------------------------------------------------------------------------------------------------------
$summary = [ordered]@{ variants = $results }
if ($null -ne $gt) { $summary.groundTruth = $gt }
[Console]::Out.WriteLine(($summary | ConvertTo-Json -Depth 6 -Compress))
[Console]::Out.Flush()

$code = 0
if ($anyFailure) { $code = 3 }
if ($anyTimeout) { $code = 2 }
# A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
if ($stuck) { [Environment]::Exit($code) }
exit $code
