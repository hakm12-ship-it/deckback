"""cloudfonts.py (ruling M8-R2): names only, and (M8-R4) the check that names the families the installer skips: cloud fonts win."""

import json

from harness.fonts import cloudfonts


def make_cloud(root, families):
    for name, files in families.items():
        folder = root / name
        folder.mkdir(parents=True)
        for file in files:
            (folder / file).write_bytes(b"not a real font")


def test_snapshot_lists_family_folders_with_font_files_by_name_only(tmp_path):
    make_cloud(tmp_path, {"Montserrat": ["123.ttf", "456.ttf"], "Aptos Display": ["7.otf"], "Empty": [], "Notes": ["a.txt"]})
    (tmp_path / "loose.ttf").write_bytes(b"x")  # a file at the top is no family
    snap = cloudfonts.snapshot(tmp_path)
    assert snap == {"count": 2, "names": ["Aptos Display", "Montserrat"]}
    assert "ttf" not in json.dumps(snap) and str(tmp_path) not in json.dumps(snap)  # no file, no path


def test_no_cloud_folder_is_none_not_an_error(tmp_path):
    assert cloudfonts.snapshot(tmp_path / "missing") is None and cloudfonts.cloud_families(tmp_path / "missing") is None


def test_default_dir_follows_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv(cloudfonts.ENV, str(tmp_path))
    assert cloudfonts.default_dir() == tmp_path
    monkeypatch.delenv(cloudfonts.ENV)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert cloudfonts.default_dir() == tmp_path / "Microsoft" / "FontCache" / "4" / "CloudFonts"


LOCK = {"families": [{"family": "Nobile", "files": []}, {"family": "Montserrat", "files": []}]}


def test_conflicts_name_the_lock_families_that_are_cloud_fonts_regardless_of_case():
    problems = cloudfonts.conflicts(LOCK, ["montserrat", "Lato"])
    assert len(problems) == 1 and problems[0].startswith("Montserrat: is an Office cloud font already (M8-R4)")
    assert cloudfonts.conflicts(LOCK, ["Lato"]) == [] and cloudfonts.conflicts(LOCK, None) == []


def test_check_warns_of_skipped_families_and_never_refuses(tmp_path, capsys):
    make_cloud(tmp_path / "cloud", {"Montserrat": ["1.ttf"]})
    lock = tmp_path / "lock.json"
    lock.write_text(json.dumps(LOCK), encoding="utf-8")
    assert cloudfonts.main(["check", "--lock", str(lock), "--folder", str(tmp_path / "cloud")]) == 0
    captured = capsys.readouterr()
    assert "warning: Montserrat" in captured.err and "will be skipped" in captured.out
    assert cloudfonts.main(["check", "--lock", str(lock), "--folder", str(tmp_path / "none")]) == 0


def test_the_committed_tier_b_lock_has_no_cloud_family_among_the_snapshot_of_its_round():
    lock = json.loads(cloudfonts.DEFAULT_LOCK.read_text(encoding="utf-8"))
    # the cloud families PowerPoint had downloaded when the lock was made (r0): none of the lock's families is among them
    r0_cloud = ["Abadi", "Aptos", "Atkinson Hyperlegible Next", "Barlow", "DengXian", "Fira Sans", "Heebo", "Lato",
                "Livvic", "Montserrat", "Nunito", "Open Sans", "Poppins", "Raleway", "Titillium Web", "Work Sans"]
    assert cloudfonts.conflicts(lock, r0_cloud) == []
