<#
.SYNOPSIS
  Tests for harness/ppt/DeckbackCom.psm1, the one module through which every harness script drives
  PowerPoint. The author may be working in PowerPoint, with unsaved documents, while the harness runs.

.DESCRIPTION
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test_com_module.ps1 [-TimeoutSec 300]
  Prints COM MODULE TESTS OK and exits 0 when every check holds. Exit codes: 0 ok, 1 failed, 2 timeout.

  Cases (letters as in the plan):
    (d) Static guard over every *.ps1, *.psm1 and *.py under harness/ (PowerShell comments and Python comment lines
        are skipped; strings, so action here-strings, are not):
          - nothing ends a process: kill, spps, Stop-Process, taskkill, pskill, .Kill(, .Terminate(,
            Invoke-CimMethod/Invoke-WmiMethod ... Terminate, wmic ... terminate, TerminateProcess;
          - outside the module nothing attaches to a COM server another way (GetActiveObject, GetTypeFromProgID,
            Activator]::CreateInstance, CreateObject/GetObject of PowerPoint, win32com/comtypes next to PowerPoint)
            and nothing names the PowerPoint.Application ProgID;
          - Connect-/Disconnect-DeckbackPowerPoint appear only in the module and the three tests that play the
            author (this one, test_render_safety.ps1, harness/spikes/test_m0_7_make_deck.ps1);
          - Quit() is called in one place only (ruling M1-R73): once, in the module's Disconnect-DeckbackPowerPoint,
            inside "if ($signs.Count -eq 0)" after "$signs = @(Get-DeckbackAuthorSigns ...)", and
            Get-DeckbackAuthorSigns reads Presentations, Windows, ProtectedViewWindows, Visible and UserControl.
        A self-test feeds the guard a scratch tree with one violation per file and two clean files, and scratch
        modules whose Quit() is unguarded, outside Disconnect, or guarded by a check that skips a sign.
    (c) Without PowerPoint: Get-PptxSlideCount on a 3-slide python-pptx deck returns 3; Get-DeckbackTimeout is
        Base + PerSlide x SlideCount. Invoke-DeckbackPowerPoint returns exitCode 3 for a missing file, a malformed
        action and an action that reaches beyond its copy (ActivePresentation, ActiveWindow, .Presentations,
        .Windows, .Quit(, .Close( ); exitCode 2 for a hang a stop can interrupt and, with stuck = $true and well
        before the hang ends, for one it cannot (as in a PowerPoint call blocked by a dialog). The stuck job ends
        by itself when its call returns and never reaches PowerPoint. -Embedding counts only as a switch of its
        own. While another process holds the lock Global\deckback-powerpoint a run waits, then gives up with
        exitCode 3, or goes on once the lock is free. None of these starts PowerPoint or leaves a temp copy.
        Get-DeckbackAuthorSigns (M1-R73) names each sign of use on stand-in application objects: a presentation,
        a document window, a Protected View window, Visible, UserControl, and a property it cannot read; it names
        none on an idle hidden instance. A refusal because PowerPoint is busy (RPC_E_CALL_REJECTED 0x80010001,
        RPC_E_SERVERCALL_RETRYLATER 0x8001010A, also wrapped) is told apart from other COM errors, and a run
        refused that way (test hook) is exitCode 3 with busy = $true (M1-R74).
    Then, in a Start-Job under a timeout:
    (own) Only when no PowerPoint is running: a run starts its own PowerPoint, proves it by process id
        (ownedPid) and quits it; no POWERPNT process is left. A -RequireOwned run goes the same way, and its
        action may name ActivePrinter (without -RequireOwned an action that names it is rejected, exitCode 3).
    (a) The author's session: attaches to (or starts) PowerPoint, adds an untitled, unsaved presentation with
        a window and opens the very input file the module is given (edited, unsaved, with a window). After a
        successful run and after a forced error run (the action throws) both are still open, unsaved and
        unchanged; the presentation and window counts and the POWERPNT processes are the same; the input file
        is byte-identical; no temp copy is left. A -RequireOwned run with that PowerPoint around is skipped
        (exitCode 4, skipped) both before the job starts and, with the pre-check disabled by a test hook, inside
        the job right after its attach: the action does not run (it would write a marker file) and the session
        stays as it was.
    (b) A -TimeoutSec 5 run whose action sleeps 30 s returns exitCode 2 well before the 30 s; the checks of
        (a) hold afterwards, so nothing was killed or closed, and no temp copy is left.
    (e) A child process started from an action with Invoke-DeckbackChildProcess has its own stdin, stdout and
        stderr: a child that reads stdin to the end returns at once.
    (f) Only when no PowerPoint is running: Disconnect-DeckbackPowerPoint and an instance this test started
        (ruling M1-R73). A hidden instance with nothing open is quit, and a session object that
        Connect-DeckbackPowerPoint did not return (even one carrying the real application and process id) is
        ignored. An instance that shows a sign of the author is left running and the reason is logged
        (session.leftRunning): the start screen (Visible, nothing open: the author opened PowerPoint from the Start
        menu and it joined this instance), a scratch deck open with a document window, and a scratch deck open in
        Protected View (an e-mailed .pptx). A run whose action makes its own instance visible returns ok with
        leftRunning = $true and the reason in its message, and its PowerPoint keeps running.
  The test closes only what it opened, without saving. It never stops or kills a PowerPoint process and never
  calls Quit() itself. An instance it started and made visible (its windows, its start-screen stand-in) is left
  running by Disconnect (M1-R73); the test then ends it the way the author would: it opens its own scratch deck
  in Protected View in that instance, releases the application and closes that window. Measured on PowerPoint 16
  (2026-11-05): an instance whose last window, a Protected View window, closes while nothing holds it ends by
  itself; one whose last window was a document window does not. The test checks that the process is gone.
#>
param([int]$TimeoutSec = 300)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$modulePath = Join-Path $PSScriptRoot 'DeckbackCom.psm1'
$python = Join-Path $root 'harness\.venv\Scripts\python.exe'
$work = Join-Path $root 'out\m1\com-module'
$failures = New-Object System.Collections.Generic.List[string]

function Check([string]$Name, [bool]$Ok) {
    Write-Output ('{0,-78} {1}' -f $Name, $(if ($Ok) { 'ok' } else { 'FAIL' }))
    if (-not $Ok) { $failures.Add($Name) }
}
function Stop-Failed([string]$Message) {
    Write-Output "COM MODULE TESTS FAILED: $Message"
    exit 1
}
function Get-PowerPointPids { @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Get-TempCopies { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'deckback-com-*.pptx' -ErrorAction SilentlyContinue) }

if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { Stop-Failed 'the module is missing: harness/ppt/DeckbackCom.psm1' }
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { Stop-Failed 'the harness venv is missing (see harness/README.md)' }
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ---- (d) Static guard --------------------------------------------------------------------------------------------
# The patterns are put together from pieces so that this file, which is scanned too, does not match them itself.
$kw = 'ki' + 'll'
$tm = 'Termi' + 'nate'
$sp = 'Stop-Pro' + 'cess'
$pp = 'Power' + 'Point'
$aliasSp = 'sp' + 'ps'
$wmTool = 'wm' + 'ic'
$gao = 'Get' + 'ActiveObject'
$gtp = 'GetTypeFrom' + 'ProgID'
$aci = 'Activator\]::' + 'CreateInstance'
$w32 = 'win' + '32com'
$ctypes = 'com' + 'types'
# (Variables, not "a" + "b" inside @( ): in an array literal the comma binds before +.)
$endRxPs = @(
    "(?i)(?<![\w-])($kw|$aliasSp|$sp|task$kw|ps$kw|ts$kw)(?![\w-])",
    "(?i)\.\s*($kw|$tm)\s*\(",
    "(?i)Invoke-(Cim|Wmi)Method\b[^\r\n]*\b$tm\b",
    "(?i)\b$wmTool\b[^\r\n]*\b($tm|delete)\b",
    "(?i)${tm}Process"
)
$endRxPy = @(
    "(?i)(?<![\w.])$kw\s*\(",
    "(?i)\.\s*($kw|$tm)\s*\(",
    "(?i)(?<![\w-])(task$kw|ps$kw|ts$kw|$aliasSp|$sp)(?![\w-])",
    "(?i)Invoke-(Cim|Wmi)Method\b[^\r\n]*\b$tm\b",
    "(?i)${tm}Process"
)
$attachRx = @(
    "(?i)$gao",
    "(?i)$gtp",
    "(?i)$aci",
    "(?i)\b(Create|Get)Object\s*\(\s*['""]$pp"
)
# A Python COM library imported or used (import / from ... import, or an attribute of it), not merely named: a list of
# packages that must stay out of CI's requirements names them as strings (harness/test_requirements_ci.py).
$comLibRx = "(?im)^\s*(import|from)\s+($w32|$ctypes)\b|\b($w32|$ctypes)\s*\.\s*\w"
$progIdRx = "(?i)$pp\s*\.\s*Application"
$connectRx = "(?i)\b(Connect|Disconnect)-Deckback$pp\b"
$qt = 'Qu' + 'it'
$quitRxPs = "(?i)\.\s*$qt\s*\("
$quitRxPy = "\.\s*$qt\s*\("
$moduleRel = 'harness\ppt\DeckbackCom.psm1'
$connectAllowed = @($moduleRel, 'harness\ppt\test_com_module.ps1', 'harness\ppt\test_render_safety.ps1', 'harness\spikes\test_m0_7_make_deck.ps1')
# What Get-DeckbackAuthorSigns must read before Disconnect may quit an instance (ruling M1-R73).
$authorSigns = @('Presentations', 'Windows', 'ProtectedViewWindows', 'Visible', 'UserControl')

# Code text: PowerShell comment tokens and Python comment lines removed; strings (action here-strings) kept.
function Get-CodeText([string]$Path) {
    $text = [IO.File]::ReadAllText($Path)
    if ($Path -like '*.py') { return [regex]::Replace($text, '(?m)^[ \t]*#.*$', '') }
    $errors = $null
    $tokens = [System.Management.Automation.PSParser]::Tokenize($text, [ref]$errors)
    $sb = New-Object System.Text.StringBuilder
    $pos = 0
    foreach ($t in $tokens) {
        if ($t.Type -ne 'Comment') { continue }
        [void]$sb.Append($text, $pos, $t.Start - $pos)
        [void]$sb.Append(' ')
        $pos = $t.Start + $t.Length
    }
    [void]$sb.Append($text, $pos, $text.Length - $pos)
    $sb.ToString()
}

# Ruling M1-R73: the module calls Quit() once, in Disconnect-DeckbackPowerPoint, inside "if ($signs.Count -eq 0)"
# after "$signs = @(Get-DeckbackAuthorSigns ...)" in that function, and Get-DeckbackAuthorSigns reads every sign of the
# author ($authorSigns). Read from the module's syntax tree; $Code is its text without comments, in which a Quit() call
# inside a string (a script block made from text) is counted too.
function Get-ModuleQuitProblems([string]$Path, [string]$Code) {
    $problems = New-Object System.Collections.Generic.List[string]
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Path), [ref]$tokens, [ref]$errors)
    $functions = @{}
    foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f }
    $calls = @($ast.FindAll({ param($n)
                $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                $n.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Member.Value -ieq $qt }, $true))
    $inText = [regex]::Matches($Code, $quitRxPs).Count
    if ($calls.Count -ne 1 -or $inText -ne 1) { $problems.Add("$($calls.Count) $qt() call(s), $inText in the code text (exactly one, in Disconnect-DeckbackPowerPoint)") }
    $signs = $functions['Get-DeckbackAuthorSigns']
    if ($null -eq $signs) { $problems.Add('no function Get-DeckbackAuthorSigns') }
    else {
        foreach ($name in $authorSigns) {
            if ($signs.Body.Extent.Text -notmatch "\b$name\b") { $problems.Add("Get-DeckbackAuthorSigns does not read $name") }
        }
    }
    $disconnect = $functions['Disconnect-DeckbackPowerPoint']
    foreach ($call in $calls) {
        $line = $call.Extent.StartLineNumber
        if ($null -eq $disconnect -or $call.Extent.StartOffset -lt $disconnect.Extent.StartOffset -or $call.Extent.EndOffset -gt $disconnect.Extent.EndOffset) {
            $problems.Add("$qt() outside Disconnect-DeckbackPowerPoint (line $line)")
            continue
        }
        $guarded = $false
        for ($p = $call.Parent; $null -ne $p -and -not [object]::ReferenceEquals($p, $disconnect); $p = $p.Parent) {
            if ($p -isnot [System.Management.Automation.Language.IfStatementAst]) { continue }
            foreach ($clause in $p.Clauses) {
                if ($clause.Item1.Extent.Text -match '^\$signs\.Count\s+-eq\s+0$' -and
                    $clause.Item2.Extent.StartOffset -le $call.Extent.StartOffset -and $call.Extent.EndOffset -le $clause.Item2.Extent.EndOffset) { $guarded = $true }
            }
        }
        $assigned = @($disconnect.FindAll({ param($n)
                    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ieq '$signs' -and
                    $n.Right.Extent.Text -match '^@\(Get-DeckbackAuthorSigns\b' }, $true) |
                Where-Object { $_.Extent.EndOffset -le $call.Extent.StartOffset })
        if (-not $guarded -or $assigned.Count -eq 0) { $problems.Add("$qt() (line $line) is not inside 'if (`$signs.Count -eq 0)' after '`$signs = @(Get-DeckbackAuthorSigns ...)'") }
    }
    , $problems.ToArray()
}

