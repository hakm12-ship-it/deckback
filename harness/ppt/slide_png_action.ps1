# Shared by harness/ppt/render.ps1 and harness/atlas/export.ps1 (ground-truth PNGs): the action text that
# Invoke-DeckbackPowerPoint runs inside its job against the opened temp copy. It is the source of a script block, so
# it starts with param($pres, $app, $args) and may not mention the names DeckbackCom.psm1 forbids in an action.
# $args: output dir, width, height, force-TIF flag. A width or height of 0 or less means 2 px per point of the slide
# size (1920 x 1080 for a 16:9 slide of 960 x 540 pt).
# Slide.Export('PNG') writes a palette PNG for slides with few colours, so a slide is exported as a 24-bit BMP (a TIF
# if the BMP is ever not 24-bit) and re-encoded as an RGB PNG with System.Drawing. Returns the slide count and the
# number of slides that needed the TIF fallback.
param($pres, $app, $args)
$outPath = [string]$args[0]
$width = [int]$args[1]
$height = [int]$args[2]
$forceTif = [bool]$args[3]
Add-Type -AssemblyName System.Drawing
if ($width -le 0 -or $height -le 0) {
    $setup = $pres.PageSetup
    try {
        $width = [int][math]::Round($setup.SlideWidth * 2)
        $height = [int][math]::Round($setup.SlideHeight * 2)
    }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($setup) }
}

# Bits per pixel from a BMP file header; 0 when the file is not a BMP.
function Get-BmpBitCount([string]$File) {
    $head = New-Object byte[] 30
    $stream = [IO.File]::OpenRead($File)
    try { $n = $stream.Read($head, 0, 30) } finally { $stream.Dispose() }
    if ($n -lt 30 -or $head[0] -ne 0x42 -or $head[1] -ne 0x4D) { return 0 }
    if ([BitConverter]::ToUInt32($head, 14) -eq 12) { return [int][BitConverter]::ToUInt16($head, 24) }
    [int][BitConverter]::ToUInt16($head, 28)
}

# Copies the image pixel for pixel into a Format24bppRgb bitmap and saves that as PNG (8-bit RGB, colour type 2).
function ConvertTo-RgbPng([string]$Source, [string]$Target) {
    $image = [System.Drawing.Image]::FromFile($Source)
    try {
        if (([int]$image.PixelFormat -band [int][System.Drawing.Imaging.PixelFormat]::Indexed) -ne 0) {
            throw "PowerPoint exported a palette image ($($image.PixelFormat)): colours are already quantised"
        }
        $w = $image.Width
        $h = $image.Height
        $rgb = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $g = [System.Drawing.Graphics]::FromImage($rgb)
            try {
                $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
                $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
                # Explicit 1:1 pixel rectangles: the BMP carries 144 dpi, which would otherwise rescale the copy.
                $dest = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h
                $g.DrawImage($image, $dest, 0, 0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel)
            }
            finally { $g.Dispose() }
            $rgb.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally { $rgb.Dispose() }
    }
    finally { $image.Dispose() }
}

# PNG colour type: IHDR byte 25.
function Get-PngColourType([string]$File) {
    $head = New-Object byte[] 26
    $stream = [IO.File]::OpenRead($File)
    try { $n = $stream.Read($head, 0, 26) } finally { $stream.Dispose() }
    if ($n -lt 26) { return -1 }
    [int]$head[25]
}

$slides = $pres.Slides
$tifCount = 0
try {
    $count = $slides.Count
    for ($i = 1; $i -le $count; $i++) {
        $png = Join-Path $outPath "slide$i.png"
        $bmp = Join-Path $outPath "slide$i.bmp"
        $tif = Join-Path $outPath "slide$i.tif"
        $slide = $slides.Item($i)
        try {
            $source = $null
            if (-not $forceTif) {
                $slide.Export($bmp, 'BMP', $width, $height)
                if ((Test-Path -LiteralPath $bmp -PathType Leaf) -and (Get-BmpBitCount $bmp) -ge 24) { $source = $bmp }
            }
            if ($null -eq $source) {
                $slide.Export($tif, 'TIF', $width, $height)
                $source = $tif
                $tifCount++
            }
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "export wrote no file for slide $i"
            }
            ConvertTo-RgbPng $source $png
        }
        finally {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($slide)
            Remove-Item -LiteralPath $bmp, $tif -Force -ErrorAction SilentlyContinue
        }
        if ((Get-PngColourType $png) -ne 2) { throw "slide $i was not written as an 8-bit RGB PNG" }
    }
    $count
    $tifCount
}
finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($slides) }
