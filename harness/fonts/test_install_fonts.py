"""install-fonts.ps1 against a scratch font folder and a scratch HKCU key (Windows only).

Nothing is downloaded: the locked font of the scratch lock is already in place with the right sha256, so these tests
exercise the retired-font removal and the conflict checks without the network. The scratch key is
HKCU\\Software\\deckback-test-fonts-<random> and is deleted afterwards; the real per-user fonts are never touched.
"""

import hashlib
import json
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="install-fonts.ps1 is Windows PowerShell")

SCRIPT = Path(__file__).with_name("install-fonts.ps1")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def scratch(tmp_path):
    import winreg

    subkey = f"Software\\deckback-test-fonts-{uuid.uuid4().hex}"
    winreg.CreateKey(winreg.HKEY_CURRENT_USER, subkey).Close()
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    try:
        yield SimpleNamespace(dir=fonts, subkey=subkey, reg="HKCU:\\" + subkey, lock=tmp_path / "lock.json")
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, subkey)  # values only, no subkeys


def set_value(scratch, name, data):
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, scratch.subkey, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, data)


def values(scratch):
    import winreg

    out = {}
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, scratch.subkey) as key:
        index = 0
        while True:
            try:
                name, data, _ = winreg.EnumValue(key, index)
            except OSError:
                return out
            out[name] = data
            index += 1


def write_lock(scratch, font_bytes, retired):
    lock = {
        "families": [{"family": "New Sans", "license": "OFL-1.1", "files": [{
            "file": "NewSans-Regular.ttf", "url": "https://example.invalid/NewSans-Regular.ttf",
            "sha256": sha256(font_bytes), "format": "ttf", "fullName": "Shared Name",
            "postscriptName": "NewSans-Regular"}]}],
        "retired": retired,
    }
    scratch.lock.write_text(json.dumps(lock), encoding="utf-8")


def run(scratch):
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT), "-LockPath",
         str(scratch.lock), "-FontDir", str(scratch.dir), "-RegPath", scratch.reg, "-CloudFontsDir",
         str(scratch.dir.parent / "no-cloud")],
        capture_output=True, text=True, errors="replace", timeout=180,
    )


def test_retired_fonts_are_removed_only_when_file_and_value_are_exactly_theirs(scratch):
    new_font = b"new font bytes"
    (scratch.dir / "NewSans-Regular.ttf").write_bytes(new_font)  # in place: nothing to download
    files = {"ours.otf": b"ours", "changed.otf": b"changed by someone", "unregistered.otf": b"unregistered"}
    for name, data in files.items():
        (scratch.dir / name).write_bytes(data)
    elsewhere = str(scratch.dir.parent / "elsewhere" / "unregistered.otf")
    # "Shared Name (TrueType)" is both the retired font's value and the new font's (as with Pretendard .otf/.ttf)
    set_value(scratch, "Shared Name (TrueType)", str(scratch.dir / "ours.otf"))
    set_value(scratch, "Changed (TrueType)", str(scratch.dir / "changed.otf"))
    set_value(scratch, "Unregistered (TrueType)", elsewhere)
    set_value(scratch, "Stale (TrueType)", str(scratch.dir / "stale.otf"))
    write_lock(scratch, new_font, [
        {"file": "ours.otf", "sha256": sha256(b"ours"), "registryValue": "Shared Name (TrueType)"},
        {"file": "changed.otf", "sha256": sha256(b"the original"), "registryValue": "Changed (TrueType)"},
        {"file": "unregistered.otf", "sha256": sha256(b"unregistered"), "registryValue": "Unregistered (TrueType)"},
        {"file": "stale.otf", "sha256": sha256(b"stale"), "registryValue": "Stale (TrueType)"},
        {"file": "gone.otf", "sha256": sha256(b"gone"), "registryValue": "Gone (TrueType)"},
    ])

    for attempt in (1, 2):  # idempotent: the second run removes nothing more and reports the same leftovers
        done = run(scratch)
        assert done.returncode == 0, done.stderr
        assert done.stdout.strip().splitlines()[-1] == "FONTS OK 1"
        removed = [line for line in done.stdout.splitlines() if line.startswith("removed retired")]
        assert [line.split()[2] for line in removed] == (["ours.otf"] if attempt == 1 else [])
        for name in ("changed.otf", "unregistered.otf", "stale.otf"):
            assert f"retired {name} left untouched" in done.stderr, (attempt, name)
        assert "gone.otf" not in done.stdout + done.stderr  # already gone: nothing to say
        assert "downloading" not in done.stdout

        assert not (scratch.dir / "ours.otf").exists()
        for name in ("changed.otf", "unregistered.otf"):
            assert (scratch.dir / name).read_bytes() == files[name]
        assert values(scratch) == {
            "Shared Name (TrueType)": str(scratch.dir / "NewSans-Regular.ttf"),  # now the new font's value
            "Changed (TrueType)": str(scratch.dir / "changed.otf"),
            "Unregistered (TrueType)": elsewhere,
            "Stale (TrueType)": str(scratch.dir / "stale.otf"),
        }