function Get-GuardViolations([string]$TreeRoot) {
    $found = New-Object System.Collections.Generic.List[string]
    # Filtered by extension here: -Include with -LiteralPath also lets other files through on Windows PowerShell 5.1.
    $files = @(Get-ChildItem -LiteralPath (Join-Path $TreeRoot 'harness') -Recurse -File |
        Where-Object { @('.ps1', '.psm1', '.py') -contains $_.Extension.ToLowerInvariant() -and $_.FullName -notmatch '\\(\.venv|__pycache__)\\' })
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($TreeRoot.Length).TrimStart('\')
        $code = Get-CodeText $f.FullName
        $endRx = $endRxPs
        if ($f.Extension -ieq '.py') { $endRx = $endRxPy }
        foreach ($rx in $endRx) {
            $m = [regex]::Match($code, $rx)
            if ($m.Success) { $found.Add("${rel}: ends a process ('$($m.Value)')") }
        }
        if ($rel -ne $moduleRel) {
            foreach ($rx in $attachRx) {
                $m = [regex]::Match($code, $rx)
                if ($m.Success) { $found.Add("${rel}: attaches to a COM server outside the module ('$($m.Value)')") }
            }
            if ($code -match $comLibRx -and $code -match "(?i)$pp") { $found.Add("${rel}: uses a Python COM library next to $pp") }
            $m = [regex]::Match($code, $progIdRx)
            if ($m.Success) { $found.Add("${rel}: names the $pp ProgID outside the module ('$($m.Value)')") }
        }
        if ($connectAllowed -notcontains $rel) {
            $m = [regex]::Match($code, $connectRx)
            if ($m.Success) { $found.Add("${rel}: uses $($m.Value) (only the module and the author-session tests may)") }
        }
        if ($rel -eq $moduleRel) {
            foreach ($problem in (Get-ModuleQuitProblems $f.FullName $code)) { $found.Add("${rel}: $problem") }
        }
        else {
            $quitRx = $quitRxPs
            if ($f.Extension -ieq '.py') { $quitRx = $quitRxPy }
            $m = [regex]::Match($code, $quitRx)
            if ($m.Success) { $found.Add("${rel}: quits PowerPoint outside the module's Disconnect ('$($m.Value)')") }
        }
    }
    , $found.ToArray()
}

