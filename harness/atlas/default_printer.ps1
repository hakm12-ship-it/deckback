<#
.SYNOPSIS
  The Windows default printer around harness/atlas/export.ps1's msprint variant (minor m5). Dot-sourced by export.ps1.

.DESCRIPTION
  msprint sends a real print job to 'Microsoft Print to PDF'. With Windows' "Let Windows manage my default printer" on
  (HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows, LegacyDefaultPrinterMode = 0), Windows may then make
  that printer the user's default. So export.ps1 reads the default printer and that setting before msprint prints, and
  afterwards puts them back if the default printer changed meanwhile, with the printer API (winspool SetDefaultPrinter),
  which may turn Windows' management off; then the setting is put back too. Nothing is written when the default did
  not change.

    Read-DeckbackPrinterState -> @{ printer = <the default printer's name, $null if there is none>;
                                    mode = <LegacyDefaultPrinterMode, $null if not set> }
    Restore-DeckbackPrinterState -Before <state read before msprint> [-Read <sb>] [-SetPrinter <sb>] [-SetMode <sb>]
        -> 'unchanged'     the default printer is the one read before (nothing written)
           'restored'      it had changed and is back, with LegacyDefaultPrinterMode as before
           'not-restored'  it had changed and could not be put back (no default printer before, or the API failed)
           'unknown'       the state before or after could not be read (nothing written)
  -Read, -SetPrinter and -SetMode are for tests (harness/atlas/test_default_printer.py), which never change the real
  default printer.
#>

if (-not ('DeckbackNative.DefaultPrinter' -as [type])) {
    Add-Type -Namespace DeckbackNative -Name DefaultPrinter -MemberDefinition @'
[DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool GetDefaultPrinterW(System.Text.StringBuilder buffer, ref int size);
[DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool SetDefaultPrinterW(string name);
public static string Get() {
    int size = 0;
    GetDefaultPrinterW(null, ref size);
    if (size <= 0) { return null; }
    var buffer = new System.Text.StringBuilder(size);
    return GetDefaultPrinterW(buffer, ref size) ? buffer.ToString() : null;
}
public static bool Set(string name) { return SetDefaultPrinterW(name); }
'@
}

$script:DeckbackPrinterKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows'

function Read-DeckbackPrinterState {
    $mode = $null
    try { $mode = (Get-ItemProperty -LiteralPath $script:DeckbackPrinterKey -Name LegacyDefaultPrinterMode -ErrorAction Stop).LegacyDefaultPrinterMode }
    catch { }
    @{ printer = [DeckbackNative.DefaultPrinter]::Get(); mode = $mode }
}

function Restore-DeckbackPrinterState {
    param(
        $Before,
        [scriptblock]$Read = { Read-DeckbackPrinterState },
        [scriptblock]$SetPrinter = {
            param($Name)
            if (-not [DeckbackNative.DefaultPrinter]::Set($Name)) { throw "SetDefaultPrinter failed (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
        },
        [scriptblock]$SetMode = {
            param($Value)
            Set-ItemProperty -LiteralPath $script:DeckbackPrinterKey -Name LegacyDefaultPrinterMode -Value $Value -Type DWord
        }
    )
    if ($null -eq $Before) { return 'unknown' }
    try { $after = & $Read } catch { return 'unknown' }
    if ("$($after.printer)" -ceq "$($Before.printer)") { return 'unchanged' }
    # There was no default printer before: "none" cannot be set again.
    if ([string]::IsNullOrEmpty($Before.printer)) { return 'not-restored' }
    try {
        & $SetPrinter $Before.printer
        $now = & $Read
        if ($null -ne $Before.mode -and "$($now.mode)" -ne "$($Before.mode)") {
            & $SetMode $Before.mode
            $now = & $Read
        }
    }
    catch { return 'not-restored' }
    if ("$($now.printer)" -ceq "$($Before.printer)" -and ($null -eq $Before.mode -or "$($now.mode)" -eq "$($Before.mode)")) { return 'restored' }
    return 'not-restored'
}
