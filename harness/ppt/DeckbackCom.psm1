<#
.SYNOPSIS
  DeckbackCom: the one place where harness scripts drive Microsoft PowerPoint through COM.

.DESCRIPTION
  The harness runs on the author's own PC, where PowerPoint may be open with unsaved work. Every script that
  drives PowerPoint goes through this module, and no other file creates a PowerPoint.Application COM object.
  The rules (unchanged from M0's render.ps1):
    - The POWERPNT process ids are recorded before anything attaches to PowerPoint.
    - The input file is never opened itself: the module works on a GUID-named temp copy
      (%TEMP%\deckback-com-<id>.pptx) opened ReadOnly, not Untitled, without a window. Even if the author has
      the very same file open, the copy cannot be that document.
    - A presentation is closed only if the presentation count rose by exactly one on Open and the opened file
      carries the copy's unique name. Otherwise everything is left alone.
    - Application.Quit() is called only on an instance this run started, decided by process id: a POWERPNT
      process that did not exist before the attach, launched by COM activation (an -Embedding switch), while no
      PowerPoint was running at all; only if that process is still the only POWERPNT process and still carries
      -Embedding; and only if, read right before the call, the instance shows no sign that someone uses it
      (ruling M1-R73, Get-DeckbackAuthorSigns): no presentation, no document window, no Protected View window, not
      visible, not under user control. PowerPoint runs as one process, so a PowerPoint the author starts meanwhile
      (its start screen, or a document from an e-mail in Protected View) joins the run's own instance; such an
      instance is left running, its COM references released, and the reason is logged.
    - A PowerPoint process is never ended, not even on timeout; a leftover is reported instead (see
      harness/README.md for the manual cleanup).
    - All COM work runs in a Start-Job that is waited on with a timeout (exitCode 2).
    - Every COM reference is released (FinalReleaseComObject, then two GC rounds) before the job host exits:
      a host that exits holding references keeps PowerPoint alive for minutes.
    - A child process started inside the job gets its own stdin, stdout and stderr
      (Invoke-DeckbackChildProcess): the job host talks to its parent over its own stdin/stdout.
    - One run at a time on this PC: Invoke-DeckbackPowerPoint holds the named mutex Global\deckback-powerpoint
      from the process id snapshot to the end of its cleanup. A second run waits for it, at most its own time
      limit, and then gives up with exitCode 3.
    - -RequireOwned is for an action that may change state shared by the whole PowerPoint application, such as the
      active printer: that state belongs to the author when the author has PowerPoint open. The action then runs
      only in an instance this run started (ownedPid, proved by process id right after the attach). If a POWERPNT
      process existed, the run is skipped (exitCode 4, skipped = $true) before the copy is opened and before the
      action is touched. Only such an action may name ActivePrinter.

  Exported:
    Get-PptxSlideCount -Pptx <path>                       slide count from ppt/presentation.xml, no PowerPoint
    Get-DeckbackTimeout -SlideCount <n> [-BaseSec 120] [-PerSlideSec 4]
    Invoke-DeckbackPowerPoint -Pptx <path> -Action <string> [-ActionArgs <object[]>] [-TimeoutSec <s>] [-RequireOwned]
    Invoke-DeckbackChildProcess -FilePath <exe> [-ArgumentList <string[]>]    for actions that need a child
    Connect-DeckbackPowerPoint [-WasRunning <bool>] / Disconnect-DeckbackPowerPoint -Session <s>
        Attach with ownership decided by process id, and the matching release. Only the module's job and the
        three PowerShell tests that play the author may use them (test_com_module.ps1 checks this); harness
        scripts use Invoke-DeckbackPowerPoint only.

  A call PowerPoint refuses because it is busy (RPC_E_CALL_REJECTED or RPC_E_SERVERCALL_RETRYLATER: a dialog is open
  in it, possibly the author's) ends the run with exitCode 3 and busy = $true (ruling M1-R74), so that callers record
  it as powerpoint-busy rather than as a fault of the deck. Such a run is not retried.
#>

Add-Type -AssemblyName System.IO.Compression
if (-not ('DeckbackNative.HandleInheritance' -as [type])) {
    # Only flags are read and set (HANDLE_FLAG_INHERIT = 1); no handle is queried in a way that could block.
    Add-Type -Namespace DeckbackNative -Name HandleInheritance -MemberDefinition @'
[DllImport("kernel32.dll")] static extern bool GetHandleInformation(IntPtr hObject, out int lpdwFlags);
[DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);
public static IntPtr[] DisableAll() {
    var changed = new System.Collections.Generic.List<IntPtr>();
    for (long v = 4; v <= 0x10000; v += 4) {
        IntPtr h = new IntPtr(v);
        int flags;
        if (GetHandleInformation(h, out flags) && (flags & 1) != 0 && SetHandleInformation(h, 1, 0)) { changed.Add(h); }
    }
    return changed.ToArray();
}
public static void Restore(IntPtr[] handles) {
    if (handles == null) { return; }
    foreach (IntPtr h in handles) { SetHandleInformation(h, 1, 1); }
}
'@
}

$script:ModulePath = $PSCommandPath
$script:CopyPrefix = 'deckback-com-'
$script:MutexName = 'Global\deckback-powerpoint'
# Sessions made by Connect-DeckbackPowerPoint in this module instance, with the application wrapper and the owned
# process id as recorded at attach time. Disconnect-DeckbackPowerPoint trusts only these, never the session's
# own (caller-settable) properties.
$script:Sessions = New-Object System.Collections.Generic.List[object]

# What an action may not reach: other presentations and windows (the copy has no window, so these can only be
# the author's), closing or quitting anything, and attaching to PowerPoint on its own.
$script:ForbiddenInAction = '(?i)Active(Presentation|Window|ProtectedViewWindow)\b' +
    '|\.\s*(Presentations|SlideShowWindows|ProtectedViewWindows)\b|(?<!System)\.\s*Windows\b' +
    '|\.\s*(Quit|Close)\s*\(|(Connect|Disconnect)-DeckbackPowerPoint|New-Object\s+-ComObject' +
    '|GetActiveObject|GetTypeFromProgID|Activator\]::CreateInstance'

# Names an action may use only with -RequireOwned: they may change state shared by the whole application, which is
# the author's when the author has PowerPoint open.
$script:ForbiddenUnlessOwned = '(?i)\bActivePrinter\b'
$script:SkipMessage = 'skipped: PowerPoint was already running, and -RequireOwned allows the action only in an instance this run started'
# RPC_E_CALL_REJECTED (0x80010001) and RPC_E_SERVERCALL_RETRYLATER (0x8001010A): the COM server refused the call because
# it is busy, as Office does while a modal dialog is open (ruling M1-R74).
$script:BusyHResults = @(-2147418111, -2147417846)

function Get-DeckbackPowerPointPids {
    @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

# True if the exception, or one it wraps (PowerShell wraps a COM error in a MethodInvocationException), is PowerPoint
# refusing a call because it is busy.
function Test-DeckbackBusyError($Exception) {
    for ($e = $Exception; $null -ne $e; $e = $e.InnerException) {
        if ($script:BusyHResults -contains $e.HResult) { return $true }
        if ("$($e.Message)" -match '0x80010001|0x8001010A|RPC_E_CALL_REJECTED|RPC_E_SERVERCALL_RETRYLATER') { return $true }
    }
    return $false
}

# What shows that someone may be using a PowerPoint instance (ruling M1-R73), read from the application object: an
# open presentation, a document window, a Protected View window, the application being visible (an instance COM
# started stays hidden until someone shows it: the author's start screen, a window), and UserControl where the
# application has it (PowerPoint 16 has none; Word and Excel do). Outputs one string per sign ("Windows.Count 1",
# "Visible"; collect them with @()); a property that cannot be read counts as a sign ("Windows unreadable"). No
# output: no sign.
function Get-DeckbackAuthorSigns($App) {
    $signs = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('Presentations', 'Windows', 'ProtectedViewWindows')) {
        $collection = $null
        try {
            # A property getter that fails gives $null in PowerShell (it does not throw), so $null is a sign too.
            $collection = $App.$name
            $count = $null
            if ($null -ne $collection) { $count = $collection.Count }
            if ($null -eq $count) { $signs.Add("$name unreadable") }
            elseif ([int]$count -ne 0) { $signs.Add("$name.Count $([int]$count)") }
        }
        catch { $signs.Add("$name unreadable") }
        finally {
            # One reference only: the caller may hold the same wrapper.
            if ($null -ne $collection -and [Runtime.InteropServices.Marshal]::IsComObject($collection)) {
                try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($collection) } catch { }
            }
        }
    }
    try {
        $visible = $App.Visible
        if ($null -eq $visible) { $signs.Add('Visible unreadable') }
        elseif ([int]$visible -ne 0) { $signs.Add('Visible') }      # msoTrue is -1; anything but msoFalse (0)
    }
    catch { $signs.Add('Visible unreadable') }
    if (@($App | Get-Member -Name UserControl -MemberType Properties -ErrorAction SilentlyContinue).Count -gt 0) {
        try { if ([bool]$App.UserControl) { $signs.Add('UserControl') } }
        catch { $signs.Add('UserControl unreadable') }
    }
    $signs.ToArray()
}

# True if the command line carries -Embedding (or /Embedding) as a switch of its own: not inside the program
# path, a quoted argument or a longer word.
function Test-DeckbackEmbeddingSwitch([string]$CommandLine) {
    if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
    $tokens = [regex]::Matches($CommandLine, '"[^"]*"|\S+')
    for ($i = 1; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i].Value
        if ($t -ieq '-Embedding' -or $t -ieq '/Embedding') { return $true }
    }
    return $false
}