# Self-test of the guard: one violation per file in a scratch tree, plus two clean files.
$guardTree = Join-Path $work 'guard-selftest'
Remove-Item -LiteralPath $guardTree -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $guardTree 'harness\x') | Out-Null
$nl = "`r`n"
$bad = [ordered]@{
    'end-cmdlet.ps1'   = "$sp -Name POWERPNT"
    'end-alias.ps1'    = "$kw 1234"
    'end-spps.ps1'     = 'sp' + 'ps -Id 1'
    'end-exe.ps1'      = "task$kw /im POWERPNT.EXE"
    'end-method.ps1'   = "`$p = Get-Process -Id 1$nl`$p.Ki" + 'll()'
    'end-cim.ps1'      = "Invoke-CimMethod -InputObject `$p -MethodName $tm"
    'end-action.ps1'   = "`$action = @'${nl}param(`$pres, `$app, `$args)$nl$sp -Id 1$nl'@"
    'attach-gao.ps1'   = "[Runtime.InteropServices.Marshal]::Get" + "ActiveObject('x')"
    'attach-act.ps1'   = "[Activator]::" + "CreateInstance([Type]::GetTypeFrom" + "ProgID('x'))"
    'attach-new.ps1'   = "New-Object -ComObject $pp.Application"
    'connect.ps1'      = "`$s = Connect-Deckback$pp"
    'py-dispatch.py'   = "import win" + "32com.client${nl}app = win" + "32com.client.Dispatch('$pp.Application')"
    'py-method.py'     = "import subprocess${nl}proc = subprocess.Popen(['x'])${nl}proc.$kw()"
    'py-os.py'         = "import os${nl}os.$kw(1, 9)"
    'py-comlib.py'     = "from $ctypes import client${nl}app = client.CreateObject(APP)${nl}APP = '$pp'"
    'quit-ps.ps1'      = "`$app = `$session.app$nl`$app.$qt()"
    'quit-action.ps1'  = "`$action = 'param(`$pres, `$app, `$args) `$app.$qt()'"
    'quit-py.py'       = "app = get_app()${nl}app.$qt()"
}
$clean = [ordered]@{
    'clean.ps1' = "# never $kw anything; $sp, task$kw and `$app.$qt() are forbidden here${nl}Write-Output 'it was not ${kw}ed'"
    'clean.py'  = "# os.$kw( and .$tm( and app.$qt() are forbidden here${nl}print('not ${kw}ed')"
    'clean-names.py' = "`"`"`"No $pp pieces on CI.`"`"`"${nl}PIECES = {`"py$w32`", `"$ctypes`"}${nl}assert not set(ci) & PIECES"
}
foreach ($k in $bad.Keys) { [IO.File]::WriteAllText((Join-Path $guardTree "harness\x\$k"), $bad[$k]) }
foreach ($k in $clean.Keys) { [IO.File]::WriteAllText((Join-Path $guardTree "harness\x\$k"), $clean[$k]) }
$selfTest = Get-GuardViolations $guardTree
$missed = @($bad.Keys | Where-Object { $n = "harness\x\$_"; -not ($selfTest | Where-Object { $_.StartsWith("${n}:") }) })
$falseHits = @($selfTest | Where-Object { $_ -like 'harness\x\clean*' })
Check "(d) guard self-test: all $($bad.Count) planted violations found (missed: $($missed -join ', '))" ($missed.Count -eq 0)
Check "(d) guard self-test: comments and prose are not flagged ($($falseHits -join '; '))" ($falseHits.Count -eq 0)
Remove-Item -LiteralPath $guardTree -Recurse -Force -ErrorAction SilentlyContinue

# Self-test of the Quit() rule (M1-R73): scratch modules, each with one way to get it wrong, and one that is right.
$signsFn = "function Get-DeckbackAuthorSigns(`$App) { @(`$App.Presentations.Count, `$App.Windows.Count, `$App.ProtectedViewWindows.Count, `$App.Visible, `$App.UserControl) }"
$guardedQuit = "function Disconnect-DeckbackPowerPoint(`$app) {$nl    `$signs = @(Get-DeckbackAuthorSigns `$app)$nl    if (`$signs.Count -eq 0) { `$app.$qt() }$nl}"
$modules = [ordered]@{
    'right'           = "$signsFn$nl$guardedQuit"
    'unguarded'       = "$signsFn${nl}function Disconnect-DeckbackPowerPoint(`$app) { `$app.$qt() }"
    'outside'         = "$signsFn$nl$guardedQuit${nl}function Close-All(`$app) { `$app.$qt() }"
    'in-a-string'     = "$signsFn$nl$guardedQuit${nl}function Close-All(`$app) { & ([scriptblock]::Create('param(`$a) `$a.$qt()')) `$app }"
    'skips-a-sign'    = ($signsFn -replace ', \$App\.ProtectedViewWindows\.Count', '') + "$nl$guardedQuit"
    'checked-earlier' = "$signsFn${nl}function Disconnect-DeckbackPowerPoint(`$app) {$nl    if (`$signs.Count -eq 0) { `$app.$qt() }$nl    `$signs = @(Get-DeckbackAuthorSigns `$app)$nl}"
}
$quitSelfTest = [ordered]@{}
foreach ($k in $modules.Keys) {
    New-Item -ItemType Directory -Force -Path (Join-Path $guardTree 'harness\ppt') | Out-Null
    $modulePathScratch = Join-Path $guardTree $moduleRel
    [IO.File]::WriteAllText($modulePathScratch, $modules[$k])
    $problems = Get-ModuleQuitProblems $modulePathScratch (Get-CodeText $modulePathScratch)
    $quitSelfTest[$k] = @($problems)
    Remove-Item -LiteralPath $guardTree -Recurse -Force -ErrorAction SilentlyContinue
}
Check "(d) guard self-test: a Quit() guarded by every sign of the author passes ($($quitSelfTest['right'] -join '; '))" ($quitSelfTest['right'].Count -eq 0)
foreach ($k in @($modules.Keys | Where-Object { $_ -ne 'right' })) {
    Check "(d) guard self-test: a module whose Quit() is '$k' is flagged ($($quitSelfTest[$k] -join '; '))" ($quitSelfTest[$k].Count -gt 0)
}

