"""Tests for harness/fonts/fontcheck.py and the shape of harness/fonts/fonts.lock.json.

None of these tests needs the fonts installed (CI has none) or Windows, except the ones marked Windows-only:
`missing_ofl` takes the installed fonts (InstalledFont records) as an argument, and `winreg` is only imported inside
the functions that read the registry.
"""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

import pytest

from harness.fonts import fontcheck
from harness.fonts.fontcheck import InstalledFont, installed_families, lock_postscript_names, missing_ofl
from harness.fonts.test_program import ttf

LOCK = Path(__file__).with_name("fonts.lock.json")


def write_lock(path, families):
    path.write_text(json.dumps({"families": families}), encoding="utf-8")
    return path


def digest(file):
    """The sha256 the synthetic lock records for `file` (the test's stand-in for the file's bytes)."""
    return hashlib.sha256(file.encode("utf-8")).hexdigest()


def family(name, *files):
    return {
        "family": name,
        "license": "OFL-1.1",
        "files": [{"file": f, "url": "https://example.invalid/" + f, "sha256": digest(f),
                   "postscriptName": f.rsplit(".", 1)[0]} for f in files],
    }


def font(family_name, file, sha=None, ps=None):
    """An installed font file as the registry reading gives it: the locked bytes of `file` unless `sha` says
    otherwise, with the family name and the PostScript name the synthetic lock gives `file` unless `ps` does."""
    return InstalledFont(path=f"fonts/{file}", families=frozenset({family_name}),
                         postscript_names=frozenset({ps or file.rsplit(".", 1)[0]}), digest=sha or digest(file))


SYSTEM = [font("Arial", "arial.ttf"), font("Segoe UI", "segoeui.ttf")]


def families_of(problems):
    return [problem.split(":", 1)[0] for problem in problems]