def test_a_retired_font_that_cannot_be_removed_blocks_a_new_font_with_its_value_name(scratch):
    new_font = b"new font bytes"
    (scratch.dir / "NewSans-Regular.ttf").write_bytes(new_font)
    (scratch.dir / "ours.otf").write_bytes(b"someone else's file")
    set_value(scratch, "Shared Name (TrueType)", str(scratch.dir / "ours.otf"))
    write_lock(scratch, new_font, [{"file": "ours.otf", "sha256": sha256(b"ours"),
                                    "registryValue": "Shared Name (TrueType)"}])
    done = run(scratch)
    assert done.returncode == 1
    assert "retired ours.otf left untouched" in done.stderr
    assert "already points to" in done.stderr
    assert (scratch.dir / "ours.otf").read_bytes() == b"someone else's file"
    assert values(scratch) == {"Shared Name (TrueType)": str(scratch.dir / "ours.otf")}


@pytest.mark.parametrize("entry", [
    {"file": "..\\escape.otf", "sha256": "0" * 64, "registryValue": "Escape (TrueType)"},
    {"file": "ok.otf", "sha256": "not-a-hash", "registryValue": "Ok (TrueType)"},
    {"file": "ok.otf", "sha256": "0" * 64, "registryValue": "Ok"},
    {"file": "ok.otf", "sha256": "0" * 64, "registryValue": "C:\\x\\Ok (TrueType)"},
    {"file": "NewSans-Regular.ttf", "sha256": "0" * 64, "registryValue": "Shared Name (TrueType)"},
])
def test_a_bad_retired_entry_stops_before_anything_changes(scratch, entry):
    new_font = b"new font bytes"
    (scratch.dir / "NewSans-Regular.ttf").write_bytes(new_font)
    (scratch.dir / "ok.otf").write_bytes(b"x")
    set_value(scratch, "Ok (TrueType)", str(scratch.dir / "ok.otf"))
    write_lock(scratch, new_font, [entry])
    done = run(scratch)
    assert done.returncode == 1
    assert "retired" in done.stderr
    assert (scratch.dir / "ok.otf").exists() and (scratch.dir / "NewSans-Regular.ttf").exists()
    assert values(scratch) == {"Ok (TrueType)": str(scratch.dir / "ok.otf")}


def test_a_family_that_is_an_office_cloud_font_is_skipped_with_a_warning_unless_allowed(scratch, tmp_path):
    """Ruling M8-R4: the cloud copy wins; the installer skips the family and warns, it does not refuse."""
    new_font = b"new font bytes"
    write_lock(scratch, new_font, [])  # the file is not in place and the url cannot be fetched: an install would fail
    cloud = tmp_path / "cloud"
    (cloud / "new sans").mkdir(parents=True)  # the folder's name is the family; case does not matter
    (cloud / "new sans" / "1.ttf").write_bytes(b"x")
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT), "-LockPath",
               str(scratch.lock), "-FontDir", str(scratch.dir), "-RegPath", scratch.reg, "-CloudFontsDir", str(cloud)]

    def go(*extra):
        return subprocess.run(command + list(extra), capture_output=True, text=True, errors="replace", timeout=180)

    skipped = go()
    assert skipped.returncode == 0 and skipped.stdout.strip().splitlines()[-1] == "FONTS OK 0", skipped.stderr
    assert "warning: skipped New Sans" in skipped.stderr and "cloud" in skipped.stderr
    assert values(scratch) == {} and not (scratch.dir / "NewSans-Regular.ttf").exists()  # nothing installed
    (scratch.dir / "NewSans-Regular.ttf").write_bytes(new_font)
    allowed = go("-AllowCloudDuplicates")
    assert allowed.returncode == 0 and allowed.stdout.strip().splitlines()[-1] == "FONTS OK 1"
    (cloud / "new sans" / "1.ttf").unlink()  # a folder with no font file is not a cloud font (cloudfonts.cloud_families)
    emptied = go()
    assert emptied.returncode == 0 and "skipped" not in emptied.stderr, emptied.stderr
    command[-1] = str(tmp_path / "no-cloud")
    assert go().returncode == 0  # no cloud folder: nothing to skip