$violations = Get-GuardViolations $root
foreach ($v in $violations) { Write-Output "  guard: $v" }
Check "(d) static guard over harness/**/*.ps1, *.psm1, *.py: $($violations.Count) violation(s)" ($violations.Count -eq 0)

# ---- (c) Without PowerPoint --------------------------------------------------------------------------------------
$deck = Join-Path $work 'three.pptx'
& $python -I -c 'import sys; from pptx import Presentation; p = Presentation(); [p.slides.add_slide(p.slide_layouts[6]) for _ in range(3)]; p.save(sys.argv[1])' $deck
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $deck)) { Stop-Failed 'could not build the 3-slide deck with python-pptx' }

Import-Module -Name $modulePath -Force
Check '(c) Get-PptxSlideCount: the 3-slide python-pptx deck has 3 slides' ((Get-PptxSlideCount -Pptx $deck) -eq 3)
Check 'Get-DeckbackTimeout: 120 + 4 x 3 = 132' ((Get-DeckbackTimeout -SlideCount 3) -eq 132)
Check 'Get-DeckbackTimeout: 10 + 2 x 5 = 20' ((Get-DeckbackTimeout -SlideCount 5 -BaseSec 10 -PerSlideSec 2) -eq 20)
$notDeck = Join-Path $work 'not-a-deck.pptx'
Set-Content -LiteralPath $notDeck -Value 'not a zip'
$threw = $false
try { [void](Get-PptxSlideCount -Pptx $notDeck) } catch { $threw = $true }
Check 'Get-PptxSlideCount: a file that is not a pptx throws' $threw

$embedding = & (Get-Module DeckbackCom) {
    @(
        (Test-DeckbackEmbeddingSwitch '"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE" /AUTOMATION -Embedding'),
        (Test-DeckbackEmbeddingSwitch 'POWERPNT.EXE /Embedding'),
        (Test-DeckbackEmbeddingSwitch '"C:\x\POWERPNT.EXE" "C:\docs\a -Embedding b.pptx"'),
        (Test-DeckbackEmbeddingSwitch '"C:\a -Embedding\POWERPNT.EXE" /n'),
        (Test-DeckbackEmbeddingSwitch 'POWERPNT.EXE C:\docs\x-Embedding.pptx')
    )
}
Check '-Embedding counts only as a switch of its own (not in a path, a quoted argument or a word)' (($embedding -join ',') -eq 'True,True,False,False,False')

# Ruling M1-R73: every sign that someone may be using the instance, on stand-in application objects (PowerPoint's own
# Application has no UserControl property; Word's and Excel's do, so it counts when it is there).
$signCases = [ordered]@{
    'idle hidden instance'      = @{ app = @{}; want = '' }
    'a presentation open'       = @{ app = @{ Pres = 1 }; want = 'Presentations.Count 1' }
    'a document window'         = @{ app = @{ Win = 2 }; want = 'Windows.Count 2' }
    'a Protected View window'   = @{ app = @{ Pv = 1 }; want = 'ProtectedViewWindows.Count 1' }
    'visible (msoTrue)'         = @{ app = @{ Visible = -1 }; want = 'Visible' }
    'visible (true)'            = @{ app = @{ Visible = $true }; want = 'Visible' }
    'UserControl true'          = @{ app = @{ UserControl = $true }; want = 'UserControl' }
    'UserControl false'         = @{ app = @{ UserControl = $false }; want = '' }
    'Windows cannot be read'    = @{ app = @{ BrokenWindows = $true }; want = 'Windows unreadable' }
    'Windows.Count cannot be read' = @{ app = @{ BrokenWindowsCount = $true }; want = 'Windows unreadable' }
    'Windows.Count not a number'   = @{ app = @{ WindowsCountText = $true }; want = 'Windows unreadable' }
    'Visible missing'           = @{ app = @{ Visible = $null }; want = 'Visible unreadable' }
    'Visible not a number'      = @{ app = @{ Visible = 'yes' }; want = 'Visible unreadable' }
    'everything'                = @{ app = @{ Pres = 1; Win = 1; Pv = 1; Visible = -1; UserControl = $true }; want = 'Presentations.Count 1|Windows.Count 1|ProtectedViewWindows.Count 1|Visible|UserControl' }
}
$signsOf = {
    param($Spec)
    $count = { param($n) [pscustomobject]@{ Count = $n } }
    $visible = 0
    if ($Spec.ContainsKey('Visible')) { $visible = $Spec.Visible }
    $app = [pscustomobject]@{ Presentations = (& $count ([int]$Spec.Pres)); Windows = (& $count ([int]$Spec.Win)); ProtectedViewWindows = (& $count ([int]$Spec.Pv)); Visible = $visible }
    if ($Spec.ContainsKey('UserControl')) { $app | Add-Member -NotePropertyName UserControl -NotePropertyValue $Spec.UserControl }
    if ($Spec.BrokenWindows) { $app | Add-Member -MemberType ScriptProperty -Name Windows -Value { throw 'The RPC server is unavailable.' } -Force }
    if ($Spec.BrokenWindowsCount) {
        $windows = [pscustomobject]@{}
        $windows | Add-Member -MemberType ScriptProperty -Name Count -Value { throw 'The RPC server is unavailable.' }
        $app.Windows = $windows
    }
    if ($Spec.WindowsCountText) { $app.Windows = [pscustomobject]@{ Count = 'many' } }
    try { (@(& (Get-Module DeckbackCom) { param($a) Get-DeckbackAuthorSigns $a } $app)) -join '|' }
    catch { "threw: $($_.Exception.Message)" }
}
foreach ($case in $signCases.Keys) {
    $got = & $signsOf $signCases[$case].app
    Check "(c) Get-DeckbackAuthorSigns, $case`: '$got'" ($got -ceq $signCases[$case].want)
}

# Ruling M1-R74: PowerPoint refusing a call because it is busy (a dialog is open) is told apart from other COM errors.
$busyCases = [ordered]@{
    'RPC_E_CALL_REJECTED 0x80010001'         = @{ e = (New-Object Runtime.InteropServices.COMException('Call was rejected by callee.', -2147418111)); want = $true }
    'RPC_E_SERVERCALL_RETRYLATER 0x8001010A' = @{ e = (New-Object Runtime.InteropServices.COMException('The message filter indicated that the application is busy.', -2147417846)); want = $true }
    'wrapped in a MethodInvocationException' = @{ e = (New-Object Management.Automation.MethodInvocationException('Exception calling "Open"', (New-Object Runtime.InteropServices.COMException('Call was rejected by callee.', -2147418111)))); want = $true }
    'E_FAIL 0x80004005'                      = @{ e = (New-Object Runtime.InteropServices.COMException('PowerPoint could not open the file.', -2147467259)); want = $false }
    'not a COM error'                        = @{ e = (New-Object Management.Automation.RuntimeException('file not found')); want = $false }
}
foreach ($case in $busyCases.Keys) {
    try { $got = [bool](& (Get-Module DeckbackCom) { param($e) Test-DeckbackBusyError $e } $busyCases[$case].e) }
    catch { $got = "threw: $($_.Exception.Message)" }
    Check "(c) Test-DeckbackBusyError, $case`: $got" ($got -is [bool] -and $got -eq $busyCases[$case].want)
}