def test_missing_ofl_reports_family(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Nonexistent Sans", "NonexistentSans-Regular.ttf")])
    assert missing_ofl(lock, installed=SYSTEM) == ["Nonexistent Sans: NonexistentSans-Regular.ttf is not installed"]


def test_missing_ofl_is_empty_when_every_locked_file_is_installed(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Alpha Sans", "a.ttf", "a-b.ttf"), family("Beta Serif", "b.otf")])
    installed = [*SYSTEM, font("Alpha Sans", "a.ttf"), font("Alpha Sans", "a-b.ttf"), font("Beta Serif", "b.otf")]
    assert missing_ofl(lock, installed=installed) == []


def test_missing_ofl_lists_only_the_absent_families_in_lock_order(tmp_path):
    lock = write_lock(
        tmp_path / "lock.json",
        [family("Zeta", "z.ttf"), family("Alpha", "a.ttf"), family("Mid", "m.ttf"), family("Beta", "b.ttf")],
    )
    assert families_of(missing_ofl(lock, installed=[font("Alpha", "a.ttf"), font("Mid", "m.ttf")])) == ["Zeta", "Beta"]


def test_missing_ofl_ignores_case_like_windows_does(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Gothic A1", "g.ttf")])
    assert missing_ofl(lock, installed=[font("gothic a1", "g.ttf", ps="g")]) == []


def test_missing_ofl_does_not_accept_a_look_alike_family(tmp_path):
    # "Pretendard Light" is a different family (a different file) from "Pretendard".
    lock = write_lock(tmp_path / "lock.json", [family("Pretendard Light", "l.ttf")])
    assert families_of(missing_ofl(lock, installed=[font("Pretendard", "l.ttf")])) == ["Pretendard Light"]


def test_missing_ofl_ignores_the_retired_list(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Alpha", "a.ttf")])
    data = json.loads(lock.read_text(encoding="utf-8"))
    data["retired"] = [{"file": "old.otf", "sha256": "1" * 64, "registryValue": "Old Sans (TrueType)"}]
    lock.write_text(json.dumps(data), encoding="utf-8")
    assert missing_ofl(lock, installed=[font("Alpha", "a.ttf")]) == []


# --- every locked file, not only its family (minor m11) ---------------------------------------------------------


def test_missing_ofl_checks_every_locked_file_of_an_installed_family(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Gothic A1", "GothicA1-Regular.ttf", "GothicA1-Black.ttf")])
    problems = missing_ofl(lock, installed=[font("Gothic A1", "GothicA1-Regular.ttf")])
    assert problems == ["Gothic A1: GothicA1-Black.ttf is not installed"]


def test_missing_ofl_wants_the_locked_bytes_not_only_the_names(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Alpha", "Alpha-Regular.ttf")])
    other_build = font("Alpha", "Alpha-Regular.ttf", sha="f" * 64)
    assert missing_ofl(lock, installed=[other_build]) == [
        "Alpha: Alpha-Regular.ttf is installed with other bytes (sha256 differs from the lock)"]


def test_missing_ofl_reports_an_installed_twin_outside_the_lock(tmp_path):
    # A machine-wide Pretendard OTF has the family name of the locked TTF: Windows may pick it for the typeface.
    lock = write_lock(tmp_path / "lock.json", [family("Pretendard", "Pretendard-Regular.ttf")])
    twin = font("Pretendard", "Pretendard-Regular.otf", sha="e" * 64, ps="Pretendard-Regular")
    problems = missing_ofl(lock, installed=[font("Pretendard", "Pretendard-Regular.ttf"), twin])
    assert problems == ["Pretendard: Pretendard-Regular.otf, a font file outside the lock, has this family name "
                        "too (Windows may use it instead)"]
    # the same locked bytes installed twice (per user and machine-wide) are no twin
    again = InstalledFont("other/Pretendard-Regular.ttf", frozenset({"Pretendard"}),
                          frozenset({"Pretendard-Regular"}), digest("Pretendard-Regular.ttf"))
    assert missing_ofl(lock, installed=[font("Pretendard", "Pretendard-Regular.ttf"), again]) == []
    # another build of the locked file next to the locked one is a twin as well
    older = InstalledFont("old/Pretendard-Regular.ttf", frozenset({"Pretendard"}), frozenset({"Pretendard-Regular"}),
                          "d" * 64)
    assert families_of(missing_ofl(lock, installed=[font("Pretendard", "Pretendard-Regular.ttf"), older])) == [
        "Pretendard"]


def test_installed_fonts_reads_the_names_and_hashes_the_bytes(tmp_path):
    data = ttf(records=[(1, 3, 1, 0x412, "테스트 산스")])  # family "Test Sans" (and a Korean record), PS TestSans-Bold
    path = tmp_path / "TestSans-Bold.ttf"
    path.write_bytes(data)
    (tmp_path / "broken.ttf").write_bytes(b"not a font")
    fonts = fontcheck.installed_fonts([str(path), str(tmp_path / "broken.ttf"), str(path)])
    assert len(fonts) == 1  # the unreadable file yields nothing; the same path twice is one file
    [record] = fonts
    assert record.families == {"Test Sans", "테스트 산스"} and record.postscript_names == {"TestSans-Bold"}
    assert record.sha256() == hashlib.sha256(data).hexdigest()


@pytest.mark.skipif(sys.platform != "win32", reason="reads the Windows font registry")
def test_installed_families_reads_the_windows_registry():
    families = installed_families()
    assert families and all(isinstance(name, str) for name in families)


# --- lock_postscript_names (M1-R22) --------------------------------------------------------------------------


def test_lock_postscript_names_lists_every_file_of_every_family(tmp_path):
    lock = write_lock(tmp_path / "lock.json", [family("Alpha Sans", "a-r.ttf", "a-b.ttf"), family("Beta", "b.ttf")])
    data = json.loads(lock.read_text(encoding="utf-8"))
    for fam in data["families"]:
        for f in fam["files"]:
            f["postscriptName"] = f["file"].split(".")[0].replace("-", "").upper()
    data["retired"] = [{"file": "old.otf", "sha256": "1" * 64, "registryValue": "Old Sans (TrueType)"}]
    lock.write_text(json.dumps(data), encoding="utf-8")
    assert lock_postscript_names(lock) == {"AR", "AB", "B"}  # retired files are no longer in the lock


def test_lock_postscript_names_refuses_a_file_without_one(tmp_path):
    entry = family("Alpha Sans", "a.ttf")
    del entry["files"][0]["postscriptName"]
    lock = write_lock(tmp_path / "lock.json", [entry])
    with pytest.raises(ValueError, match="a.ttf"):
        lock_postscript_names(lock)


# --- the committed lock file ---------------------------------------------------------------------------------

# Ruling M1-R29: static TrueType (glyf) families that PowerPoint embeds as subsets and that have no family-name twin
# in the Windows system font folder, plus one OpenType-CFF family for the atlas slide fonts/01 (the bitmap sample).
# file -> (family = nameID 1, fullName = nameID 4, postscriptName = nameID 6)
TRUETYPE_FILES = {
    "GothicA1-Regular.ttf": ("Gothic A1", "Gothic A1 Regular", "GothicA1-Regular"),
    "GothicA1-Bold.ttf": ("Gothic A1", "Gothic A1 Bold", "GothicA1-Bold"),
    "Pretendard-Regular.ttf": ("Pretendard", "Pretendard Regular", "Pretendard-Regular"),
    "Pretendard-Bold.ttf": ("Pretendard", "Pretendard Bold", "Pretendard-Bold"),
    "Pretendard-Light.ttf": ("Pretendard Light", "Pretendard Light", "Pretendard-Light"),
    "Pretendard-Black.ttf": ("Pretendard Black", "Pretendard Black", "Pretendard-Black"),
    "GowunBatang-Regular.ttf": ("Gowun Batang", "Gowun Batang Regular", "GowunBatang-Regular"),
    "GowunBatang-Bold.ttf": ("Gowun Batang", "Gowun Batang Bold", "GowunBatang-Bold"),
    "NanumGothic-Regular.ttf": ("NanumGothic", "NanumGothic", "NanumGothic"),
    "NanumGothic-Bold.ttf": ("NanumGothic", "NanumGothicBold", "NanumGothicBold"),
    "NanumGothic-ExtraBold.ttf": ("NanumGothicExtraBold", "NanumGothicExtraBold", "NanumGothicExtraBold"),
}
CFF_FILES = {"SourceSans3-Regular.otf": ("Source Sans 3", "Source Sans 3", "SourceSans3-Regular")}
# The OpenType-CFF files the previous lock installed, with their per-user registry value names (read from HKCU on the
# author's PC); install-fonts.ps1 removes them.
RETIRED = {
    "NotoSansKR-Regular.otf": "Noto Sans KR (TrueType)",
    "NotoSansKR-Bold.otf": "Noto Sans KR Bold (TrueType)",
    "NotoSansKR-Light.otf": "Noto Sans KR Light (TrueType)",
    "NotoSansKR-Black.otf": "Noto Sans KR Black (TrueType)",
    "NotoSerifKR-Regular.otf": "Noto Serif KR (TrueType)",
    "NotoSerifKR-Bold.otf": "Noto Serif KR Bold (TrueType)",
    "Pretendard-Regular.otf": "Pretendard Regular (TrueType)",
    "Pretendard-Bold.otf": "Pretendard Bold (TrueType)",
}


def load_lock():
    return json.loads(LOCK.read_text(encoding="utf-8"))


def lock_files():
    return [(fam["family"], f) for fam in load_lock()["families"] for f in fam["files"]]


def test_lock_covers_the_required_faces():
    files = {f["file"]: (family_name, f["fullName"], f["postscriptName"]) for family_name, f in lock_files()}
    assert files == {**TRUETYPE_FILES, **CFF_FILES}


def test_lock_is_truetype_except_the_one_cff_bitmap_sample():
    formats = {f["file"]: f["format"] for _, f in lock_files()}
    assert {name for name, fmt in formats.items() if fmt == "ttf"} == set(TRUETYPE_FILES)
    assert {name for name, fmt in formats.items() if fmt == "otf-cff"} == set(CFF_FILES)
    for fam in load_lock()["families"]:  # a family is all CFF or all TrueType
        assert len({f["format"] for f in fam["files"]}) == 1, fam["family"]


def test_lock_entries_are_well_formed_and_static_and_ofl():
    seen = set()
    for fam in load_lock()["families"]:
        assert fam["license"] == "OFL-1.1"
        assert fam["family"] and fam["files"]
    for _, f in lock_files():
        name = f["file"]
        assert name not in seen
        seen.add(name)
        assert re.fullmatch(r"[A-Za-z0-9_-]+\.(ttf|otf)", name), name  # a plain leaf name, never a path
        assert "[" not in name and "VF" not in name and "Variable" not in name  # static files only
        assert re.fullmatch(r"[0-9a-f]{64}", f["sha256"]), name
        assert f["url"].startswith("https://") and f["url"].endswith("/" + name), name
        assert f["format"] == ("otf-cff" if name.endswith(".otf") else "ttf"), name
        assert f["fullName"], name
        assert re.fullmatch(r"[A-Za-z0-9-]+", f["postscriptName"]), name  # nameID 6: printable ASCII, no spaces


def test_lock_urls_are_pinned_to_a_commit_not_a_moving_branch():
    for _, f in lock_files():
        assert re.search(r"/[0-9a-f]{40}/", f["url"]), f["url"]


def test_lock_postscript_names_of_the_committed_lock():
    expected = {ps for _, _, ps in TRUETYPE_FILES.values()} | {ps for _, _, ps in CFF_FILES.values()}
    assert lock_postscript_names() == lock_postscript_names(LOCK) == expected


def test_lock_retires_the_cff_files_of_the_previous_lock():
    retired = load_lock()["retired"]
    assert {r["file"]: r["registryValue"] for r in retired} == RETIRED
    current = {f["file"] for _, f in lock_files()}
    for r in retired:
        assert set(r) == {"file", "sha256", "registryValue"}
        assert re.fullmatch(r"[A-Za-z0-9_-]+\.otf", r["file"]) and r["file"] not in current
        assert re.fullmatch(r"[0-9a-f]{64}", r["sha256"]), r["file"]
    # Pretendard's TrueType files have the full names of the retired .otf files, so their registry values have the
    # same names: the installer must remove the old values before it writes the new ones.
    new_values = {f"{f['fullName']} (TrueType)" for _, f in lock_files()}
    assert new_values & set(RETIRED.values()) == {"Pretendard Regular (TrueType)", "Pretendard Bold (TrueType)"}


def user_font_file(name):
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts" / name


@pytest.mark.skipif(sys.platform != "win32", reason="reads the per-user font folder")
def test_installed_lock_files_have_the_names_and_outlines_the_lock_says():
    from fontTools.ttLib import TTFont

    checked = 0
    for family_name, f in lock_files():
        path = user_font_file(f["file"])
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != f["sha256"]:
            continue
        font = TTFont(str(path), lazy=True)
        try:
            names = font["name"]
            assert names.getName(1, 3, 1, 0x409).toUnicode() == family_name, f["file"]
            assert names.getName(4, 3, 1, 0x409).toUnicode() == f["fullName"], f["file"]
            assert names.getName(6, 3, 1, 0x409).toUnicode() == f["postscriptName"], f["file"]
            outlines = ("glyf" in font, "CFF " in font)
            assert outlines == ((True, False) if f["format"] == "ttf" else (False, True)), f["file"]
            assert "fvar" not in font, f["file"]
            assert font["OS/2"].fsType == 0, f["file"]  # installable embedding: PowerPoint may embed it
        finally:
            font.close()
        checked += 1
    if not checked:
        pytest.skip("no lock-file font is installed for this user")


@pytest.mark.skipif(sys.platform != "win32", reason="reads the Windows font registry")
def test_no_lock_family_has_a_twin_among_the_system_fonts():
    # M1-R21/R29: Windows resolves a family name to the system font when one has the same name (Noto Sans KR has a
    # variable one there), so PowerPoint would embed that program instead of the per-user file.
    system = set()
    for path in fontcheck._registry_font_files(user=False):
        system |= {name.casefold() for name in fontcheck._family_names(path)}
    assert len(system) > 50  # the system fonts were read
    twins = [fam["family"] for fam in load_lock()["families"] if fam["family"].casefold() in system]
    assert not twins