function Test-DeckbackComLaunched([int]$TargetPid) {
    # A PowerPoint that COM activation started carries -Embedding on its command line.
    # A user-launched one does not. Unknown means not ours.
    try { $cmd = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$TargetPid").CommandLine }
    catch { return $false }
    return (Test-DeckbackEmbeddingSwitch $cmd)
}

# A new process inherits every inheritable handle of this one: our stdin, stdout and stderr and copies of them that
# PowerShell keeps. A job host left blocked after a timeout would then hold our caller's output pipes open, and a
# caller that reads them to the end (Python's subprocess with capture_output, for one) would wait for it, possibly
# forever; a child started inside a job would hold the job's channel. So no handle of this process is inheritable
# while such a process is created; the flags are restored right after. The new process still gets the pipes or
# files created for it.
function Disable-DeckbackHandleInheritance { , [DeckbackNative.HandleInheritance]::DisableAll() }

function Restore-DeckbackHandleInheritance($Changed) { [DeckbackNative.HandleInheritance]::Restore([IntPtr[]]@($Changed)) }

function Resolve-DeckbackPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Wait-DeckbackPidGone([int]$TargetPid, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    return -not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)
}

function Get-DeckbackNewPids([int[]]$Before) {
    @(Get-DeckbackPowerPointPids | Where-Object { $Before -notcontains $_ })
}