$pidsAtStart = Get-PowerPointPids
$copiesAtStart = (Get-TempCopies).Count
$r = Invoke-DeckbackPowerPoint -Pptx (Join-Path $work 'does-not-exist.pptx') -Action 'param($pres, $app, $args) 1'
Check "missing file: exitCode 3, ok false ($($r.exitCode): $($r.message))" ($r.exitCode -eq 3 -and -not $r.ok)
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres) 1'
Check "action without param(`$pres, `$app, `$args): exitCode 3 ($($r.message))" ($r.exitCode -eq 3 -and -not $r.ok)
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) {'
Check "action with a syntax error: exitCode 3 ($($r.message))" ($r.exitCode -eq 3 -and -not $r.ok)
foreach ($body in @('$app.ActivePresentation.Name', '$app.ActiveWindow.Caption', '$app.Presentations.Count',
        '$app.Windows.Count', "`$pres.Application.$qt()", '$pres.Close()')) {
    $r = Invoke-DeckbackPowerPoint -Pptx $deck -Action "param(`$pres, `$app, `$args) $body"
    Check "action reaching beyond its copy ($body): exitCode 3" ($r.exitCode -eq 3 -and "$($r.message)" -match 'may work only on the copy')
}
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) $app.ActivePrinter'
Check "action naming ActivePrinter without -RequireOwned: exitCode 3 ($($r.message))" ($r.exitCode -eq 3 -and -not $r.ok -and -not $r.skipped -and "$($r.message)" -match 'needs -RequireOwned')
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) 1' -TimeoutSec 2 -TestHangSec 60
$elapsed = $clock.Elapsed.TotalSeconds
Check "hang a stop can interrupt (test hook): exitCode 2 in $([int]$elapsed) s, not stuck" ($r.exitCode -eq 2 -and -not $r.ok -and -not $r.stuck -and $elapsed -lt 30)

# A hang a stop cannot interrupt (test hook: a blocking sleep, as in a PowerPoint call held by a dialog).
$jobsBefore = @(Get-Job | ForEach-Object { $_.Id })
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) 1' -TimeoutSec 2 -TestBlockSec 20
$elapsed = $clock.Elapsed.TotalSeconds
Check "blocked call (test hook): exitCode 2 and stuck in $([int]$elapsed) s, before the 20 s block ends" ($r.exitCode -eq 2 -and $r.stuck -and $elapsed -lt 15)
Check 'blocked call: the message says the job did not stop' ("$($r.message)" -match 'did not stop')
Check 'blocked call: no temp copy left' ((Get-TempCopies).Count -eq $copiesAtStart)
$stuckJobs = @(Get-Job | Where-Object { $jobsBefore -notcontains $_.Id })
if ($stuckJobs.Count -gt 0) { [void](Wait-Job -Job $stuckJobs -Timeout 40) }
Check "blocked call: the stuck job ended by itself once the call returned ($(($stuckJobs | ForEach-Object { $_.State }) -join ','))" (@($stuckJobs | Where-Object { $_.State -ne 'Stopped' -and $_.State -ne 'Completed' -and $_.State -ne 'Failed' }).Count -eq 0)
$stuckJobs | Remove-Job -Force -ErrorAction SilentlyContinue

# PowerPoint refuses the calls because it is busy (test hook: the job throws RPC_E_CALL_REJECTED before it attaches).
try { $r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) 1' -TestBusy }
catch { $r = [pscustomobject]@{ ok = $false; exitCode = -1; busy = $null; message = "threw: $($_.Exception.Message)" } }
Check "PowerPoint busy (test hook): exitCode 3, busy, not ok ($($r.exitCode): $($r.message))" ($r.exitCode -eq 3 -and $r.busy -eq $true -and -not $r.ok -and "$($r.message)" -match 'busy')
$r = Invoke-DeckbackPowerPoint -Pptx (Join-Path $work 'does-not-exist.pptx') -Action 'param($pres, $app, $args) 1'
Check "an error that is not a busy refusal: busy is false ($($r.busy))" ($r.exitCode -eq 3 -and $r.busy -eq $false)

# One run at a time: another process holds Global\deckback-powerpoint.
$heldFile = Join-Path $work 'lock-held.txt'
$releaseFile = Join-Path $work 'lock-release.txt'
function Start-LockHolder([double]$HoldSec) {
    Remove-Item -LiteralPath $heldFile, $releaseFile -Force -ErrorAction SilentlyContinue
    $holder = Start-Job -ArgumentList $heldFile, $releaseFile, $HoldSec -ScriptBlock {
        param($Held, $Release, $HoldSec)
        $m = New-Object Threading.Mutex($false, 'Global\deckback-powerpoint')
        try { [void]$m.WaitOne(30000) } catch [Threading.AbandonedMutexException] { }
        [IO.File]::WriteAllText($Held, 'held')
        $deadline = (Get-Date).AddSeconds($HoldSec)
        while (-not (Test-Path -LiteralPath $Release) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        $m.ReleaseMutex()
        $m.Dispose()
    }
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath $heldFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    return $holder
}
$holder = Start-LockHolder 60
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) 1' -TimeoutSec 3
$elapsed = $clock.Elapsed.TotalSeconds
Check "lock held elsewhere: waited $([math]::Round($elapsed, 1)) s, then exitCode 3 ($($r.message))" ($r.exitCode -eq 3 -and "$($r.message)" -match 'another deckback PowerPoint run' -and $elapsed -ge 2.5 -and $elapsed -lt 15)
Set-Content -LiteralPath $releaseFile -Value 'release'
[void](Wait-Job -Job $holder -Timeout 30)
Remove-Job -Job $holder -Force
$holder = Start-LockHolder 4
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-DeckbackPowerPoint -Pptx $deck -Action 'param($pres, $app, $args) 1' -TimeoutSec 10 -TestHangSec 60
$elapsed = $clock.Elapsed.TotalSeconds
Check "lock freed after 4 s: the run went on (then the hang hook timed out: exitCode $($r.exitCode)) after $([math]::Round($elapsed, 1)) s" ($r.exitCode -eq 2 -and $elapsed -ge 3)
[void](Wait-Job -Job $holder -Timeout 30)
Remove-Job -Job $holder -Force
Remove-Item -LiteralPath $heldFile, $releaseFile -Force -ErrorAction SilentlyContinue

Check 'these cases did not start PowerPoint' (((Get-PowerPointPids) -join ',') -eq ($pidsAtStart -join ','))
Check 'these cases left no temp copy' ((Get-TempCopies).Count -eq $copiesAtStart)

# ---- (own), (a), (b), (e): PowerPoint, in a job under a timeout -------------------------------------------------
$wasRunning = (Get-PowerPointPids).Count -gt 0
Write-Output "PowerPoint already running before the session checks: $wasRunning"

