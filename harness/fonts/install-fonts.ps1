<#
.SYNOPSIS
  Install the free (OFL) fonts listed in fonts.lock.json for the current user. No admin rights needed.

.DESCRIPTION
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File install-fonts.ps1 [-LockPath <fonts.lock.json>]

  Public test decks and PDFs may embed only the fonts in fonts.lock.json (static TrueType OFL families such as
  Pretendard, Gothic A1, Gowun Batang and NanumGothic), never Microsoft fonts such as Malgun Gothic. This script puts
  those fonts on this PC.

  What it does:
    1. Reads fonts.lock.json and checks every entry (plain file name, https URL, 64-hex sha256), including the
       "retired" list (files an earlier version of the lock installed).
    2. Removes each retired font, but only when the file in the per-user font folder has exactly the retired sha256
       AND its HKCU value (the retired registryValue) points at exactly that file: it unloads the font from this
       Windows session (RemoveFontResource, as Windows' own font uninstall does), deletes the file, then deletes the
       value. Anything else (a different file, a value pointing elsewhere, a value whose file is gone) is left
       untouched and reported on stderr. A retired font that is already gone is skipped silently.
    3. Looks at what is already installed. A font file that is already in place with the right sha256 is left alone
       and not downloaded again; the script can be run any number of times.
    4. Downloads the missing files, each into a NEW EMPTY temp directory made for this run, and checks the sha256
       of every file against the lock. One mismatch aborts the run before anything is installed. Nothing from a
       downloaded file is ever executed, only copied.
    5. Copies the files to %LOCALAPPDATA%\Microsoft\Windows\Fonts and adds one value per font under
       HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts ("<full name> (TrueType)" -> full file path).
    6. Verifies every file and value again, removes the temp directory and prints "FONTS OK <n>" (n = fonts in
       the lock, all installed).

  M8-R2/M8-R4: a family that is an Office cloud font already (a folder of that name under
  %LOCALAPPDATA%\Microsoft\FontCache\4\CloudFonts, which PowerPoint for Microsoft 365 fills by itself) is skipped with
  a warning on stderr, not installed and not an error: the cloud copy wins, because a second copy of another version
  makes PowerPoint's render differ from the PDF. So the base lock installs with no override. -AllowCloudDuplicates
  installs such a family anyway.

  It never overwrites a different file that has the same name, or a registry value that points elsewhere: that is
  reported as an error and nothing is changed. It never touches HKLM or the Windows system font folder, and it does
  not touch PowerPoint. PowerPoint (and any other program that is already open) may need to be restarted before it
  lists the new fonts or forgets the removed ones.

  Exit codes:
    0  every font in the lock file is installed (stdout ends with "FONTS OK <n>")
    1  error (message on stderr); nothing was installed unless the message says otherwise
#>
param(
    [string]$LockPath = (Join-Path $PSScriptRoot 'fonts.lock.json'),
    # Test hooks: install somewhere else (a scratch directory and a scratch registry key).
    [string]$FontDir = (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'),
    [string]$RegPath = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts',
    [string]$CloudFontsDir = $(if ($env:DECKBACK_CLOUDFONTS) { $env:DECKBACK_CLOUDFONTS } else { Join-Path $env:LOCALAPPDATA 'Microsoft\FontCache\4\CloudFonts' }),
    [switch]$AllowCloudDuplicates
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'

function Stop-WithError([string]$Message) {
    [Console]::Error.WriteLine("install-fonts.ps1: $Message")
    exit 1
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-FontValue([string]$Name) {
    if (-not (Test-Path -LiteralPath $RegPath)) { return $null }
    (Get-Item -LiteralPath $RegPath).GetValue($Name, $null)
}

function Remove-SessionFont([string]$Path) {
    # A per-user font is loaded into the Windows session at sign-in, which keeps its file in use. Undo every load of
    # exactly this file (RemoveFontResource returns false once the file is no longer loaded); returns how many.
    if (-not ('Deckback.FontResource' -as [type])) {
        Add-Type -Namespace Deckback -Name FontResource -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("gdi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool RemoveFontResourceW(string name);
'@
    }
    $count = 0
    while ($count -lt 16 -and [Deckback.FontResource]::RemoveFontResourceW($Path)) { $count++ }
    return $count
}

$tempDir = $null
try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    # 1. The lock file.
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { Stop-WithError "lock file not found: $LockPath" }
    $lock = [IO.File]::ReadAllText($LockPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $fonts = @()
    foreach ($family in $lock.families) {
        foreach ($f in $family.files) {
            if ($f.file -notmatch '^[A-Za-z0-9_-]+\.(ttf|otf)$') { Stop-WithError "lock entry has a bad file name: $($f.file)" }
            if ($f.sha256 -notmatch '^[0-9a-f]{64}$') { Stop-WithError "lock entry has a bad sha256: $($f.file)" }
            if ($f.url -notmatch '^https://[^\s]+$') { Stop-WithError "lock entry has a non-https url: $($f.file)" }
            if ([string]::IsNullOrWhiteSpace($f.fullName) -or $f.fullName -match '[\\/]') { Stop-WithError "lock entry has a bad fullName: $($f.file)" }
            $fonts += [pscustomobject]@{
                Family    = [string]$family.family
                File      = $f.file
                Url       = $f.url
                Sha256    = $f.sha256
                Dest      = Join-Path $FontDir $f.file
                ValueName = "$($f.fullName) (TrueType)"
            }
        }
    }
    if ($fonts.Count -eq 0) { Stop-WithError "the lock file lists no fonts" }
    # M8-R4: an Office cloud font wins. A family that is one already is skipped, with a warning (not an error): PowerPoint
    # brings its own copy, and a second copy of another version would make the render differ from the PDF.
    if (-not $AllowCloudDuplicates -and (Test-Path -LiteralPath $CloudFontsDir -PathType Container)) {
        # a cloud family is a folder that holds a font file, as harness/fonts/cloudfonts.py reads it (review M8)
        $cloud = @(Get-ChildItem -LiteralPath $CloudFontsDir -Directory | Where-Object {
                @(Get-ChildItem -LiteralPath $_.FullName -File | Where-Object { $_.Extension -match '^\.(ttf|otf|ttc|otc)$' }).Count -gt 0
            } | ForEach-Object { $_.Name })
        $skipped = @($lock.families | Where-Object { $cloud -contains [string]$_.family } | ForEach-Object { [string]$_.family })
        foreach ($name in $skipped) {
            [Console]::Error.WriteLine("install-fonts.ps1: warning: skipped $name, it is an Office cloud font already (M8-R4: the cloud copy wins)")
        }
        $fonts = @($fonts | Where-Object { $skipped -notcontains $_.Family })
    }
    $retired = @()
    if ($lock.PSObject.Properties['retired']) {
        foreach ($r in @($lock.retired)) {
            if ($r.file -notmatch '^[A-Za-z0-9_-]+\.(ttf|otf)$') { Stop-WithError "retired entry has a bad file name: $($r.file)" }
            if ($r.sha256 -notmatch '^[0-9a-f]{64}$') { Stop-WithError "retired entry has a bad sha256: $($r.file)" }
            if ([string]$r.registryValue -notmatch '^[^\\/]+ \(TrueType\)$') { Stop-WithError "retired entry has a bad registryValue: $($r.file)" }
            if (@($fonts | Where-Object { $_.File -eq $r.file }).Count -gt 0) { Stop-WithError "retired file is also in the lock: $($r.file)" }
            $retired += [pscustomobject]@{
                File      = $r.file
                Sha256    = $r.sha256
                Path      = Join-Path $FontDir $r.file
                ValueName = [string]$r.registryValue
            }
        }
    }

    # 2. Retired fonts: remove exactly what an earlier lock installed, nothing else.
    foreach ($r in $retired) {
        $fileThere = Test-Path -LiteralPath $r.Path -PathType Leaf
        $value = Get-FontValue $r.ValueName
        $valueIsOurs = ($null -ne $value) -and ([string]$value -eq $r.Path)
        if (-not $fileThere -and -not $valueIsOurs) { continue }  # already gone (the value name may belong to a new font now)
        $reason = $null
        if (-not $fileThere) { $reason = "its file is gone but the registry value '$($r.ValueName)' still points to it" }
        elseif ((Get-Sha256 $r.Path) -ne $r.Sha256) { $reason = 'the file is not the retired one (different sha256)' }
        elseif (-not $valueIsOurs) { $reason = "the registry value '$($r.ValueName)' does not point to it" }
        if ($reason) {
            [Console]::Error.WriteLine("install-fonts.ps1: retired $($r.File) left untouched: $reason")
            continue
        }
        $unloaded = Remove-SessionFont $r.Path
        try { Remove-Item -LiteralPath $r.Path -Force }
        catch { Stop-WithError "could not delete the retired $($r.File) ($($_.Exception.Message)); its registry value was left in place" }
        Remove-ItemProperty -LiteralPath $RegPath -Name $r.ValueName
        Write-Output "removed retired $($r.File) (file and registry value; unloaded from this session: $unloaded)"
    }

    # 3. What is already there; stop on anything that would have to be overwritten.
    $needed = @()
    foreach ($font in $fonts) {
        if (Test-Path -LiteralPath $font.Dest) {
            $have = Get-Sha256 $font.Dest
            if ($have -ne $font.Sha256) {
                Stop-WithError "$($font.Dest) exists with different content; not overwriting it. Remove or rename it and run again."
            }
        }
        else {
            $needed += $font
        }
        $value = Get-FontValue $font.ValueName
        if ($null -ne $value -and [string]$value -ne $font.Dest) {
            Stop-WithError "registry value '$($font.ValueName)' already points to '$value'; not changing it."
        }
    }

    # 4. Download what is missing into a new empty temp directory and verify every file before installing any.
    if ($needed.Count -gt 0) {
        $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('deckback-fonts-' + [Guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $tempDir) { Stop-WithError "temp directory already exists: $tempDir" }
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        foreach ($font in $needed) {
            $part = Join-Path $tempDir $font.File
            Write-Output "downloading $($font.File)"
            try { Invoke-WebRequest -UseBasicParsing -Uri $font.Url -OutFile $part }
            catch { Stop-WithError "download failed for $($font.File): $($_.Exception.Message)" }
            $got = Get-Sha256 $part
            if ($got -ne $font.Sha256) {
                Stop-WithError "sha256 mismatch for $($font.File) (lock $($font.Sha256), got $got); nothing was installed."
            }
        }
        if (-not (Test-Path -LiteralPath $FontDir)) { New-Item -ItemType Directory -Path $FontDir | Out-Null }
        foreach ($font in $needed) {
            Copy-Item -LiteralPath (Join-Path $tempDir $font.File) -Destination $font.Dest
            Write-Output "installed $($font.File)"
        }
    }

    # 5. Registry values (idempotent: Set-ItemProperty overwrites an identical value with itself).
    if (-not (Test-Path -LiteralPath $RegPath)) { New-Item -Path $RegPath -Force | Out-Null }
    foreach ($font in $fonts) {
        if ([string](Get-FontValue $font.ValueName) -ne $font.Dest) {
            Set-ItemProperty -LiteralPath $RegPath -Name $font.ValueName -Value $font.Dest -Type String
        }
    }

    # 6. Verify the result from scratch.
    $ok = 0
    foreach ($font in $fonts) {
        if (-not (Test-Path -LiteralPath $font.Dest)) { Stop-WithError "missing after install: $($font.Dest)" }
        if ((Get-Sha256 $font.Dest) -ne $font.Sha256) { Stop-WithError "wrong content after install: $($font.Dest)" }
        if ([string](Get-FontValue $font.ValueName) -ne $font.Dest) { Stop-WithError "registry value missing after install: $($font.ValueName)" }
        $ok++
    }
    Write-Output 'Restart PowerPoint (and any open program) to see the new fonts; this script does not touch PowerPoint.'
    Write-Output "FONTS OK $ok"
}
finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        # Only the directory this run created (its name carries the GUID); never anything else.
        if ((Split-Path -Leaf $tempDir) -like 'deckback-fonts-*') { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
exit 0