function Test-DeckbackJobFinished($Job) {
    return ($Job.State -eq 'Completed' -or $Job.State -eq 'Failed' -or $Job.State -eq 'Stopped')
}

# Asks our own job host to stop its pipeline (never PowerPoint) and waits at most $WaitSec. Stop-Job itself waits
# until the pipeline has stopped, which never happens while a PowerPoint call inside it is blocked, so it runs in a
# background runspace. (Job.StopJobAsync, which M0 used, does not exist on Windows PowerShell 5.1 jobs.) A stopped
# job still runs its finally blocks: it closes the copy it opened and releases its COM references. A job blocked in
# a call goes on to its finally as soon as the call returns; the next command in it never runs.
function Request-DeckbackJobStop($Job, [int]$WaitSec) {
    if (Test-DeckbackJobFinished $Job) { return $true }
    $stopper = [PowerShell]::Create()
    [void]$stopper.AddCommand('Stop-Job').AddParameter('Job', $Job)
    $handle = $stopper.BeginInvoke()
    [void](Wait-Job -Job $Job -Timeout $WaitSec)
    if (-not (Test-DeckbackJobFinished $Job)) { return $false }
    # A stopper that has not returned yet is left to finish on its own; disposing it could block.
    if ($handle.AsyncWaitHandle.WaitOne(2000)) { try { $stopper.Dispose() } catch { } }
    return $true
}

function Remove-DeckbackCopy([string]$Path, [int]$WaitSec) {
    # PowerPoint may take a moment to let go of a copy it just closed.
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ($true) {
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 250
    }
}

# Proves that $Pres is the temp copy before anything works on it or closes it. The file name is a GUID nobody
# else can have open, so the leaf name is compared: it cannot be fooled by 8.3 names, junctions or a differently
# spelled temp path the way a full-path comparison can.
function Test-DeckbackOwnCopy($List, $Pres, [int]$CountBefore, [string]$CopyName) {
    try { return ($List.Count -eq $CountBefore + 1 -and [IO.Path]::GetFileName($Pres.FullName) -ieq $CopyName) }
    catch { return $false }
}

# Quotes one argument so that the C runtime / CommandLineToArgvW splits it back unchanged.
function ConvertTo-DeckbackArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

<#
.SYNOPSIS
  Number of slides in a .pptx: the p:sldId entries of ppt/presentation.xml, read from the zip without PowerPoint.
#>
function Get-PptxSlideCount {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory = $true)][string]$Pptx)
    $path = Resolve-DeckbackPath $Pptx
    # Others may read, write and delete meanwhile: the author may have this very file open in PowerPoint.
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
        try {
            $entry = $zip.GetEntry('ppt/presentation.xml')
            if ($null -eq $entry) { throw "not a .pptx (no ppt/presentation.xml): $path" }
            $settings = New-Object Xml.XmlReaderSettings
            $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $entryStream = $entry.Open()
            try {
                $reader = [Xml.XmlReader]::Create($entryStream, $settings)
                try {
                    $doc = New-Object Xml.XmlDocument
                    $doc.Load($reader)
                }
                finally { $reader.Dispose() }
            }
            finally { $entryStream.Dispose() }
        }
        finally { $zip.Dispose() }
    }
    finally { $stream.Dispose() }
    # Matched by local name, so the namespace prefix (p:) and the transitional/strict namespace do not matter.
    $ids = $doc.SelectNodes("/*[local-name()='presentation']/*[local-name()='sldIdLst']/*[local-name()='sldId']")
    return [int]$ids.Count
}