$job = Start-Job -ArgumentList $modulePath, $deck, $work, $wasRunning -ScriptBlock {
    param($ModulePath, $Deck, $Work, $WasRunning)
    $ErrorActionPreference = 'Stop'
    Import-Module -Name $ModulePath
    $log = New-Object System.Collections.Generic.List[string]
    $state = @{ failed = 0 }
    function Check([bool]$Ok, [string]$Message) {
        if ($Ok) { $log.Add("  ok: $Message") } else { $log.Add("  FAIL: $Message"); $state.failed++ }
    }
    function Get-PowerPointPids { @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
    function Get-TempCopies { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'deckback-com-*.pptx' -ErrorAction SilentlyContinue) }
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
    # Drop gives back one reference. Use it for objects fetched again from a collection: COM hands out the
    # same runtime wrapper for the same object, so a final release would also kill a wrapper held elsewhere.
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
    function Test-Alive([int]$TargetPid) { [bool](Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) }
    # Ends a PowerPoint this test started and made visible, which Disconnect leaves running (M1-R73), without Quit(): the
    # deck opens in Protected View in it, the application is released, and that window is closed. Measured on PowerPoint
    # 16 (2026-11-05): an instance whose last window, a Protected View window, closes while nothing holds it ends by
    # itself. Only when that process is the only POWERPNT process. Returns $true once it is gone.
    function Close-OwnVisibleInstance([int]$TargetPid, [string]$DeckPath) {
        if (-not (Test-Alive $TargetPid)) { return $true }
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
    # (f) A PowerPoint this test starts itself: no POWERPNT process at all may be running (not even the sandbox
    # process of a Protected View window that just closed), and the instance must be proved ours by process id.
    function Connect-OwnInstance([string]$Case) {
        if (-not (Wait-NoPowerPoint 20)) { throw "(f) ${Case}: POWERPNT process(es) $((Get-PowerPointPids) -join ',') still running; stopping here (nothing is killed)" }
        $s = Connect-DeckbackPowerPoint -WasRunning $false
        if ($null -eq $s.ownedPid) {
            [void](Disconnect-DeckbackPowerPoint -Session $s)
            throw "(f) ${Case}: this test could not prove it started PowerPoint (POWERPNT $((Get-PowerPointPids) -join ','))"
        }
        $s
    }

    $session = $null; $app = $null; $presList = $null
    $stand = $null; $standSlides = $null; $standSlide = $null; $standShapes = $null
    $authorDoc = $null; $authorSlides = $null; $authorSlide = $null; $authorShapes = $null
    $standName = $null; $initialCount = $null; $sameHash = $null
    $sameFile = Join-Path $Work 'same-file.pptx'
    try {
        # (own) No PowerPoint running: the module starts its own instance and must quit it.
        if (-not $WasRunning) {
            $copies = (Get-TempCopies).Count
            $r = Invoke-DeckbackPowerPoint -Pptx $Deck -Action 'param($pres, $app, $args) $pres.Slides.Count'
            $left = Get-PowerPointPids
            Check ($r.exitCode -eq 0 -and $r.ok -and $r.result -eq 3) "own instance: exitCode 0 and 3 slides (got $($r.exitCode), $($r.result)) $($r.message)"
            Check ((@($r.newPids) -join ',') -eq ($left -join ',')) "own instance: newPids ($(@($r.newPids) -join ',')) lists the POWERPNT processes left ($($left -join ','))"
            Check ($null -ne $r.ownedPid) "own instance: the module proved by process id that it started PowerPoint (ownedPid $($r.ownedPid))"
            Check ($r.leftRunning -eq $false -and "$($r.message)" -notmatch 'left running') "own instance: Disconnect quit it, nothing logged as left running ($($r.message))"
            $gone = Wait-NoPowerPoint 20
            Check $gone 'own instance: the module quit the PowerPoint it started (no POWERPNT left)'
            Check ((Get-TempCopies).Count -eq $copies) 'own instance: no temp copy left'
            if (-not $gone) { throw 'a PowerPoint started by the module is still running; stopping here (it is not killed)' }

            # -RequireOwned, no PowerPoint running: the module owns the instance, so the action runs, and it may name
            # ActivePrinter.
            $r = Invoke-DeckbackPowerPoint -Pptx $Deck -RequireOwned -Action 'param($pres, $app, $args) try { [void][string]$app.ActivePrinter } catch { }; $pres.Slides.Count'
            Check ($r.exitCode -eq 0 -and $r.ok -and -not $r.skipped -and $r.result -eq 3 -and $null -ne $r.ownedPid) "own instance with -RequireOwned: the action ran (exitCode $($r.exitCode), result $($r.result), ownedPid $($r.ownedPid)) $($r.message)"
            $gone = Wait-NoPowerPoint 20
            Check $gone 'own instance with -RequireOwned: the module quit the PowerPoint it started'
            if (-not $gone) { throw 'a PowerPoint started by the module is still running; stopping here (it is not killed)' }

            # (f) Disconnect and an instance this test started (ruling M1-R73).
            # Hidden, nothing open: it is quit; a session object Connect did not return is ignored first.
            $own = Connect-OwnInstance 'hidden'
            $ownPid = $own.ownedPid
            $forged = [pscustomobject]@{ app = $own.app; ownedPid = $ownPid; newPids = @() }
            $forgedQuit = Disconnect-DeckbackPowerPoint -Session $forged
            Check (-not $forgedQuit -and (Test-Alive $ownPid)) 'Disconnect ignores a session object Connect did not return (no Quit)'
            $forged = $null
            $quit = Disconnect-DeckbackPowerPoint -Session $own
            Check ($quit -and (Wait-PidGone $ownPid 20)) "(f) hidden, nothing open: Disconnect quit the instance this test started (quit $quit)"
            Check ($null -eq $own.PSObject.Properties['leftRunning']) '(f) hidden, nothing open: nothing logged as left running'

            # The start screen: the author opened PowerPoint from the Start menu and it joined this instance.
            $own = Connect-OwnInstance 'start screen'
            $ownPid = $own.ownedPid
            $own.app.Visible = -1
            $quit = Disconnect-DeckbackPowerPoint -Session $own
            Check (-not $quit -and (Test-Alive $ownPid)) "(f) start screen (visible, nothing open): Disconnect left the instance running (quit $quit)"
            Check ("$($own.leftRunning)" -match 'Visible' -and "$($own.leftRunning)" -match "process id $ownPid") "(f) start screen: logged ($($own.leftRunning))"
            Check (Close-OwnVisibleInstance $ownPid $Deck) "(f) start screen: the test ended its own instance (process $ownPid gone)"

            # A scratch deck open with a document window.
            $own = Connect-OwnInstance 'document window'
            $ownPid = $own.ownedPid
            $list = $own.app.Presentations
            $scratchDoc = $list.Open($Deck, -1, 0, -1)                 # read-only, with a window
            Drop $list; $list = $null
            $quit = Disconnect-DeckbackPowerPoint -Session $own
            Check (-not $quit -and (Test-Alive $ownPid)) "(f) a document window open: Disconnect left the instance running (quit $quit)"
            Check ("$($own.leftRunning)" -match 'Presentations\.Count 1' -and "$($own.leftRunning)" -match 'Windows\.Count 1' -and "$($own.leftRunning)" -match 'Visible') "(f) a document window open: logged ($($own.leftRunning))"
            try { $scratchDoc.Saved = -1; $scratchDoc.Close(); $log.Add('closed only the scratch window this test opened') }
            finally { Release $scratchDoc; $scratchDoc = $null }
            Check (Close-OwnVisibleInstance $ownPid $Deck) "(f) a document window open: the test ended its own instance (process $ownPid gone)"

            # A scratch deck open in Protected View, as an e-mailed .pptx opens.
            $own = Connect-OwnInstance 'Protected View'
            $ownPid = $own.ownedPid
            $pvList = $own.app.ProtectedViewWindows
            $scratchPv = $pvList.Open($Deck)
            Drop $pvList; $pvList = $null
            $quit = Disconnect-DeckbackPowerPoint -Session $own
            Check (-not $quit -and (Test-Alive $ownPid)) "(f) a Protected View window open: Disconnect left the instance running (quit $quit)"
            Check ("$($own.leftRunning)" -ne '') "(f) a Protected View window open: logged ($($own.leftRunning))"
            try { $scratchPv.Close(); $log.Add('closed only the scratch Protected View window this test opened') }
            finally { Release $scratchPv; $scratchPv = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers() }
            Check (Wait-PidGone $ownPid 30) "(f) a Protected View window open: the instance ended by itself once that window closed (process $ownPid)"

            # A whole run: its action makes the run's own instance visible, as the author surfacing it would.
            if (-not (Wait-NoPowerPoint 20)) { throw "(f) run: POWERPNT process(es) $((Get-PowerPointPids) -join ',') still running; stopping here (nothing is killed)" }
            $r = Invoke-DeckbackPowerPoint -Pptx $Deck -Action 'param($pres, $app, $args) $app.Visible = -1; $pres.Slides.Count'
            $runPid = $r.ownedPid
            Check ($r.ok -and $r.exitCode -eq 0 -and $r.result -eq 3 -and $null -ne $runPid) "(f) a run whose instance became visible: ok, 3 slides, ownedPid $runPid ($($r.message))"
            Check ($r.leftRunning -eq $true -and "$($r.message)" -match 'left running' -and "$($r.message)" -match 'Visible') "(f) a run whose instance became visible: leftRunning, and the message says why ($($r.message))"
            if ($null -ne $runPid) {
                Check (Test-Alive $runPid) "(f) a run whose instance became visible: its PowerPoint ($runPid) is still running"
                Check (Close-OwnVisibleInstance $runPid $Deck) "(f) a run whose instance became visible: the test ended it (process $runPid gone)"
            }
            if (-not (Wait-NoPowerPoint 20)) { throw "(f) POWERPNT process(es) $((Get-PowerPointPids) -join ',') left after (f); stopping here (nothing is killed)" }
        }

        # (a) The author's session. Ownership of the instance is decided by process id inside
        # Connect-DeckbackPowerPoint; anything this test did not start is not quit.
        $session = Connect-DeckbackPowerPoint -WasRunning $WasRunning
        if (-not $WasRunning) { Check ($null -ne $session.ownedPid) "this test started PowerPoint and proved it by process id ($($session.ownedPid))" }
        $app = $session.app
        $presList = $app.Presentations
        $initialCount = $presList.Count

        # Stand-in 1: untitled, unsaved, with a window.
        $stand = $presList.Add(-1)
        $standName = $stand.Name
        $standSlides = $stand.Slides
        $standSlide = $standSlides.Add(1, 12)                       # ppLayoutBlank
        $standShapes = $standSlide.Shapes
        $note = $standShapes.AddTextbox(1, 50, 50, 400, 60)
        $note.TextFrame.TextRange.Text = 'unsaved work (COM module stand-in)'
        Release $note

        # Stand-in 2: the very file the module is given, open read/write with a window, edited, unsaved.
        Copy-Item -LiteralPath $Deck -Destination $sameFile -Force
        $sameHash = (Get-FileHash -LiteralPath $sameFile).Hash
        $authorDoc = $presList.Open($sameFile, 0, 0, -1)
        $authorSlides = $authorDoc.Slides
        $authorSlide = $authorSlides.Item(1)
        $authorShapes = $authorSlide.Shapes
        $edit = $authorShapes.AddTextbox(1, 50, 50, 300, 40)
        $edit.TextFrame.TextRange.Text = 'author edit (unsaved)'
        Release $edit

        $countBefore = $presList.Count
        $windowsBefore = Get-WindowCount $app
        $standShapesBefore = $standShapes.Count
        $authorShapesBefore = $authorShapes.Count
        $pidsBefore = Get-PowerPointPids
        $log.Add("author session: '$standName' and same-file.pptx open; presentations=$countBefore windows=$windowsBefore POWERPNT pids=$($pidsBefore -join ',')")
        Check ($stand.Saved -eq 0 -and $authorDoc.Saved -eq 0) 'both stand-ins start unsaved'
        Check ((Get-PptxSlideCount -Pptx $sameFile) -eq 3) 'Get-PptxSlideCount reads a file the author has open'

        function Assert-AuthorSession([string]$Label, [int]$CopiesBefore) {
            Check (Test-PresentationOpen $presList $standName) "${Label}: untitled stand-in '$standName' still open"
            Check ($stand.Saved -eq 0) "${Label}: untitled stand-in still unsaved"
            Check ($standShapes.Count -eq $standShapesBefore) "${Label}: untitled stand-in content unchanged"
            Check (Test-PresentationOpen $presList 'same-file.pptx') "${Label}: the author's copy of the input file still open"
            Check ($authorDoc.Saved -eq 0) "${Label}: the author's copy of the input file still unsaved"
            Check ($authorShapes.Count -eq $authorShapesBefore) "${Label}: the author's edit is intact"
            Check ($presList.Count -eq $countBefore) "${Label}: presentation count unchanged ($countBefore)"
            Check ((Get-WindowCount $app) -eq $windowsBefore) "${Label}: window count unchanged ($windowsBefore)"
            $now = Get-PowerPointPids
            Check ((($now | Sort-Object) -join ',') -eq (($pidsBefore | Sort-Object) -join ',')) "${Label}: the same POWERPNT processes, none stopped, none added ($($now -join ','))"
            Check ((Get-FileHash -LiteralPath $sameFile).Hash -eq $sameHash) "${Label}: the input file on disk is byte-identical"
            Check ((Get-TempCopies).Count -eq $CopiesBefore) "${Label}: no temp copy left"
        }

        # (a) A successful run on the file the author has open.
        $copies = (Get-TempCopies).Count
        $action = @'
param($pres, $app, $args)
$slides = $pres.Slides
[pscustomobject]@{ slides = $slides.Count; name = $pres.Name; readOnly = [int]$pres.ReadOnly; a0 = $args[0]; a1 = $args[1]; n = $args.Count }
'@
        $r = Invoke-DeckbackPowerPoint -Pptx $sameFile -Action $action -ActionArgs @('first', 2)
        Check ($r.exitCode -eq 0 -and $r.ok) "success run: exitCode 0 (got $($r.exitCode)) $($r.message)"
        Check ($r.result.slides -eq 3) "success run: the action saw 3 slides (got $($r.result.slides))"
        Check ("$($r.result.name)" -like 'deckback-com-*.pptx') "success run: the action ran on the temp copy ($($r.result.name)), not on the author's file"
        Check ($r.result.readOnly -eq -1) 'success run: the copy was opened read-only'
        Check ($r.result.a0 -eq 'first' -and $r.result.a1 -eq 2 -and $r.result.n -eq 2) 'success run: -ActionArgs arrive as $args'
        Check ($null -eq $r.ownedPid -and @($r.newPids).Count -eq 0 -and -not $r.stuck) 'success run: the module claimed no PowerPoint, started none, left no job'
        Assert-AuthorSession 'after a successful run' $copies

        # (a) -RequireOwned with a PowerPoint around (this test's stand-ins are in it): skipped, nothing touched.
        $marker = Join-Path $Work 'require-owned-ran.txt'
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        $ownedAction = 'param($pres, $app, $args) [IO.File]::WriteAllText([string]$args[0], "ran"); $pres.Slides.Count'
        foreach ($variant in @(@{ Label = 'before the job starts'; Hook = $false }, @{ Label = 'inside the job'; Hook = $true })) {
            $copies = (Get-TempCopies).Count
            $extra = @{}
            if ($variant.Hook) { $extra.TestSkipOwnershipPrecheck = $true }
            $r = Invoke-DeckbackPowerPoint -Pptx $sameFile -RequireOwned -Action $ownedAction -ActionArgs @($marker) @extra
            Check ($r.exitCode -eq 4 -and $r.skipped -and -not $r.ok) "-RequireOwned skipped $($variant.Label): exitCode 4, skipped, not ok (got $($r.exitCode)) $($r.message)"
            Check (-not (Test-Path -LiteralPath $marker)) "-RequireOwned skipped $($variant.Label): the action did not run"
            Check ($null -eq $r.ownedPid -and @($r.newPids).Count -eq 0 -and -not $r.stuck -and "$($r.message)" -match '^skipped: PowerPoint was already running') "-RequireOwned skipped $($variant.Label): claimed no PowerPoint, started none, left no job"
            Assert-AuthorSession "after a -RequireOwned run skipped $($variant.Label)" $copies
        }

        # (a) A forced error run: the action throws after the copy was opened.
        $copies = (Get-TempCopies).Count
        $r = Invoke-DeckbackPowerPoint -Pptx $sameFile -Action 'param($pres, $app, $args) throw "forced action error"'
        Check ($r.exitCode -eq 3 -and -not $r.ok -and "$($r.message)" -match 'forced action error') "error run: exitCode 3 with the action's message (got $($r.exitCode): $($r.message))"
        Assert-AuthorSession 'after a forced error run' $copies

        # (b) Timeout: the action sleeps 30 s, the limit is 5 s.
        $copies = (Get-TempCopies).Count
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-DeckbackPowerPoint -Pptx $sameFile -TimeoutSec 5 -Action 'param($pres, $app, $args) Start-Sleep -Seconds 30; "not reached"'
        $elapsed = $clock.Elapsed.TotalSeconds
        Check ($r.exitCode -eq 2 -and -not $r.ok -and -not $r.stuck) "timeout run: exitCode 2, job stopped (got $($r.exitCode), stuck $($r.stuck)) $($r.message)"
        Check ($elapsed -lt 25) "timeout run: returned after $([int]$elapsed) s, before the action's 30 s"
        Check ("$($r.message)" -match 'no PowerPoint process was stopped or killed') 'timeout run: the message says nothing was stopped or killed'
        Assert-AuthorSession 'after a timeout' $copies

        # (e) A child process started from inside the action gets its own stdin, stdout and stderr.
        $copies = (Get-TempCopies).Count
        $action = @'
param($pres, $app, $args)
$c = Invoke-DeckbackChildProcess -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', 'sort & echo child-ok')
[pscustomobject]@{ code = $c.exitCode; out = "$($c.stdout)".Trim() }
'@
        $r = Invoke-DeckbackPowerPoint -Pptx $sameFile -TimeoutSec 60 -Action $action
        Check ($r.exitCode -eq 0 -and $r.result.code -eq 0 -and $r.result.out -eq 'child-ok') "child process: read an empty stdin and returned (exitCode $($r.exitCode), child $($r.result.code), '$($r.result.out)') $($r.message)"
        Assert-AuthorSession 'after a run with a child process' $copies
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
                Check ((Get-FileHash -LiteralPath $sameFile).Hash -eq $sameHash) 'the input file on disk is still unchanged after closing without saving'
            }
        }
        if ($null -ne $stand) {
            try { $stand.Saved = -1; $stand.Close(); $log.Add("closed only the stand-in '$standName' (not saved)") }
            catch { $log.Add("  FAIL: could not close the stand-in: $($_.Exception.Message)"); $state.failed++ }
        }
        if ($null -ne $presList -and $null -ne $initialCount) {
            try { Check ($presList.Count -eq $initialCount) "presentation count back to $initialCount" } catch { }
        }
        Release $authorShapes; Release $authorSlide; Release $authorSlides; Release $authorDoc
        Release $standShapes; Release $standSlide; Release $standSlides; Release $stand
        Release $presList
        $authorShapes = $null; $authorSlide = $null; $authorSlides = $null; $authorDoc = $null
        $standShapes = $null; $standSlide = $null; $standSlides = $null; $stand = $null; $presList = $null; $app = $null
        $ownedPid = $null
        if ($null -ne $session) { $ownedPid = $session.ownedPid }
        $quit = Disconnect-DeckbackPowerPoint -Session $session
        if ($null -ne $session) { Check ($null -eq $session.app) 'Disconnect cleared session.app' }
        if ($null -ne $ownedPid) {
            # The stand-ins' windows made this test's own instance visible: Disconnect leaves it running (M1-R73).
            Check (-not $quit -and "$($session.leftRunning)" -match 'Visible') "Disconnect left this test's own PowerPoint running, visible after its stand-in windows ($($session.leftRunning))"
            Check (Close-OwnVisibleInstance $ownedPid $Deck) "the PowerPoint process this test started ($ownedPid) is gone"
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
    Write-Output "COM MODULE TESTS TIMEOUT: no answer within $TimeoutSec s. No PowerPoint process was killed; an untitled presentation and same-file.pptx opened by this test may still be open in PowerPoint (close them by hand, without saving; see harness/README.md)."
    # A job still blocked in PowerPoint would make a normal exit wait for it, possibly forever.
    [Console]::Out.Flush()
    [Environment]::Exit(2)
}
$result = @(Receive-Job -Job $job -ErrorAction SilentlyContinue) |
    Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['Failed'] } | Select-Object -Last 1
$jobReason = ''
if ($job.ChildJobs.Count -gt 0 -and $null -ne $job.ChildJobs[0].JobStateInfo.Reason) { $jobReason = $job.ChildJobs[0].JobStateInfo.Reason.Message }
Remove-Job -Job $job -Force
if ($null -eq $result) { Stop-Failed "the session job returned no result. $jobReason" }
$result.Log | ForEach-Object { Write-Output $_ }
if ($result.Failed -ne 0) { $failures.Add("$($result.Failed) session check(s)") }
Write-Output "PowerPoint running after the test: $((Get-PowerPointPids).Count -gt 0)"

if ($failures.Count -eq 0) {
    Write-Output 'COM MODULE TESTS OK'
    exit 0
}
Stop-Failed ($failures -join '; ')
