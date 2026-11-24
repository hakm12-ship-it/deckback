"""Tests for the atlas build CLI (harness/atlas/build.py), the deck framework and the manifest.

Every build here except `test_missing_ofl_font_fails_fast` monkeypatches `harness.fonts.fontcheck.missing_ofl` to
return [] (ruling M1-R3): python-pptx authoring needs no installed fonts and CI has none.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

import pytest
from lxml import etree
from pptx import Presentation
from pptx.util import Pt

from harness.atlas import build
from harness.atlas import decks
from harness.atlas.conftest import feature_problems, run_build
from harness.atlas.deck import LABEL_NAME, ROLES, AtlasDeck
from harness.atlas.sections.fonts import CFF_FAMILY
from harness.fonts import fontcheck

LOCK = Path(fontcheck.__file__).with_name("fonts.lock.json")
LOCK_FAMILIES = {f["family"] for f in json.loads(LOCK.read_text(encoding="utf-8"))["families"]}
TRUETYPE_FAMILIES = {f["family"] for f in json.loads(LOCK.read_text(encoding="utf-8"))["families"]
                     if all(file["format"] == "ttf" for file in f["files"])}
OFL_FACES = {font.family for font in ROLES["ofl"].values()} | {CFF_FAMILY}  # the typefaces an ofl atlas names
THEME_REF = re.compile(r"^\+(mj|mn)-(lt|ea|cs)$")
NOT_DRAWN = {"\t"}  # a tab in a:t is a layout control (it advances to the next tab stop); no glyph is looked up
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def label_of(slide):
    labels = [shape for shape in slide.shapes if shape.name == LABEL_NAME]
    assert len(labels) == 1, f"slide has {len(labels)} label shapes"
    return labels[0]


def test_missing_ofl_font_fails_fast(monkeypatch, tmp_path, capsys):
    problem = "Pretendard: Pretendard-Bold.ttf is not installed"  # fontcheck checks each locked file (minor m11)
    monkeypatch.setattr(fontcheck, "missing_ofl", lambda *args, **kwargs: [problem])
    out = tmp_path / "out"
    code = build.main(["--deck", "atlas", "--fonts", "ofl", "--out", str(out)])
    assert code == 3
    assert problem in capsys.readouterr().err
    assert not out.exists()  # nothing written, not even the output directory


def test_unreadable_font_registry_fails_closed(monkeypatch, tmp_path, capsys):
    # On a PC where the installed fonts cannot be listed (e.g. no winreg), the OFL build must stop, not guess.
    def boom(*args, **kwargs):
        raise ImportError("No module named 'winreg'")

    monkeypatch.setattr(fontcheck, "missing_ofl", boom)
    out = tmp_path / "out"
    assert build.main(["--deck", "atlas", "--fonts", "ofl", "--out", str(out)]) == 3
    assert "cannot check" in capsys.readouterr().err
    assert not out.exists()


def test_windows_font_build_skips_the_ofl_check(monkeypatch, tmp_path):
    def must_not_be_called(*args, **kwargs):
        raise AssertionError("--fonts windows must not run the OFL font check")

    monkeypatch.setattr(fontcheck, "missing_ofl", must_not_be_called)
    assert build.main(["--deck", "atlas", "--fonts", "windows", "--out", str(tmp_path)]) == 0
    manifest = json.loads((tmp_path / "atlas.manifest.json").read_text(encoding="utf-8"))
    assert manifest["fonts"] == "windows"
    prs = Presentation(str(tmp_path / "atlas.pptx"))
    run = label_of(prs.slides[0])._element.xpath(".//a:r/a:rPr")[0]
    assert run.xpath("./a:latin/@typeface") == [ROLES["windows"]["BODY"].family]


def test_windows_font_build_refuses_the_public_corpus_and_other_locations(monkeypatch, capsys):
    monkeypatch.setattr(fontcheck, "missing_ofl", lambda *args, **kwargs: [])
    root = Path(build.REPO_ROOT)
    for target in (root / "corpus" / "generated" / "never-written", root / "harness" / "never-written"):
        try:
            assert build.main(["--deck", "atlas", "--fonts", "windows", "--out", str(target)]) == 2
            err = capsys.readouterr().err
            assert "out/" in err and "corpus/private/" in err
            assert str(target) not in err  # no paths in messages
            assert not target.exists()
        finally:  # a broken guard must not leave a deck inside the repository
            shutil.rmtree(target, ignore_errors=True)


def test_windows_output_is_allowed_only_in_out_private_and_temp():
    allowed = build.windows_output_allowed
    root = Path(build.REPO_ROOT)
    assert allowed(root / "out")
    assert allowed(root / "out" / "atlas")
    assert allowed(root / "corpus" / "private" / "decks")
    assert allowed(Path(tempfile.gettempdir()) / "deckback-test")
    assert not allowed(root / "corpus" / "generated")
    assert not allowed(root / "corpus" / "generated" / "out")
    assert not allowed(root / "corpus")
    assert not allowed(root / "harness")
    assert not allowed(root)
    assert not allowed(root / "outside")  # a name that merely starts with "out"
    assert not allowed(root / "corpus" / "privateer")


@pytest.mark.parametrize(
    "size, size_type, presentation_format",
    [((960, 540), None, "Widescreen"), ((720, 540), "screen4x3", "On-screen Show (4:3)"),
     ((1000, 1000), None, "Custom")],
)
def test_slide_size_type_and_app_properties_follow_the_size(tmp_path, size, size_type, presentation_format):
    deck = AtlasDeck("ofl", size)
    deck.slide("shapes", ["grpSp"])
    deck.slide("shapes", ["grpSp"], hidden=True)
    path = deck.save(tmp_path / "d.pptx")
    with zipfile.ZipFile(path) as zf:
        presentation = etree.fromstring(zf.read("ppt/presentation.xml"))
        app = etree.fromstring(zf.read("docProps/app.xml"))
    sld_sz = presentation.find(f"{{{P_NS}}}sldSz")
    assert (int(sld_sz.get("cx")), int(sld_sz.get("cy"))) == (Pt(size[0]), Pt(size[1]))
    assert sld_sz.get("type") == size_type
    values = {etree.QName(e).localname: e.text for e in app}
    assert values["PresentationFormat"] == presentation_format
    assert (values["Slides"], values["HiddenSlides"]) == ("2", "1")


def test_every_declared_feature_is_on_its_slide(atlas_ofl):
    # every declared feature is checked on its own slide; prstGeom, pattFill and prstTxWarp presets are complete
    # (every one drawn on the slide is declared) -- see conftest.feature_problems
    pptx_path, manifest = atlas_ofl
    problems = feature_problems(Presentation(str(pptx_path)), manifest)
    assert not problems, "\n".join(problems)


def test_build_is_byte_deterministic(tmp_path):
    first, _ = run_build(tmp_path / "a")
    second, _ = run_build(tmp_path / "b")
    assert sha256(first) == sha256(second)
    assert sha256(tmp_path / "a" / "atlas.manifest.json") == sha256(tmp_path / "b" / "atlas.manifest.json")
    with zipfile.ZipFile(first) as zf:
        infos = zf.infolist()
        names = [info.filename for info in infos]
        assert names[0] == "[Content_Types].xml"
        assert names == sorted(names)
        assert {info.date_time for info in infos} == {(1980, 1, 1, 0, 0, 0)}
        core = zf.read("docProps/core.xml").decode("utf-8")
    assert "1980-01-01T00:00:00Z" in core
    assert not re.search(r"20\d\d-\d\d-\d\dT", core)


def test_build_is_byte_deterministic_across_processes(tmp_path):
    # Two interpreters with different hash seeds: catches output that depends on set/dict iteration order. The
    # windows font set needs no font check, so this also runs on CI (the bytes differ from an ofl build only in
    # typeface names).
    root = Path(build.REPO_ROOT)
    hashes = []
    for seed in ("1", "2"):
        out = tmp_path / f"seed{seed}"
        env = dict(os.environ, PYTHONHASHSEED=seed)
        done = subprocess.run(
            [sys.executable, "-m", "harness.atlas.build", "--deck", "atlas", "--fonts", "windows", "--out", str(out)],
            cwd=root, env=env, capture_output=True, text=True, timeout=300,
        )
        assert done.returncode == 0, done.stderr
        hashes.append((sha256(out / "atlas.pptx"), sha256(out / "atlas.manifest.json")))
    assert hashes[0] == hashes[1]


def test_every_slide_has_label_matching_manifest(atlas_ofl):
    pptx_path, manifest = atlas_ofl
    prs = Presentation(str(pptx_path))
    assert manifest["deck"] == "atlas"
    assert manifest["fonts"] == "ofl"
    assert manifest["slideSize"] == [960, 540]
    assert (prs.slide_width, prs.slide_height) == (Pt(960), Pt(540))
    assert isinstance(manifest["excluded"], list)
    slides = manifest["slides"]
    assert len(prs.slides) == len(slides)

    per_section = Counter()
    for index, (slide, entry) in enumerate(zip(prs.slides, slides, strict=True), start=1):
        assert set(entry) == {"n", "section", "id", "features", "hidden", "smoke", "knownBitmapText"}
        assert isinstance(entry["knownBitmapText"], bool)
        assert entry["n"] == index
        per_section[entry["section"]] += 1
        assert entry["id"] == f"atlas/{entry['section']}/{per_section[entry['section']]:02d}"
        assert entry["features"] and all(isinstance(f, str) and f for f in entry["features"])
        assert (slide._element.get("show") == "0") == entry["hidden"]

        label = label_of(slide)
        assert label.text_frame.text == entry["id"]
        runs = label._element.xpath(".//a:r/a:rPr")
        assert runs and all(r.get("sz") == "900" for r in runs)
        assert label.left < prs.slide_width * 0.1
        assert label.top + label.height > prs.slide_height * 0.95
        # the label is drawn last, so content never covers it
        assert slide.shapes[-1].name == LABEL_NAME


def test_every_run_sets_latin_ea_and_cs_to_a_lock_family(atlas_ofl):
    pptx_path, _ = atlas_ofl
    with zipfile.ZipFile(pptx_path) as zf:
        parts = {n: zf.read(n) for n in zf.namelist() if n.endswith(".xml")}
    seen = set()
    for name, xml in parts.items():
        for typeface in re.findall(rb'typeface="([^"]*)"', xml):
            face = typeface.decode("utf-8")
            assert face in LOCK_FAMILIES or THEME_REF.match(face), f"{name}: typeface {face!r} is not in the lock"
            seen.add(face)
        if name.startswith("ppt/slides/slide"):
            for rpr in etree.fromstring(xml).iter(f"{{{A_NS}}}rPr", f"{{{A_NS}}}endParaRPr"):
                faces = [rpr.find(f"{{{A_NS}}}{tag}") for tag in ("latin", "ea", "cs")]
                assert all(f is not None for f in faces), f"{name}: a run without latin/ea/cs"
                assert len({f.get("typeface") for f in faces}) == 1, f"{name}: latin/ea/cs name different fonts"
    # every role family and the CFF sample's family (atlas/fonts/01) are used; all of them are lock families
    assert {face for face in seen if not THEME_REF.match(face)} == OFL_FACES


def _installed_cmaps(families):
    """{family: set of code points every installed face of the family maps}; skips the test when unavailable."""
    if sys.platform != "win32":
        pytest.skip("reads the Windows font registry")
    from fontTools.ttLib import TTFont

    cmaps = {}
    for path in fontcheck._registry_font_files():
        names = fontcheck._family_names(path) & families
        if not names or path.lower().endswith((".ttc", ".otc")):
            continue
        font = TTFont(path, lazy=True)
        points = set(font.getBestCmap())
        font.close()
        for name in names:
            cmaps[name] = cmaps[name] & points if name in cmaps else points
    missing = families - set(cmaps)
    if missing:
        pytest.skip(f"OFL fonts not installed: {sorted(missing)}")
    return cmaps


def test_ofl_runs_use_only_glyphs_their_font_has(atlas_ofl):
    # PowerPoint substitutes another font (e.g. Malgun Gothic) for a glyph the named font lacks, and that font then
    # ends up embedded in the public PDF. Every character of every run must be in its own font.
    pptx_path, _ = atlas_ofl
    prs = Presentation(str(pptx_path))
    runs = []
    for slide in prs.slides:
        for t in slide._element.iter(f"{{{A_NS}}}t"):
            run = t.getparent()
            face = run.find(f"{{{A_NS}}}rPr/{{{A_NS}}}latin").get("typeface")
            runs.append((face, t.text or ""))
    assert {face for face, _ in runs} == OFL_FACES  # every family is checked, against its own installed files
    cmaps = _installed_cmaps({face for face, _ in runs})
    lacking = {(face, ch) for face, text in runs for ch in text if ch not in NOT_DRAWN and ord(ch) not in cmaps[face]}
    assert not lacking, f"glyphs missing from their font: {sorted(lacking)}"


def test_theme_names_only_the_role_fonts(atlas_ofl):
    pptx_path, _ = atlas_ofl
    with zipfile.ZipFile(pptx_path) as zf:
        theme = zf.read("ppt/theme/theme1.xml").decode("utf-8")
    assert "<a:font " not in theme  # no per-script fallbacks (they named Malgun Gothic, MS PGothic, ...)
    major = re.search(r"<a:majorFont>(.*?)</a:majorFont>", theme, flags=re.S).group(1)
    minor = re.search(r"<a:minorFont>(.*?)</a:minorFont>", theme, flags=re.S).group(1)
    for tag in ("latin", "ea", "cs"):
        assert f'<a:{tag} typeface="{ROLES["ofl"]["HEAD"].family}"/>' in major
        assert f'<a:{tag} typeface="{ROLES["ofl"]["BODY"].family}"/>' in minor


def test_ofl_roles_name_lock_families_only():
    for role, font in ROLES["ofl"].items():
        assert font.family in LOCK_FAMILIES and font.family in TRUETYPE_FAMILIES, role
    # ruling M1-R29: static TrueType families without a system-font twin
    assert {role: (font.family, font.bold) for role, font in ROLES["ofl"].items()} == {
        "HEAD": ("Gothic A1", True),
        "BODY": ("Pretendard", False),
        "SERIF": ("Gowun Batang", False),
        "ALT": ("NanumGothic", False),
        "BODY_LIGHT": ("Pretendard Light", False),
        "BODY_BLACK": ("Pretendard Black", False),
        "ALT_XBOLD": ("NanumGothicExtraBold", False),
    }
    assert set(ROLES["ofl"]) == set(ROLES["windows"])
    assert ROLES["windows"]["HEAD"].family == "Malgun Gothic" and ROLES["windows"]["HEAD"].bold
    assert ROLES["windows"]["SERIF"].family == "Batang"
    assert ROLES["windows"]["ALT"].family == "Gulim"


def test_unknown_deck_is_a_usage_error(monkeypatch, tmp_path):
    monkeypatch.setattr(fontcheck, "missing_ofl", lambda *args, **kwargs: [])
    with pytest.raises(SystemExit) as exc:
        build.main(["--deck", "nonexistent", "--fonts", "ofl", "--out", str(tmp_path / "x")])
    assert exc.value.code == 2
    assert not (tmp_path / "x").exists()


# --- the atlas-smoke recipe (M1-R5, M1-R24) and dropping slides ------------------------------------------------------


def comparable(entry):
    """A manifest slide entry without its position, which changes when slides before it are dropped."""
    return {key: value for key, value in entry.items() if key != "n"}


def test_atlas_smoke_is_the_smoke_slides_of_the_atlas_under_their_atlas_ids(atlas_ofl, tmp_path):
    _, atlas = atlas_ofl
    expected = [entry for entry in atlas["slides"] if entry["smoke"]]
    path, smoke = run_build(tmp_path, "atlas-smoke")
    assert len(expected) >= 30
    assert smoke["deck"] == "atlas-smoke" and smoke["fonts"] == "ofl"
    assert smoke["slideSize"] == atlas["slideSize"] and smoke["excluded"] == atlas["excluded"]
    assert [comparable(e) for e in smoke["slides"]] == [comparable(e) for e in expected]
    assert [e["n"] for e in smoke["slides"]] == list(range(1, len(expected) + 1))  # n is the position in this deck
    assert any(e["knownBitmapText"] for e in smoke["slides"]) and not any(e["hidden"] for e in smoke["slides"])

    prs = Presentation(str(path))
    assert [label_of(slide).text_frame.text for slide in prs.slides] == [e["id"] for e in expected]
    assert feature_problems(prs, smoke) == []


def test_atlas_smoke_package_holds_only_the_parts_of_its_slides(tmp_path):
    path, smoke = run_build(tmp_path, "atlas-smoke")
    prs = Presentation(str(path))
    charts = sum(shape.has_chart for slide in prs.slides for shape in slide.shapes)
    assert charts > 0
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        assert sorted(n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)) == sorted(
            f"ppt/slides/slide{i}.xml" for i in range(1, len(smoke["slides"]) + 1))
        assert len([n for n in names if re.fullmatch(r"ppt/charts/chart\d+\.xml", n)]) == charts
        assert len([n for n in names if n.startswith("ppt/embeddings/")]) == charts
        assert not any(n.startswith("ppt/notesSlides/") for n in names)
        presentation = zf.read("ppt/presentation.xml")
        app = zf.read("docProps/app.xml").decode("utf-8")
    assert len(re.findall(rb"<p:sldId ", presentation)) == len(smoke["slides"])
    assert f"<Slides>{len(smoke['slides'])}</Slides>" in app and "<HiddenSlides>0</HiddenSlides>" in app


def test_atlas_smoke_is_byte_deterministic(tmp_path):
    first, _ = run_build(tmp_path / "a", "atlas-smoke")
    second, _ = run_build(tmp_path / "b", "atlas-smoke")
    assert sha256(first) == sha256(second)
    assert sha256(tmp_path / "a" / "atlas-smoke.manifest.json") == sha256(tmp_path / "b" / "atlas-smoke.manifest.json")


def test_drop_slides_removes_the_slides_and_renumbers():
    spec = decks.RECIPES["atlas-smoke"]("ofl")[0]
    full = decks.build_deck(spec, "ofl")
    ids = [e["id"] for e in full.manifest()["slides"]]
    drop = [ids[0], ids[5], ids[-1]]
    trimmed = decks.build_deck(spec, "ofl", drop=drop)
    manifest = trimmed.manifest()
    assert [e["id"] for e in manifest["slides"]] == [i for i in ids if i not in drop]
    assert [e["n"] for e in manifest["slides"]] == list(range(1, len(ids) - 2))
    assert len(trimmed.prs.slides) == len(ids) - 3
    with pytest.raises(ValueError, match="atlas/nope/99"):
        decks.build_deck(spec, "ofl", drop=["atlas/nope/99"])
    with pytest.raises(ValueError, match="no slide"):
        decks.build_deck(spec, "ofl", drop=ids)  # a deck without slides cannot be saved