<#
.SYNOPSIS
  Time limit for one PowerPoint run: BaseSec + PerSlideSec x SlideCount.
#>
function Get-DeckbackTimeout {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory = $true)][int]$SlideCount,
        [int]$BaseSec = 120,
        [int]$PerSlideSec = 4
    )
    if ($SlideCount -lt 0) { throw "SlideCount must not be negative (got $SlideCount)" }
    return [int]($BaseSec + $PerSlideSec * $SlideCount)
}

<#
.SYNOPSIS
  Attaches to PowerPoint (starting it if none is running) and decides by process id whether this call started it.

.DESCRIPTION
  Returns [pscustomobject] @{ app; ownedPid; newPids }. ownedPid is set only when no POWERPNT process existed
  before (and -WasRunning is false), exactly one appeared, and its command line carries an -Embedding switch (COM
  activation). Only such an instance may later be quit, by Disconnect-DeckbackPowerPoint, which goes by what this
  call recorded, not by the returned object's properties. Run it inside a job with a timeout. Only the module's
  job and the tests that play the author use it.
#>
function Connect-DeckbackPowerPoint {
    [CmdletBinding()]
    param([bool]$WasRunning = $false)
    $pidsBefore = @(Get-DeckbackPowerPointPids)
    $app = New-Object -ComObject PowerPoint.Application
    $newPids = @(Get-DeckbackNewPids $pidsBefore)
    $ownedPid = $null
    if (-not $WasRunning -and $pidsBefore.Count -eq 0 -and $newPids.Count -eq 1 -and (Test-DeckbackComLaunched $newPids[0])) {
        $ownedPid = $newPids[0]
    }
    $session = [pscustomobject]@{ app = $app; ownedPid = $ownedPid; newPids = $newPids }
    $script:Sessions.Add([pscustomobject]@{ session = $session; app = $app; ownedPid = $ownedPid })
    $session
}

<#
.SYNOPSIS
  Releases a session from Connect-DeckbackPowerPoint. Quits PowerPoint only if that call proved it started it, it is
  still the only POWERPNT process and still carries -Embedding, and, read right before Quit(), it shows no sign that
  someone uses it (Get-DeckbackAuthorSigns, ruling M1-R73). Returns $true if Quit() was called.

.DESCRIPTION
  Close and release your own presentations and collections first. Afterwards session.app is $null. An object that
  Connect-DeckbackPowerPoint did not return (in this module instance) is left alone entirely. An instance the session
  started but that is not quit is left running with its COM references released, and the reason is logged: the
  session gets a property leftRunning ("the PowerPoint this run started (process id N) was left running: ...").
  Ends with two GC rounds so that wrappers nobody holds any more are released too.
#>
function Disconnect-DeckbackPowerPoint {
    [CmdletBinding()]
    [OutputType([bool])]
    param($Session)
    $quit = $false
    $record = $null
    if ($null -ne $Session) {
        foreach ($r in $script:Sessions) {
            if ([object]::ReferenceEquals($r.session, $Session)) { $record = $r; break }
        }
    }
    if ($null -ne $record) {
        [void]$script:Sessions.Remove($record)
        $app = $record.app
        $ownedPid = $record.ownedPid
        $left = $null
        if ($null -ne $ownedPid) {
            try {
                # The process checks first (a process list and a WMI query take tens to hundreds of ms), then what the
                # instance shows, read right before Quit(): someone who joined it meanwhile is still seen.
                $now = @(Get-DeckbackPowerPointPids)
                if ($now -notcontains $ownedPid) { }                      # already gone: nothing to quit
                elseif ($now.Count -ne 1) { $left = "other POWERPNT process(es) are running ($(@($now | Where-Object { $_ -ne $ownedPid }) -join ','))" }
                elseif (-not (Test-DeckbackComLaunched $ownedPid)) { $left = 'it no longer shows as a COM-started (-Embedding) instance' }
                else {
                    $signs = @(Get-DeckbackAuthorSigns $app)
                    if ($signs.Count -eq 0) {
                        $app.Quit()
                        $quit = $true
                    }
                    else { $left = "it shows signs of use ($($signs -join ', '))" }
                }
            }
            catch { $left = "its checks failed ($($_.Exception.GetType().Name))" }
        }
        if ($null -ne $left) {
            $note = "the PowerPoint this run started (process id $ownedPid) was left running: $left; it was not quit (ruling M1-R73)"
            try { $Session | Add-Member -NotePropertyName leftRunning -NotePropertyValue $note -Force } catch { }
            Write-Verbose $note
        }
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch { }
        $app = $null
        $record.app = $null
        $record.session = $null
        try { $Session.app = $null } catch { }
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    return $quit
}

<#
.SYNOPSIS
  Runs a program with its own stdin (empty), stdout and stderr (temp files) and waits for it.
  Returns [pscustomobject] @{ exitCode; stdout; stderr }.

.DESCRIPTION
  Use it for every child process an action starts: inside a job, a child that inherited the job host's stdin or
  stdout would read or write the channel between the job and its parent and stall the job.
#>
function Invoke-DeckbackChildProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $ErrorActionPreference = 'Stop'
    $inFile = [IO.Path]::GetTempFileName()
    $outFile = [IO.Path]::GetTempFileName()
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $start = @{
            FilePath = $FilePath; Wait = $true; PassThru = $true; NoNewWindow = $true
            RedirectStandardInput = $inFile; RedirectStandardOutput = $outFile; RedirectStandardError = $errFile
        }
        $line = (@($ArgumentList) | ForEach-Object { ConvertTo-DeckbackArgument $_ }) -join ' '
        if ($line.Length -gt 0) { $start.ArgumentList = $line }
        $inheritable = Disable-DeckbackHandleInheritance
        try { $p = Start-Process @start }
        finally { Restore-DeckbackHandleInheritance $inheritable }
        [pscustomobject]@{
            exitCode = $p.ExitCode
            stdout   = [IO.File]::ReadAllText($outFile)
            stderr   = [IO.File]::ReadAllText($errFile)
        }
    }
    finally { Remove-Item -LiteralPath $inFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue }
}

