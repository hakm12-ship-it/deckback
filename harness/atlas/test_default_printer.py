"""harness/atlas/default_printer.ps1 (minor m5): export.ps1's msprint variant prints to 'Microsoft Print to PDF', and with
Windows' "Let Windows manage my default printer" on, Windows may make that printer the user's default. export.ps1 reads
the default printer before msprint and puts it back afterwards if it changed.

The logic is tested with stand-in readers and writers: no test here changes the real default printer. The real reader
is checked read-only against the registry. Windows only (PowerShell); no PowerPoint.
"""

import json
import sys
from pathlib import Path

import pytest

from harness.ppt.never_stop import run_script

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="default_printer.ps1 is Windows PowerShell")

LIBRARY = Path(__file__).with_name("default_printer.ps1")

# Each case: the state before, what the print job left, and how the stand-in writers behave. The driver prints one JSON
# object per case: the outcome token, the writers' calls and the final state.
DRIVER = r"""
param([string]$Library)
$ErrorActionPreference = 'Stop'
. $Library
$script:state = $null
$script:calls = $null
$script:failSet = $false
$script:flipMode = $false
$read = { @{ printer = $script:state.printer; mode = $script:state.mode } }
$setPrinter = {
    param($Name)
    $script:calls.Add("printer=$Name")
    if ($script:failSet) { throw 'Access is denied' }
    $script:state.printer = $Name
    if ($script:flipMode) { $script:state.mode = 1 }    # as Windows may turn its own management off
}
$setMode = { param($Value) $script:calls.Add("mode=$Value"); $script:state.mode = $Value }
$cases = [ordered]@{
    'unchanged'          = @{ before = @{ printer = 'Office'; mode = 0 }; after = @{ printer = 'Office'; mode = 0 } }
    'changed'            = @{ before = @{ printer = 'Office'; mode = 0 }; after = @{ printer = 'Microsoft Print to PDF'; mode = 0 } }
    'changed-flips-mode' = @{ before = @{ printer = 'Office'; mode = 0 }; after = @{ printer = 'Microsoft Print to PDF'; mode = 0 }; flip = $true }
    'cannot-set'         = @{ before = @{ printer = 'Office'; mode = 0 }; after = @{ printer = 'Microsoft Print to PDF'; mode = 0 }; fail = $true }
    'no-default-before'  = @{ before = @{ printer = $null; mode = 0 }; after = @{ printer = 'Microsoft Print to PDF'; mode = 0 } }
    'not-read-before'    = @{ before = $null; after = @{ printer = 'Microsoft Print to PDF'; mode = 0 } }
}
$out = [ordered]@{}
foreach ($name in $cases.Keys) {
    $case = $cases[$name]
    $script:state = @{ printer = $case.after.printer; mode = $case.after.mode }
    $script:calls = New-Object System.Collections.Generic.List[string]
    $script:failSet = [bool]$case.fail
    $script:flipMode = [bool]$case.flip
    $token = Restore-DeckbackPrinterState -Before $case.before -Read $read -SetPrinter $setPrinter -SetMode $setMode
    $out[$name] = [ordered]@{ token = $token; calls = @($script:calls); printer = $script:state.printer; mode = $script:state.mode }
}
$script:state = @{ printer = 'Office'; mode = 0 }
$out['read-fails'] = [ordered]@{ token = (Restore-DeckbackPrinterState -Before @{ printer = 'Office'; mode = 0 } -Read { throw 'no spooler' } -SetPrinter $setPrinter -SetMode $setMode); calls = @() }
$real = Read-DeckbackPrinterState
$out['real'] = [ordered]@{ printer = $real.printer; mode = $real.mode }
[Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 5 -Compress))
"""


@pytest.fixture(scope="module")
def outcome(tmp_path_factory):
    driver = tmp_path_factory.mktemp("printer") / "driver.ps1"
    driver.write_text(DRIVER, encoding="ascii")
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver),
                       "-Library", str(LIBRARY)], 120)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("case, token, calls, final", [
    ("unchanged", "unchanged", [], ("Office", 0)),
    ("changed", "restored", ["printer=Office"], ("Office", 0)),
    ("changed-flips-mode", "restored", ["printer=Office", "mode=0"], ("Office", 0)),
    ("cannot-set", "not-restored", ["printer=Office"], ("Microsoft Print to PDF", 0)),
    ("no-default-before", "not-restored", [], ("Microsoft Print to PDF", 0)),
    ("not-read-before", "unknown", [], ("Microsoft Print to PDF", 0)),
])
def test_the_default_printer_is_put_back_only_when_msprint_changed_it(outcome, case, token, calls, final):
    got = outcome[case]
    assert got["token"] == token
    assert (got["calls"] or []) == calls  # nothing is written unless the default changed and can be put back
    assert (got["printer"], got["mode"]) == final


def test_an_unreadable_default_printer_is_left_alone(outcome):
    assert outcome["read-fails"]["token"] == "unknown" and not outcome["read-fails"]["calls"]


def test_the_real_reader_matches_the_registry(outcome):
    """Read-only: Read-DeckbackPrinterState gives the printer of HKCU ...\\Windows 'Device' and the
    LegacyDefaultPrinterMode value (None when the PC has neither)."""
    import winreg

    def value(name):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Windows") as key:
                return winreg.QueryValueEx(key, name)[0]
        except OSError:
            return None

    device = value("Device")
    assert outcome["real"]["printer"] == (device.split(",")[0] if device else None)
    assert outcome["real"]["mode"] == value("LegacyDefaultPrinterMode")