# Runs inside the job host, in this module's scope (see $script:JobScript). Emits exactly one record (deckbackJob), and
# a second one (deckbackLeftRunning) when Disconnect left the instance this job started running (ruling M1-R73).
function Invoke-DeckbackJob {
    param([string]$CopyPath, [string]$ActionText, $ActionArgs, [bool]$WasRunning, [double]$HangSec, [double]$BlockSec, [bool]$RequireOwned, [bool]$BusyHook)
    $ErrorActionPreference = 'Stop'
    if ($null -eq $ActionArgs) { $ActionArgs = @() } else { $ActionArgs = @($ActionArgs) }
    # Test hooks only, before PowerPoint is touched: a wait a stop can interrupt (HangSec) and one it cannot, as
    # in a PowerPoint call blocked by a dialog (BlockSec).
    if ($BlockSec -gt 0) { [Threading.Thread]::Sleep([int]($BlockSec * 1000)) }
    if ($HangSec -gt 0) { Start-Sleep -Seconds $HangSec }

    $session = $null
    $presList = $null
    $pres = $null
    $countBefore = 0
    $proofDone = $false
    $ownsPres = $false
    $copyName = [IO.Path]::GetFileName($CopyPath)
    try {
        try {
            # Test hook only, before PowerPoint is touched: the refusal PowerPoint gives while a dialog is open.
            if ($BusyHook) { throw (New-Object Runtime.InteropServices.COMException('Call was rejected by callee. (Exception from HRESULT: 0x80010001 (RPC_E_CALL_REJECTED)) [test hook]', -2147418111)) }
            $session = Connect-DeckbackPowerPoint -WasRunning $WasRunning
            if ($RequireOwned -and $null -eq $session.ownedPid) {
                # Decided by the process id snapshot taken inside Connect, so a PowerPoint that appeared after the
                # caller looked is caught too. The copy is not opened and the action does not run.
                [pscustomobject]@{ deckbackJob = $true; ok = $false; skipped = $true; error = $script:SkipMessage; result = $null; ownedPid = $null }
                return
            }
            $presList = $session.app.Presentations
            $countBefore = $presList.Count
            # Open(FileName, ReadOnly = msoTrue, Untitled = msoFalse, WithWindow = msoFalse)
            $pres = $presList.Open($CopyPath, -1, 0, 0)
            $ownsPres = Test-DeckbackOwnCopy $presList $pres $countBefore $copyName
            $proofDone = $true
            if (-not $ownsPres) {
                throw "Open did not return a new presentation for the temp copy (count $countBefore -> $($presList.Count), got '$($pres.FullName)'); leaving it alone"
            }
            $action = [scriptblock]::Create($ActionText)
            # A parameter named $args is overwritten by the automatic $args (the unbound arguments), so the
            # arguments go in twice: once bound to the third parameter, once unbound so that $args holds them.
            $output = @(& $action $pres $session.app $ActionArgs @ActionArgs)
            $result = $null
            if ($output.Count -eq 1) { $result = $output[0] } elseif ($output.Count -gt 1) { $result = $output }
            [pscustomobject]@{ deckbackJob = $true; ok = $true; error = $null; result = $result; ownedPid = $session.ownedPid }
        }
        catch {
            $ownedPid = $null
            if ($null -ne $session) { $ownedPid = $session.ownedPid }
            [pscustomobject]@{ deckbackJob = $true; ok = $false; error = $_.Exception.Message; result = $null; ownedPid = $ownedPid; busy = (Test-DeckbackBusyError $_.Exception) }
        }
    }
    finally {
        # Also runs when the parent stops this job on timeout, as soon as no PowerPoint call is blocked.
        if ($null -ne $pres) {
            # A stop that lands between Open and the proof skipped the proof: do it now, by the same rule.
            if (-not $proofDone) { $ownsPres = Test-DeckbackOwnCopy $presList $pres $countBefore $copyName }
            if ($ownsPres) {
                # The action may have changed the copy in memory; it is never saved and nothing may ask about it.
                try { $pres.Saved = -1 } catch { }
                try { $pres.Close() } catch { }
            }
            try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($pres) } catch { }
        }
        if ($null -ne $presList) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presList) } catch { } }
        $pres = $null; $presList = $null; $output = $null; $result = $null; $action = $null
        # Release what the action left behind before PowerPoint is asked to quit.
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        [void](Disconnect-DeckbackPowerPoint -Session $session)
        if ($null -ne $session -and $null -ne $session.PSObject.Properties['leftRunning']) {
            [pscustomobject]@{ deckbackLeftRunning = $true; message = [string]$session.leftRunning }
        }
    }
}

# The job imports this module again (a job loses closures and module scope) and runs Invoke-DeckbackJob in it.
$script:JobScript = {
    param($ModulePath, $CopyPath, $ActionText, $ActionArgs, $WasRunning, $HangSec, $BlockSec, $RequireOwned, $BusyHook)
    $ErrorActionPreference = 'Stop'
    $module = Import-Module -Name $ModulePath -PassThru
    & $module { Invoke-DeckbackJob @args } $CopyPath $ActionText $ActionArgs $WasRunning $HangSec $BlockSec $RequireOwned $BusyHook
}

<#
.SYNOPSIS
  Opens a GUID-named, read-only, windowless temp copy of a .pptx in PowerPoint, runs an action on it in a job with a
  timeout, closes the copy and cleans up by the rules at the top of this module.

.DESCRIPTION
  -Action is the source text of a script block that starts with param($pres, $app, $args). It runs inside the job
  against the opened copy; $args holds -ActionArgs. Its output (plain data, not COM objects) becomes result: one
  object as is, several as an array. Errors in it are terminating ($ErrorActionPreference = 'Stop'). Child
  processes it starts go through Invoke-DeckbackChildProcess. Before PowerPoint is touched the action is rejected
  (exitCode 3) if its text mentions ActivePresentation, ActiveWindow, .Presentations, .Windows, .Quit( or
  .Close( and the like: the copy has no window, so those could only reach the author's documents.

  -TimeoutSec defaults to Get-DeckbackTimeout (Get-PptxSlideCount -Pptx); a file whose slides cannot be counted
  gets the base time and PowerPoint decides whether it opens. The run first waits, at most that long too, for the
  mutex Global\deckback-powerpoint (one run at a time).

  Returns [pscustomobject] @{ ok; exitCode; message; result; newPids; ownedPid; stuck; skipped; busy; leftRunning }:
    exitCode  0 ok; 2 timeout (possible repair or modal dialog); 3 open or action error, bad input, or another
              run held the lock too long; 4 skipped (only with -RequireOwned: a PowerPoint was already running,
              so nothing was opened and the action did not run; ok is false, skipped is true; not an error)
    message   the error, or on success a warning (empty if none). It may contain the input path: treat it as
              private.
    newPids   POWERPNT process ids that did not exist before the run and still exist after it
    ownedPid  the process id of the PowerPoint this run started and proved by process id, else $null
              ($null after a timeout too: the stopped job reports nothing; see newPids)
    skipped   $true only for exitCode 4
    busy      $true when PowerPoint refused a call because it is busy (exitCode 3; ruling M1-R74)
    leftRunning  $true when the PowerPoint this run started was not quit because it showed a sign of use, or its
              checks did not hold (ruling M1-R73); message then says which, with its process id
    stuck     $true if the job did not stop after a timeout (a PowerPoint call is blocked). The job is left
              alone; a normal exit of this process would wait for it, possibly forever, so a script must then
              end with [Environment]::Exit(<code>).
  It never throws for a failed run.
#>
function Invoke-DeckbackPowerPoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Pptx,
        [Parameter(Mandatory = $true)][string]$Action,
        [object[]]$ActionArgs = @(),
        [int]$TimeoutSec,
        # Test hooks only, before the job touches PowerPoint: a wait a stop can interrupt (-TestHangSec) and one it
        # cannot (-TestBlockSec, like a PowerPoint call blocked by a dialog). Both exercise exitCode 2.
        [double]$TestHangSec = 0,
        [double]$TestBlockSec = 0,
        # Run the action only in a PowerPoint instance this run started; see the module description.
        [switch]$RequireOwned,
        # Test hook only: skip the check made before the job starts, so that a test can reach the check inside the
        # job (the one that also catches a PowerPoint that started in between) with a PowerPoint already running.
        [switch]$TestSkipOwnershipPrecheck,
        # Test hook only: the job fails with PowerPoint's busy refusal (RPC_E_CALL_REJECTED) before it touches PowerPoint.
        [switch]$TestBusy
    )
    $ErrorActionPreference = 'Stop'
    $ok = $false
    $skipped = $false
    $busy = $false
    $leftRunning = $false
    $exitCode = 3
    $message = ''
    $result = $null
    $ownedPid = $null
    $copyPath = $null
    $job = $null
    $jobFinished = $true
    $stopRequested = $false
    $pidsBefore = $null
    $mutex = $null
    $mutexHeld = $false
    try {
        try {
            $parsed = [scriptblock]::Create($Action)
            if ($null -eq $parsed.Ast.ParamBlock -or $parsed.Ast.ParamBlock.Parameters.Count -ne 3) {
                throw 'the action must start with param($pres, $app, $args)'
            }
            $forbidden = [regex]::Match($Action, $script:ForbiddenInAction)
            if ($forbidden.Success) {
                throw "the action may work only on the copy it is given (no other presentations or windows, no Close or Quit, no attaching): found '$($forbidden.Value)'"
            }
            if (-not $RequireOwned) {
                $shared = [regex]::Match($Action, $script:ForbiddenUnlessOwned)
                if ($shared.Success) {
                    throw "the action may change state shared by the whole PowerPoint application (found '$($shared.Value)'); that needs -RequireOwned"
                }
            }
            $pptxPath = Resolve-DeckbackPath $Pptx
            if (-not (Test-Path -LiteralPath $pptxPath -PathType Leaf)) { throw "file not found: $pptxPath" }
            $explicitTimeout = $PSBoundParameters.ContainsKey('TimeoutSec')
            if ($explicitTimeout -and $TimeoutSec -lt 1) { throw "TimeoutSec must be at least 1 (got $TimeoutSec)" }

            # Never open the input itself: a GUID-named copy cannot be a document the author has open.
            $copyPath = Join-Path ([IO.Path]::GetTempPath()) ('{0}{1}.pptx' -f $script:CopyPrefix, [guid]::NewGuid().ToString('N'))
            try { Copy-Item -LiteralPath $pptxPath -Destination $copyPath -ErrorAction Stop }
            catch { throw "cannot copy $pptxPath : $($_.Exception.Message)" }
            if (-not $explicitTimeout) {
                try { $TimeoutSec = Get-DeckbackTimeout -SlideCount (Get-PptxSlideCount -Pptx $copyPath) }
                catch { $TimeoutSec = Get-DeckbackTimeout -SlideCount 0 }
            }

            # One run at a time. A holder that died leaves the mutex abandoned; then it is ours.
            $mutex = New-Object Threading.Mutex($false, $script:MutexName)
            $lockDeadline = (Get-Date).AddSeconds($TimeoutSec)
            while (-not $mutexHeld) {
                try { $mutexHeld = $mutex.WaitOne(500) }
                catch {
                    if ($_.Exception -is [Threading.AbandonedMutexException] -or $_.Exception.InnerException -is [Threading.AbandonedMutexException]) { $mutexHeld = $true }
                    else { throw }
                }
                if (-not $mutexHeld -and (Get-Date) -ge $lockDeadline) {
                    throw "another deckback PowerPoint run did not finish within $TimeoutSec s (lock $($script:MutexName)); PowerPoint was not touched"
                }
            }

            # Record this BEFORE anything attaches to PowerPoint.
            $pidsBefore = @(Get-DeckbackPowerPointPids)
            $wasRunning = $pidsBefore.Count -gt 0
            # -RequireOwned: with a POWERPNT process around nothing is attached to, opened or run. (The job checks again
            # right after its own attach, which also catches a PowerPoint that started since this snapshot.)
            $skipBefore = $RequireOwned -and -not $TestSkipOwnershipPrecheck -and $pidsBefore.Count -gt 0
            $jobFinished = $true
            if (-not $skipBefore) {
                $jobFinished = $false
                $inheritable = Disable-DeckbackHandleInheritance
                try {
                    $job = Start-Job -ScriptBlock $script:JobScript -ArgumentList $script:ModulePath, $copyPath, $Action, $ActionArgs, $wasRunning, $TestHangSec, $TestBlockSec, ([bool]$RequireOwned), ([bool]$TestBusy)
                }
                finally { Restore-DeckbackHandleInheritance $inheritable }
            }

            if ($skipBefore) {
                $skipped = $true
                $exitCode = 4
                $message = $script:SkipMessage
            }
            elseif ($null -eq (Wait-Job -Job $job -Timeout $TimeoutSec)) {
                $exitCode = 2
                $stopRequested = $true
                $jobFinished = Request-DeckbackJobStop $job 5
                $message = "timeout after $TimeoutSec s (possible repair or modal dialog in PowerPoint); no PowerPoint process was stopped or killed by this script."
                if ($jobFinished) {
                    # The stopped job closed its copy and quit only an instance it started; Quit() is asynchronous.
                    $deadline = (Get-Date).AddSeconds(15)
                    while (@(Get-DeckbackNewPids $pidsBefore).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
                }
                else {
                    $message += ' The PowerPoint job did not stop within 5 s (a PowerPoint call is still blocked); it is left alone.'
                }
                $left = @(Get-DeckbackNewPids $pidsBefore)
                if ($left.Count -gt 0) {
                    $message += " New PowerPoint process id(s) $($left -join ',') appeared during the run; if this script started it, close it by hand (see harness/README.md)."
                }
                elseif (-not $jobFinished) {
                    $message += " If the job got as far as opening the temp copy, a read-only, windowless presentation named $([IO.Path]::GetFileName($copyPath)) may still be open in PowerPoint (see harness/README.md)."
                }
            }
            else {
                $jobFinished = $true
                $received = @(Receive-Job -Job $job -ErrorAction SilentlyContinue) | Where-Object { $null -ne $_ }
                $record = $received | Where-Object { $null -ne $_.PSObject.Properties['deckbackJob'] } | Select-Object -Last 1
                $leftRecord = $received | Where-Object { $null -ne $_.PSObject.Properties['deckbackLeftRunning'] } | Select-Object -Last 1
                $jobState = $job.State
                $jobReason = ''
                if ($job.ChildJobs.Count -gt 0 -and $null -ne $job.ChildJobs[0].JobStateInfo.Reason) {
                    $jobReason = $job.ChildJobs[0].JobStateInfo.Reason.Message
                }
                $warning = ''
                if ($null -ne $record -and $null -ne $record.ownedPid) { $ownedPid = [int]$record.ownedPid }
                if ($null -ne $leftRecord) {
                    # Disconnect did not quit the instance this run started: someone may be using it (M1-R73).
                    $leftRunning = $true
                    $warning = "WARNING: $($leftRecord.message) (see harness/README.md)."
                }
                elseif ($null -ne $ownedPid) {
                    # Quit() is asynchronous. If the instance this run started is still there after a grace
                    # period, report it; never end it.
                    if (-not (Wait-DeckbackPidGone $ownedPid 15)) {
                        $warning = "WARNING: the PowerPoint instance this script started (process id $ownedPid) is still running; not killed (see harness/README.md)."
                    }
                }
                if ($null -eq $record) { $message = "PowerPoint job ended in state $jobState without a result. $jobReason".Trim() }
                elseif ($null -ne $record.PSObject.Properties['skipped'] -and $record.skipped) { $skipped = $true; $exitCode = 4; $message = "$($record.error)" }
                elseif (-not $record.ok) {
                    $message = "$($record.error)"
                    if ($null -ne $record.PSObject.Properties['busy'] -and $record.busy) {
                        # M1-R74: not a fault of the deck; the caller records powerpoint-busy.
                        $busy = $true
                        $message = "PowerPoint is busy and refused the call (a dialog open in PowerPoint?): $message"
                    }
                }
                else { $ok = $true; $exitCode = 0; $result = $record.result }
                if ($warning) { $message = ("$message $warning").Trim() }
            }
        }
        catch {
            $ok = $false
            $exitCode = 3
            $message = $_.Exception.Message
        }
    }
    finally {
        if ($null -ne $job) {
            if (-not $jobFinished -and -not $stopRequested) { $jobFinished = Request-DeckbackJobStop $job 5 }
            # Remove-Job would wait for a job that cannot stop; such a job is left alone.
            if ($jobFinished) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
        }
        if ($null -ne $copyPath) {
            $copyWait = 0
            if ($jobFinished) { $copyWait = 5 }
            if (-not (Remove-DeckbackCopy $copyPath $copyWait)) {
                $message = ("$message could not delete the temp copy (still open in PowerPoint?): $copyPath").Trim()
            }
        }
        if ($null -ne $mutex) {
            if ($mutexHeld) { try { $mutex.ReleaseMutex() } catch { } }
            $mutex.Dispose()
        }
    }
    $newPids = @()
    if ($null -ne $pidsBefore) { $newPids = @(Get-DeckbackNewPids $pidsBefore) }
    [pscustomobject]@{
        ok = $ok; exitCode = $exitCode; message = $message; result = $result
        newPids = $newPids; ownedPid = $ownedPid; stuck = -not $jobFinished; skipped = $skipped
        busy = $busy; leftRunning = $leftRunning
    }
}

Export-ModuleMember -Function Get-PptxSlideCount, Get-DeckbackTimeout, Invoke-DeckbackPowerPoint,
    Invoke-DeckbackChildProcess, Connect-DeckbackPowerPoint, Disconnect-DeckbackPowerPoint
