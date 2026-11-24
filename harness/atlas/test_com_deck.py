"""Tests for the COM-authored supplement to the feature atlas (harness/atlas/com_deck.py, author_com.ps1).

The manifest, the assets, the plan and the script's rules are checked without PowerPoint. The test that authors the deck
(`test_authored_deck_really_has_the_features`) drives PowerPoint through COM and needs `pytest --run-powerpoint`.
The tests of the script's timeout paths run the script on Windows with the module's test hooks: they never reach
PowerPoint.
"""

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import pytest
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.opc.package import Part
from pptx.opc.packuri import PackURI

from harness.atlas import com_deck, deck as deck_module, export
from harness.atlas.drawingml import emu
from harness.atlas.features import drawn_presets
from harness.ppt.never_stop import LeftRunning, run_script

WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="author_com.ps1 is Windows PowerShell")
IDS = [
    "atlas-com/smartart/01", "atlas-com/smartart/02", "atlas-com/smartart/03", "atlas-com/smartart/04",
    "atlas-com/svg/01", "atlas-com/svg/02", "atlas-com/svg/03",
    "atlas-com/pictureEffects/01", "atlas-com/pictureEffects/02",
]
SCRIPT = Path(com_deck.AUTHOR_PS1)
SVG_NS = {"s": "http://www.w3.org/2000/svg"}
HANGUL = re.compile("[가-힣]")


def powerpoint_pids():
    """The POWERPNT process ids, read with tasklist (never through COM)."""
    done = subprocess.run(["tasklist", "/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"],
                          capture_output=True, text=True, errors="replace")
    return sorted(int(line.split(",")[1].strip('"')) for line in done.stdout.splitlines()
                  if line.lower().startswith('"powerpnt.exe"'))


def test_manifest_lists_every_slide():
    manifest = com_deck.manifest()
    assert [entry["id"] for entry in manifest["slides"]] == IDS
    assert len(manifest["slides"]) == 9
    assert all(entry["features"] and all(isinstance(f, str) and f for f in entry["features"])
               for entry in manifest["slides"])
    assert manifest["excluded"] == []  # nothing failed: authoring succeeded


def test_manifest_has_the_shape_deck_py_writes():
    manifest = com_deck.manifest()
    assert list(manifest) == ["deck", "fonts", "slideSize", "slides", "excluded"]
    assert (manifest["deck"], manifest["fonts"], manifest["slideSize"]) == ("atlas-com", "ofl", [960, 540])
    for number, entry in enumerate(manifest["slides"], 1):
        assert set(entry) == {"n", "section", "id", "features", "hidden", "smoke", "knownBitmapText"}
        assert entry["n"] == number
        assert entry["id"].startswith(f"atlas-com/{entry['section']}/")
        assert (entry["hidden"], entry["smoke"], entry["knownBitmapText"]) == (False, False, False)
    assert [entry["section"] for entry in manifest["slides"]] == ["smartart"] * 4 + ["svg"] * 3 + ["pictureEffects"] * 2


def test_every_declared_feature_has_a_check():
    # A manifest feature is a checkable promise about its slide: com_deck knows how to check each one on the authored
    # deck (its own names, else the atlas vocabulary of features.py).
    for entry in com_deck.manifest()["slides"]:
        for feature in entry["features"]:
            assert com_deck.check_for(feature) is not None, f"{entry['id']}: {feature}"
    assert com_deck.check_for("smartArt:no-such-layout") is None
    assert com_deck.check_for("no:such:feature") is None


def test_a_section_may_be_camel_case_but_still_a_plain_word():
    # harness/atlas/deck.py: `pictureEffects` is a section of this deck; the first character stays lowercase, and nothing
    # that would break an id (`<prefix>/<section>/<nn>`) or a feature name is a section.
    deck = deck_module.AtlasDeck("ofl", (960, 540), deck="x")
    deck.slide("pictureEffects", ["pic"])
    deck.slide("picture-effects2", ["pic"])
    assert [entry["id"] for entry in deck.manifest()["slides"]] == ["x/pictureEffects/01", "x/picture-effects2/01"]
    for bad in ("PictureEffects", "picture effects", "picture/effects", "-effects", "", "pic:ture", "ünï"):
        with pytest.raises(ValueError, match="section must be a slug"):
            deck.slide(bad, ["pic"])


def test_the_slide_table_names_what_each_slide_authors():
    table = {slide.section: [] for slide in com_deck.SLIDES}
    for slide in com_deck.SLIDES:
        table[slide.section].append(slide.variant)
    assert table == {"smartart": ["process1", "cycle2", "hierarchy1", "pyramid1"],
                     "svg": ["filled", "stroked", "clipped"], "pictureEffects": ["pencilSketch", "blur"]}
    assert {slide.kind for slide in com_deck.SLIDES} == {"smartArt", "svgIcon", "artisticEffects"}
    for slide in com_deck.SLIDES:
        if slide.section == "smartart":  # Korean node text, in the deck's body font
            assert slide.spec["layout"].startswith("urn:microsoft.com/office/officeart/2005/8/layout/")
            assert slide.spec["nodes"] and all(HANGUL.search(text) for text in slide.spec["nodes"])


def test_a_feature_that_failed_windowless_is_excluded_with_its_reason_and_its_slide_is_left_out():
    manifest = com_deck.manifest({"atlas-com/smartart/02": "SmartArtLayouts: Object does not exist (0x80048010)",
                                  "atlas-com/pictureEffects/01": "PictureEffects.Insert: not available"})
    ids = [entry["id"] for entry in manifest["slides"]]
    assert ids == [i for i in IDS if i not in ("atlas-com/smartart/02", "atlas-com/pictureEffects/01")]
    assert [entry["n"] for entry in manifest["slides"]] == list(range(1, 8))  # n is the position in the deck
    assert manifest["excluded"] == [
        {"feature": "smartArt:cycle2",
         "reason": "SmartArtLayouts: Object does not exist (0x80048010); windowless run, no window is opened"},
        {"feature": "artisticEffects:pencilSketch",
         "reason": "PictureEffects.Insert: not available; windowless run, no window is opened"},
    ]
    # the slides that remain keep their ids and features
    assert all(entry["features"] for entry in manifest["slides"])


def test_no_slide_left_is_an_error_and_an_unknown_slide_too():
    with pytest.raises(ValueError, match="no slide would be left"):
        com_deck.manifest({i: "x" for i in IDS})
    with pytest.raises(ValueError, match="no such slide"):
        com_deck.manifest({"atlas-com/smartart/09": "x"})


def test_reasons_carry_no_path_and_no_line_break():
    reason = com_deck.clean_reason('Cannot open C:\\Users\\someone\\AppData\\x.svg\r\nsecond line /home/x/y.jpg')
    assert "C:" not in reason and "someone" not in reason and "\n" not in reason and "/home" not in reason
    assert "<path>" in reason
    assert len(com_deck.clean_reason("x" * 1000)) <= com_deck.REASON_LIMIT
    assert com_deck.clean_reason("") == "unknown error"


def test_assets_are_generated_at_run_time_from_strings_and_pillow(tmp_path):
    assets = com_deck.write_assets(tmp_path)
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(assets.values())
    svgs = {name: etree.fromstring((tmp_path / file).read_bytes()) for name, file in assets.items()
            if file.endswith(".svg")}
    assert sorted(svgs) == ["clipped", "filled", "stroked"]
    for root in svgs.values():
        assert root.tag == "{http://www.w3.org/2000/svg}svg" and root.get("viewBox")

    def found(root, expr):
        return root.xpath(expr, namespaces=SVG_NS)

    filled = svgs["filled"]
    assert found(filled, ".//*[@fill and not(@fill='none')]") and not found(filled, ".//*[@stroke]")
    stroked = svgs["stroked"]
    assert found(stroked, ".//s:linearGradient") and found(stroked, ".//*[@stroke-dasharray]")
    assert found(stroked, ".//*[starts-with(@stroke, 'url(#')]")
    clipped = svgs["clipped"]
    assert found(clipped, ".//s:clipPath") and found(clipped, ".//*[@clip-path]")
    assert found(clipped, ".//s:g[@transform]//s:g[@transform]//*[@transform]"), "transforms nested three deep"

    jpeg = (tmp_path / assets["photo"]).read_bytes()
    image = Image.open(io.BytesIO(jpeg))
    assert image.format == "JPEG" and image.mode == "RGB" and image.size == com_deck.PHOTO_SIZE


def test_the_base_deck_has_titles_captions_and_labels_but_none_of_the_com_content(tmp_path):
    deck = com_deck.base_deck()
    path = deck.save(tmp_path / "base.pptx")
    prs = Presentation(str(path))
    assert (prs.slide_width, prs.slide_height) == (emu(960), emu(540))
    manifest = deck.manifest()
    assert [entry["id"] for entry in manifest["slides"]] == IDS
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        names = [shape.name for shape in slide.shapes]
        assert deck_module.LABEL_NAME in names and deck_module.TITLE_NAME in names
        assert slide.shapes[-1].name == deck_module.LABEL_NAME
        assert [s.text_frame.text for s in slide.shapes if s.name == deck_module.LABEL_NAME] == [entry["id"]]
        assert not slide._element.xpath(".//p:pic | .//p:graphicFrame"), "PowerPoint adds these, not python-pptx"
    # every run names its font for latin, ea and cs (the atlas convention): Pretendard, or Gothic A1 in the titles
    a = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    assert deck.font("BODY").family == "Pretendard"
    for slide in prs.slides:
        for rpr in slide._element.iter(a + "rPr", a + "endParaRPr"):
            faces = {rpr.find(a + tag).get("typeface") for tag in ("latin", "ea", "cs")}
            assert len(faces) == 1 and faces <= {"Pretendard", "Gothic A1"}, faces


def test_the_plan_gives_every_slide_a_box_inside_the_content_area():
    deck = com_deck.base_deck()
    plan = com_deck.plan(deck)
    assert plan["slideCount"] == 9 and plan["labelName"] == deck_module.LABEL_NAME
    assert [item["id"] for item in plan["slides"]] == IDS
    assert [item["slide"] for item in plan["slides"]] == list(range(1, 10))
    x0, y0, w, h = deck.content
    for item in plan["slides"]:
        for box in item["boxes"]:
            assert x0 <= box["x"] and box["x"] + box["w"] <= x0 + w, item["id"]
            assert y0 <= box["y"] and box["y"] + box["h"] <= y0 + h - 30, item["id"]  # a caption line below
    kinds = {item["kind"] for item in plan["slides"]}
    assert kinds == {"smartArt", "svgIcon", "artisticEffects"}
    for item in plan["slides"]:
        if item["kind"] == "smartArt":
            assert item["layout"].endswith(f"/{item['variant']}") and item["font"] == "Pretendard"
            assert all(HANGUL.search(text) for text in item["nodes"])
        elif item["kind"] == "svgIcon":
            assert item["file"].endswith(".svg") and len(item["boxes"]) == 1
        else:
            assert item["file"].endswith(".jpg") and len(item["boxes"]) == 2  # the original, then the one with the effect
            assert isinstance(item["effect"], int)
    json.dumps(plan)  # the script reads it as JSON


# ---- the feature vocabulary, on slides built by hand to look like what PowerPoint writes ---------------------------------

_NS = " ".join(f'xmlns:{prefix}="{uri}"' for prefix, uri in (
    ("p", "http://schemas.openxmlformats.org/presentationml/2006/main"),
    ("a", "http://schemas.openxmlformats.org/drawingml/2006/main"),
    ("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"),
    ("dgm", "http://schemas.openxmlformats.org/drawingml/2006/diagram")))
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_XFRM = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>'


def _slide_with(shape_xml, related=()):
    """A python-pptx slide with `shape_xml` appended to its shape tree; {0}, {1}... in it are the relationship ids of
    `related` ([(part name, content type, relationship type, blob)], in that order) and literal braces are doubled."""
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    rids = [slide.part.relate_to(Part(PackURI(name), ctype, prs.part.package, blob), reltype)
            for name, ctype, reltype, blob in related]
    slide._element.cSld.spTree.append(etree.fromstring(shape_xml.format(*rids)))
    return slide


def _smartart_slide(layout, text):
    data = (f'<dgm:dataModel {_NS}><dgm:ptLst><dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>{text}</a:t></a:r></a:p></dgm:t>'
            "</dgm:pt></dgm:ptLst></dgm:dataModel>")
    layout_def = f'<dgm:layoutDef {_NS} uniqueId="{com_deck.LAYOUT}{layout}"/>'
    frame = (f'<p:graphicFrame {_NS}><p:nvGraphicFramePr><p:cNvPr id="9" name="x"/><p:cNvGraphicFramePr/><p:nvPr/>'
             f'</p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic>'
             '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
             '<dgm:relIds r:dm="{0}" r:lo="{1}"/></a:graphicData></a:graphic></p:graphicFrame>')
    return _slide_with(frame, [("/ppt/diagrams/data1.xml", "application/xml", _REL + "diagramData", data.encode()),
                               ("/ppt/diagrams/layout1.xml", "application/xml", _REL + "diagramLayout",
                                layout_def.encode())])


def test_smartart_features_are_read_from_the_diagram_parts():
    slide = _smartart_slide("process1", "기획")
    assert com_deck.missing_features(slide, ["smartArt", "smartArt:process1", "smartArt:korean"]) == []
    assert com_deck.missing_features(slide, ["smartArt:cycle2"]) == ["smartArt:cycle2"]  # another layout
    assert com_deck.missing_features(_smartart_slide("process1", "plan"), ["smartArt:korean"]) == ["smartArt:korean"]
    shape = f'<p:sp {_NS}><p:nvSpPr><p:cNvPr id="9" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>'
    assert com_deck.missing_features(_slide_with(shape), ["smartArt", "smartArt:process1", "smartArt:korean"]) == [
        "smartArt", "smartArt:process1", "smartArt:korean"]


def _picture_slide(blip_ext="", related=()):
    """A slide with one picture whose blip carries `blip_ext` (an a:ext element; the PNG is {0}, `related` follows)."""
    pic = (f'<p:pic {_NS}><p:nvPicPr><p:cNvPr id="9" name="x"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>'
           f'<a:blip r:embed="{{0}}"><a:extLst>{blip_ext}</a:extLst></a:blip><a:stretch/></p:blipFill><p:spPr>{_XFRM}'
           '<a:prstGeom prst="rect"/></p:spPr></p:pic>')
    return _slide_with(pic, [("/ppt/media/image1.png", "image/png", _REL + "image", b"png"), *related])


def test_svg_features_are_read_from_the_svg_the_picture_carries():
    ext = ('<a:ext uri="{{96DAC541-7B7A-43D3-8B79-37D633B846F1}}"><asvg:svgBlip '
           'xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="{1}"/></a:ext>')
    has = {"svg:fill": {"filled", "clipped"}, "svg:fill-opacity": {"filled", "clipped"},
           "svg:stroke-dasharray": {"stroked"}, "svg:linearGradient": {"stroked"},
           "svg:transform:nested": {"clipped"}, "svg:clipPath": {"clipped"}}
    for variant, source in com_deck.SVG_SOURCES.items():
        slide = _picture_slide(ext, [("/ppt/media/image2.svg", "image/svg+xml", _REL + "image", source.encode())])
        expected_missing = [feature for feature, variants in has.items() if variant not in variants]
        assert com_deck.missing_features(slide, ["svg", "pic", "prstGeom:rect", *has]) == expected_missing, variant
    # a picture with no svgBlip is not an SVG picture
    assert com_deck.missing_features(_picture_slide(), ["svg", "svg:fill", "pic"]) == ["svg", "svg:fill"]


def test_picture_effect_features_are_read_from_the_blip():
    ext = ('<a:ext uri="{{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}}"><a14:imgProps '
           'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><a14:imgLayer r:embed="{1}"><a14:imgEffect>'
           "<a14:artisticBlur/></a14:imgEffect></a14:imgLayer></a14:imgProps></a:ext>")
    hdphoto = ("/ppt/media/hdphoto1.wdp", "image/vnd.ms-photo", "http://schemas.microsoft.com/office/2007/relationships/hdphoto",
               b"wdp")
    slide = _picture_slide(ext, [hdphoto])
    assert com_deck.missing_features(slide, ["artisticEffects", "artisticEffects:blur"]) == []
    assert com_deck.missing_features(slide, ["artisticEffects:pencilSketch"]) == ["artisticEffects:pencilSketch"]
    assert com_deck.missing_features(_picture_slide(), ["artisticEffects"]) == ["artisticEffects"]
    assert com_deck.missing_features(slide, ["no:such:feature"]) == ["no:such:feature (not in the feature vocabulary)"]


# ---- author_com.ps1: the rules for a script that drives PowerPoint -----------------------------------------------------


def test_author_script_is_ascii_with_crlf_and_goes_through_the_module():
    data = SCRIPT.read_bytes()
    assert data.decode("ascii")  # .ps1 files are ASCII only
    assert b"\r\n" in data and not re.search(rb"(?<!\r)\n", data), "CRLF line ends"
    text = data.decode("ascii")
    assert "Invoke-DeckbackPowerPoint" in text and "DeckbackCom.psm1" in text
    assert "SaveCopyAs" in text and "AddPicture" in text and "AddSmartArt" in text and "PictureEffects" in text
    assert "[Environment]::Exit(" in text  # M1-R19: a stuck run ends the process itself
    # attaching to PowerPoint on its own, and the module's session functions (built from pieces: the static guard of
    # harness/ppt/test_com_module.ps1 scans this file too)
    for forbidden in ("New-Object -ComObject", "Get" + "ActiveObject", "Connect-" + "Deckback", "Disconnect-" + "Deckback"):
        assert forbidden not in text
    assert not re.search(r"\.\s*(Quit|Close)\s*\(", text) and not re.search(r"(?i)\bActive(Presentation|Window)", text)


def _action_text():
    match = re.search(r"\$authorAction = @'\r\n(.*?)\r\n'@", SCRIPT.read_bytes().decode("ascii"), re.S)
    assert match, "the script keeps its action in $authorAction = @' ... '@"
    return match.group(1)


@WINDOWS_ONLY
def test_the_action_passes_the_modules_own_filter(tmp_path):
    # Invoke-DeckbackPowerPoint rejects, before PowerPoint is touched, an action that reaches other presentations or
    # windows, closes or quits anything, or attaches. Ask the module's own patterns (nothing is started).
    action = tmp_path / "action.ps1"
    action.write_bytes(_action_text().encode("ascii"))
    check = tmp_path / "check.ps1"
    check.write_bytes((
        "param($Module, $ActionFile)\r\n$ErrorActionPreference = 'Stop'\r\n"
        "Import-Module -Name $Module -Force\r\n"
        "$text = [IO.File]::ReadAllText($ActionFile)\r\n"
        "$m = Get-Module DeckbackCom\r\n"
        "& $m { param($t)\r\n"
        "    $parsed = [scriptblock]::Create($t)\r\n"
        "    [pscustomobject]@{ params = $parsed.Ast.ParamBlock.Parameters.Count;"
        " forbidden = [regex]::Match($t, $script:ForbiddenInAction).Value;"
        " shared = [regex]::Match($t, $script:ForbiddenUnlessOwned).Value } | ConvertTo-Json -Compress\r\n"
        "} $text\r\n").encode("ascii"))
    module = Path(com_deck.COM_MODULE)
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(check),
                       str(module), str(action)], 120)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) == {"params": 3, "forbidden": "", "shared": ""}


def _run_author_ps1(tmp_path, *extra):
    deck = tmp_path / "base.pptx"
    prs = Presentation()
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(deck)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"slideCount": 1, "labelName": "Atlas Label", "slides": []}), encoding="utf-8")
    (tmp_path / "assets").mkdir(exist_ok=True)
    return run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
                       "-Pptx", str(deck), "-Plan", str(plan), "-Assets", str(tmp_path / "assets"),
                       "-Out", str(tmp_path / "authored.pptx"), *extra], 180)


def _json_line(text):
    lines = [line for line in text.splitlines() if line.startswith("{")]
    return json.loads(lines[-1]) if lines else None


@WINDOWS_ONLY
def test_a_timeout_is_reported_and_nothing_is_written(tmp_path):
    done = _run_author_ps1(tmp_path, "-TimeoutSec", "3", "-TestHangSec", "30")
    assert done.returncode == 2, done.stderr
    result = _json_line(done.stdout)
    assert (result["ok"], result["exitCode"], result["reason"]) == (False, 2, "timeout")
    assert not (tmp_path / "authored.pptx").exists()


@WINDOWS_ONLY
def test_a_busy_powerpoint_is_reported_as_powerpoint_busy(tmp_path):
    done = _run_author_ps1(tmp_path, "-TestBusy")
    assert done.returncode == 3, done.stderr
    result = _json_line(done.stdout)
    assert (result["ok"], result["exitCode"], result["reason"]) == (False, 3, "powerpoint-busy")
    assert not (tmp_path / "authored.pptx").exists()


@WINDOWS_ONLY
def test_a_stuck_run_still_reports_and_the_script_ends_by_itself(tmp_path):
    # -TestBlockSec: a wait that cannot be interrupted, like a PowerPoint call blocked by a dialog. M1-R19: the script
    # writes its JSON line and ends with Environment.Exit although the job is still blocked.
    pids_before = powerpoint_pids()
    done = _run_author_ps1(tmp_path, "-TimeoutSec", "1", "-TestBlockSec", "9")
    assert done.returncode == 2, done.stderr
    result = _json_line(done.stdout)
    assert (result["ok"], result["exitCode"], result["reason"]) == (False, 2, "timeout")
    assert result["stuck"] is True
    time.sleep(12)  # the orphaned job host wakes up; a stop was requested, so it must not reach PowerPoint
    assert powerpoint_pids() == pids_before, "the orphaned job host started or attached to a PowerPoint"


# ---- a busy PowerPoint is not a fault of a slide (ruling M1-R74) ----------------------------------------------------


def _action_function(name):
    """The source of the function `name` that the script's action defines (it ends at the first closing brace in column 0)."""
    match = re.search(rf"^function {name}\b.*?^\}}\r?$", _action_text(), re.S | re.M)
    assert match, f"the action defines no function {name}"
    return match.group(0)


@WINDOWS_ONLY
def test_the_action_tells_a_busy_refusal_from_other_errors(tmp_path):
    # RPC_E_CALL_REJECTED (0x80010001) and RPC_E_SERVERCALL_RETRYLATER (0x8001010A) are PowerPoint refusing a call because
    # it is busy, as while a dialog is open in it. The action cannot call the module's own test (it is private), so it has
    # its own: by HRESULT or by message, on the error or on any error it wraps. Nothing here touches PowerPoint.
    function = tmp_path / "function.ps1"
    function.write_bytes(_action_function("Test-BusyError").encode("ascii"))
    check = tmp_path / "check.ps1"
    check.write_bytes((
        "param($FunctionFile)\r\n$ErrorActionPreference = 'Stop'\r\n"
        ". ([scriptblock]::Create([IO.File]::ReadAllText($FunctionFile)))\r\n"
        "$rejected = New-Object Runtime.InteropServices.COMException('refused', -2147418111)\r\n"
        "$later = New-Object Runtime.InteropServices.COMException('refused', -2147417846)\r\n"
        "$missing = New-Object Runtime.InteropServices.COMException('Object does not exist.', -2147188720)\r\n"
        "$cases = [ordered]@{\r\n"
        "    rejected = Test-BusyError $rejected\r\n"
        "    retryLater = Test-BusyError $later\r\n"
        "    wrappedOnce = Test-BusyError (New-Object Exception('outer', $rejected))\r\n"
        "    wrappedTwice = Test-BusyError (New-Object Exception('a', (New-Object Exception('b', $later))))\r\n"
        "    messageOnly = Test-BusyError (New-Object Exception('Call was rejected by callee. (Exception from HRESULT:"
        " 0x80010001 (RPC_E_CALL_REJECTED))'))\r\n"
        "    messageOnlyRetryLater = Test-BusyError (New-Object Exception('The message filter indicated that the"
        " application is busy. (0x8001010A)'))\r\n"
        "    objectDoesNotExist = Test-BusyError $missing\r\n"
        "    wrappedOther = Test-BusyError (New-Object Exception('outer', $missing))\r\n"
        "    plain = Test-BusyError (New-Object Exception('file not found'))\r\n"
        "}\r\n$cases | ConvertTo-Json -Compress\r\n").encode("ascii"))
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(check), str(function)], 120)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) == {
        "rejected": True, "retryLater": True, "wrappedOnce": True, "wrappedTwice": True, "messageOnly": True,
        "messageOnlyRetryLater": True, "objectDoesNotExist": False, "wrappedOther": False, "plain": False}


def test_the_per_slide_catch_gives_a_busy_refusal_back_before_it_records_a_failed_slide():
    # Order matters: a failed slide is recorded (and later deleted) in the catch, so the busy check must come first and
    # must throw the error again (the job's finally still releases the references; the module then reports busy).
    action = _action_text()
    assert re.search(r"catch \{(?:\r?\n\s*#[^\n]*)*\r?\n\s*if \(Test-BusyError \$_\.Exception\) \{ throw \}\r?\n\s*\$failed\.Add\(",
                     action), "the per-slide catch must start with: if (Test-BusyError $_.Exception) { throw }"
    assert action.count("Test-BusyError $_.Exception") == 1


def _real_inputs(tmp_path):
    """The base deck, the plan and the assets com_deck.build gives author_com.ps1, written into tmp_path."""
    deck = com_deck.base_deck()
    base = deck.save(tmp_path / "base.pptx")
    assets = tmp_path / "assets"
    com_deck.write_assets(assets)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps(com_deck.plan(deck), ensure_ascii=False), encoding="utf-8")
    return base, plan, assets


def _assert_busy_run(tmp_path, *hook):
    """Run author_com.ps1 on the real plan with a busy-refusal test hook (windowless PowerPoint) and check that the run
    failed as powerpoint-busy: exit 3, no slide records, no output file, no PowerPoint left behind."""
    base, plan, assets = _real_inputs(tmp_path)
    before = powerpoint_pids()
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT), "-Pptx", str(base),
                       "-Plan", str(plan), "-Assets", str(assets), "-Out", str(tmp_path / "authored.pptx"), *hook], 300)
    result = _json_line(done.stdout)
    assert (result["ok"], result["exitCode"], result.get("reason")) == (False, 3, "powerpoint-busy"), result
    assert "slides" not in result and done.returncode == 3, (result, done.returncode)
    assert not (tmp_path / "authored.pptx").exists()
    assert powerpoint_pids() == before, "a PowerPoint the run started is still running"


@pytest.mark.powerpoint
def test_a_busy_refusal_in_the_middle_of_authoring_fails_the_run_as_powerpoint_busy(tmp_path):
    # PowerPoint refusing a call because it is busy (a dialog is open in it, possibly the author's) is not a fault of the
    # slide being authored (M1-R74). -TestBusyAtSlide 6 raises that refusal while slide 6 is authored, after slides 1-5
    # (on this PowerPoint the four SmartArt slides have failed for a reason of their own by then). The run must fail as
    # powerpoint-busy and write nothing; it must not delete slide 6 and let com_deck record it in `excluded` as a feature
    # PowerPoint cannot author.
    _assert_busy_run(tmp_path, "-TestBusyAtSlide", "6")


def test_the_action_reads_and_writes_com_properties_only_through_the_throwing_accessors():
    # PowerShell's COM adapter can turn a failing property read into $null without an error (the SmartArt layouts error
    # did). A busy refusal on a read would then fail the slide with a null-valued-expression error, and the slide would be
    # deleted and put in `excluded` (M1-R74). So every read and write of a PowerPoint property in the action goes through
    # Get-ComProperty / Set-ComProperty (InvokeMember, which throws the COM error); a direct one is a hole in the
    # busy check. Method calls already throw. (Text level: the check runs wherever the tests do.)
    action = _action_text()
    reads = re.findall(r"\$\w+\.(?:Slides|Shapes|Fill|PictureEffects|SmartArt|AllNodes|TextFrame2|TextRange|Font)\b"
                       r"|\$(?:slides|nodes)\.Count\b", action)
    writes = re.findall(r"\$(?:shape|original|range|font)\.(?:Name|Text|NameFarEast|NameComplexScript)\s*=", action)
    assert (reads, writes) == ([], []), "a property read or write that does not go through Get-ComProperty/Set-ComProperty"
    assert len(re.findall(r"Get-ComProperty \$", action)) >= 12 and len(re.findall(r"Set-ComProperty \$", action)) >= 7
    for name in ("Slides", "Shapes", "Fill", "PictureEffects", "SmartArt", "AllNodes", "TextFrame2", "TextRange", "Font",
                 "Count"):
        assert re.search(rf"Get-ComProperty \$\w+ '{name}'", action), f"the action never reads {name} through Get-ComProperty"


@WINDOWS_ONLY
def test_the_accessors_throw_what_a_failing_property_does_and_do_not_unroll_a_collection(tmp_path):
    # Stand-in object (no PowerPoint, no dialog): a .NET class whose getters and setters throw the errors PowerPoint's
    # would. The accessors use the object's own type for InvokeMember, which for a COM object is System.__ComObject.
    functions = tmp_path / "functions.ps1"
    functions.write_bytes("\r\n\r\n".join(_action_function(name) for name in
                                          ("Test-BusyError", "Get-ComProperty", "Set-ComProperty")).encode("ascii"))
    check = tmp_path / "check.ps1"
    check.write_bytes("\r\n".join([
        "param($FunctionFile)",
        "$ErrorActionPreference = 'Stop'",
        "$busyOnRead = ''; $busyAtSlide = 0; $currentSlide = 0",
        ". ([scriptblock]::Create([IO.File]::ReadAllText($FunctionFile)))",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.Collections;",
        "using System.Runtime.InteropServices;",
        "public class StandIn {",
        "  public int Plain { get { return 7; } }",
        "  public ArrayList Items { get { var l = new ArrayList(); l.Add(1); l.Add(2); return l; } }",
        "  public object Busy { get { throw new COMException(\"Call was rejected by callee.\", unchecked((int)0x80010001)); } }",
        "  public object Gone { get { throw new COMException(\"Application.SmartArtLayouts : Object does not exist.\","
        " unchecked((int)0x80048010)); } }",
        "  string label;",
        "  public string Label { get { return label; } set { label = value; } }",
        "  public string Locked { get { return \"\"; } set { throw new COMException(\"The message filter indicated that"
        " the application is busy.\", unchecked((int)0x8001010A)); } }",
        "}",
        "'@",
        "$o = New-Object StandIn",
        "$cases = [ordered]@{}",
        "$cases.plain = [int](Get-ComProperty $o 'Plain')",
        "$items = Get-ComProperty $o 'Items'",
        "$cases.collectionNotUnrolled = ($items -is [System.Collections.ArrayList]) -and ($items.Count -eq 2)",
        "foreach ($name in 'Busy', 'Gone') {",
        "    try { [void](Get-ComProperty $o $name); $cases[$name] = 'no error' }",
        "    catch { $cases[$name] = [ordered]@{ busy = (Test-BusyError $_.Exception);"
        " gone = ([string]$_.Exception.InnerException.Message -match 'does not exist') } }",
        "}",
        "Set-ComProperty $o 'Label' 'x'",
        "$cases.label = $o.Label",
        "try { Set-ComProperty $o 'Locked' 'x'; $cases.locked = 'no error' }",
        "catch { $cases.locked = [ordered]@{ busy = (Test-BusyError $_.Exception) } }",
        "$cases | ConvertTo-Json -Compress -Depth 4",
        ""]).encode("ascii"))
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(check), str(functions)], 120)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) == {
        "plain": 7, "collectionNotUnrolled": True, "Busy": {"busy": True, "gone": False},
        "Gone": {"busy": False, "gone": True}, "label": "x", "locked": {"busy": True}}


@pytest.mark.powerpoint
@pytest.mark.parametrize("prop, slide", [("Count", 0), ("Slides", 3), ("Shapes", 5), ("Fill", 8), ("PictureEffects", 9)])
def test_a_busy_refusal_at_a_property_read_fails_the_run_as_powerpoint_busy(tmp_path, prop, slide):
    # -TestBusyOnRead <property> makes the accessor raise PowerPoint's busy refusal when the action reads that property
    # (with -TestBusyAtSlide <n>, only while slide n is authored; Count is the first read, of the slide count). Reached
    # only if the read goes through the accessor: a direct read would not see the hook, and the run would go on.
    # The SmartArt reads (SmartArt, AllNodes, TextFrame2, TextRange, Font) cannot be reached on this PowerPoint, where
    # no SmartArt can be added windowless; the text-level test above covers that they use the same accessor.
    _assert_busy_run(tmp_path, "-TestBusyOnRead", prop, *(["-TestBusyAtSlide", str(slide)] if slide else []))


# ---- build(): the orchestration, with the PowerPoint step replaced -------------------------------------------------


def _fake_author(failures=None, calls=None, slides=None):
    """Stand-in for com_deck.run_author: 'authors' the deck PowerPoint would write (the base deck without the slides of
    `failures`, {id: reason}), and reports `failures`. `slides` cuts the report to that many slides, to break it."""
    failures = failures or {}

    def author(base, plan_path, assets, target, timeout_sec):
        (calls if calls is not None else []).append(
            (Path(base).name, Path(plan_path).name, sorted(p.name for p in Path(assets).iterdir())))
        deck = com_deck.base_deck()
        dropped = [slide_id for slide_id in failures if slide_id in IDS]
        if dropped and len(dropped) < len(IDS):
            deck.drop_slides(dropped)
        deck.save(target)
        plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
        records = [{"id": item["id"], "ok": item["id"] not in failures,
                    **({"reason": failures[item["id"]]} if item["id"] in failures else {})} for item in plan["slides"]]
        return {"ok": True, "exitCode": 0, "seconds": 0.1, "slides": records[:slides] if slides else records}
    return author


def test_build_writes_the_deck_and_its_manifest_and_removes_its_scratch_files(tmp_path, monkeypatch):
    calls, scratch = [], []
    real_mkdtemp = tempfile.mkdtemp

    def recording_mkdtemp(*args, **kwargs):
        scratch.append(Path(real_mkdtemp(*args, **kwargs)))
        return str(scratch[-1])

    monkeypatch.setattr(com_deck.tempfile, "mkdtemp", recording_mkdtemp)
    manifest = com_deck.build(tmp_path / "out", author=_fake_author(calls=calls))
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["atlas-com.manifest.json", "atlas-com.pptx"]
    assert json.loads((tmp_path / "out" / "atlas-com.manifest.json").read_text(encoding="utf-8")) == manifest
    assert [entry["id"] for entry in manifest["slides"]] == IDS and manifest["excluded"] == []
    base_name, plan_name, assets = calls[0]
    assert (base_name, plan_name) == ("base.pptx", "plan.json")
    assert any(name.endswith(".svg") for name in assets) and any(name.endswith(".jpg") for name in assets)
    assert len(scratch) == 1 and not scratch[0].exists(), "the temp directory with the generated assets is removed"


def test_build_records_what_failed_in_excluded_and_leaves_those_slides_out(tmp_path):
    failures = {i: "SmartArtLayouts: Object does not exist (0x80048010)" for i in IDS[:4]}
    manifest = com_deck.build(tmp_path / "out", author=_fake_author(failures))
    assert [entry["id"] for entry in manifest["slides"]] == IDS[4:]
    assert [e["feature"] for e in manifest["excluded"]] == [f"smartArt:{v}" for v in
                                                            ("process1", "cycle2", "hierarchy1", "pyramid1")]
    assert all("0x80048010" in e["reason"] for e in manifest["excluded"])
    on_disk = json.loads((tmp_path / "out" / "atlas-com.manifest.json").read_text(encoding="utf-8"))
    assert on_disk == manifest


def test_build_refuses_a_result_that_does_not_match_the_plan_or_the_deck(tmp_path):
    with pytest.raises(com_deck.AuthorError, match="does not list the slides of the plan"):
        com_deck.build(tmp_path / "short", author=_fake_author(slides=8))
    # PowerPoint reports one slide failed but the deck it wrote still has every slide
    lying = _fake_author()

    def author(base, plan_path, assets, target, timeout_sec):
        result = lying(base, plan_path, assets, target, timeout_sec)
        result["slides"][0] = {"id": IDS[0], "ok": False, "reason": "x"}
        return result

    with pytest.raises(com_deck.AuthorError, match="does not have the slides the manifest lists"):
        com_deck.build(tmp_path / "lying", author=author)
    assert not (tmp_path / "short").exists() and not (tmp_path / "lying").exists()


def test_build_with_every_slide_failed_is_an_error_and_writes_nothing(tmp_path):
    with pytest.raises(ValueError, match="no slide would be left"):
        com_deck.build(tmp_path / "out", author=_fake_author({i: "x" for i in IDS}))
    assert not (tmp_path / "out").exists()


def test_build_writes_nothing_when_the_powerpoint_step_fails(tmp_path):
    def broken(*args):
        raise com_deck.AuthorError("PowerPoint did not answer (timeout)")

    with pytest.raises(com_deck.AuthorError):
        com_deck.build(tmp_path / "out", author=broken)
    assert not (tmp_path / "out").exists()


def _base_deck_file(tmp_path):
    path = tmp_path / "base.pptx"
    prs = Presentation()
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(path)
    return path


def _script_returns(monkeypatch, stdout, returncode=0, seen=None):
    def run(command, limit):
        if seen is not None:
            seen.append((command, limit))
        return subprocess.CompletedProcess(command, returncode, stdout, "progress lines with a path")

    monkeypatch.setattr(com_deck, "run_script", run)


def test_run_author_runs_the_script_and_returns_its_result_line(tmp_path, monkeypatch):
    base, seen = _base_deck_file(tmp_path), []
    line = {"ok": True, "exitCode": 0, "seconds": 1.5, "slideCount": 1, "slides": [{"id": IDS[0], "ok": True}]}
    _script_returns(monkeypatch, "progress\n" + json.dumps(line) + "\n", seen=seen)
    assert com_deck.run_author(base, tmp_path / "plan.json", tmp_path / "assets", tmp_path / "out.pptx") == line
    command, limit = seen[0]
    assert command[:5] == ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
    assert command[5] == str(com_deck.AUTHOR_PS1) and "-TimeoutSec" not in command
    assert command[6:] == ["-Pptx", str(base), "-Plan", str(tmp_path / "plan.json"), "-Assets", str(tmp_path / "assets"),
                           "-Out", str(tmp_path / "out.pptx")]
    assert limit == export.subprocess_limit(base, 1, None)  # the module's limit for the deck, plus margins
    seen.clear()
    com_deck.run_author(base, tmp_path / "plan.json", tmp_path / "assets", tmp_path / "out.pptx", timeout_sec=90)
    assert seen[0][0][-2:] == ["-TimeoutSec", "90"] and seen[0][1] == 90 + 90


def test_run_author_raises_for_every_way_the_run_can_fail_and_keeps_stderr_private(tmp_path, monkeypatch):
    base = _base_deck_file(tmp_path)
    call = (base, tmp_path / "plan.json", tmp_path / "assets", tmp_path / "out.pptx")
    _script_returns(monkeypatch, "no json here\n", returncode=3)
    with pytest.raises(com_deck.AuthorError, match="exited 3 without a result line") as no_line:
        com_deck.run_author(*call)
    assert no_line.value.stderr == "progress lines with a path"  # kept on the exception, never in its message
    assert "progress lines" not in str(no_line.value)
    for reason, code in (("timeout", 2), ("powerpoint-busy", 3)):
        _script_returns(monkeypatch, json.dumps({"ok": False, "exitCode": code, "seconds": 1, "reason": reason}),
                        returncode=code)
        with pytest.raises(com_deck.AuthorError, match=re.escape(f"{reason} (script exit code {code})")):
            com_deck.run_author(*call)

    def overrun(command, limit):
        raise LeftRunning("the script (process 1) did not finish within 5 s; it was left running, nothing was stopped")

    monkeypatch.setattr(com_deck, "run_script", overrun)
    with pytest.raises(com_deck.AuthorError, match="left running") as left:
        com_deck.run_author(*call)
    assert left.value.left_running is True


def test_main_stops_before_writing_when_the_ofl_fonts_are_not_ready(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(com_deck, "ofl_fonts_problem", lambda: "OFL FONTS NOT READY: Pretendard: missing")
    called = []
    monkeypatch.setattr(com_deck, "run_author", lambda *a, **k: called.append(a))
    assert com_deck.main(["--out", str(tmp_path / "out")]) == 3
    assert "OFL FONTS NOT READY" in capsys.readouterr().err
    assert called == [] and not (tmp_path / "out").exists()


def test_main_refuses_the_public_corpus_and_other_places(monkeypatch, capsys):
    monkeypatch.setattr(com_deck, "ofl_fonts_problem", lambda: None)

    def never(*args):  # a guard that regressed fails here: an ordinary pytest run never starts PowerPoint
        raise AssertionError("the location guard let the run reach PowerPoint")

    monkeypatch.setattr(com_deck, "run_author", never)
    root = Path(com_deck.REPO_ROOT)
    for target in (root / "corpus" / "generated" / "never-written", root / "harness" / "never-written"):
        try:
            assert com_deck.main(["--out", str(target)]) == 2
            err = capsys.readouterr().err
            assert "out/" in err and "never committed" in err and str(target) not in err
            assert not target.exists()
        finally:  # a broken guard must not leave a deck inside the repository
            shutil.rmtree(target, ignore_errors=True)


def test_main_reports_a_powerpoint_failure_without_a_path(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(com_deck, "ofl_fonts_problem", lambda: None)

    def broken(*args):
        raise com_deck.AuthorError("export of C:\\Users\\someone\\x failed")

    monkeypatch.setattr(com_deck, "run_author", broken)
    assert com_deck.main(["--out", str(tmp_path / "out")]) == 3
    err = capsys.readouterr().err
    assert "C:" not in err and "someone" not in err


# ---- the deck PowerPoint writes ---------------------------------------------------------------------------------------


# SmartArt needs Application.SmartArtLayouts, which PowerPoint 2024 (build 17932) does not give a windowless instance
# (error 0x80048010, "Object does not exist"): the supplement records it in `excluded` instead of opening a window.
# Every other feature must be authored.
MAY_BE_EXCLUDED = {"smartArt"}


@pytest.mark.powerpoint
def test_authored_deck_really_has_the_features(tmp_path):
    before = powerpoint_pids()
    manifest = com_deck.build(tmp_path)
    pptx = tmp_path / "atlas-com.pptx"
    assert pptx.is_file() and (tmp_path / "atlas-com.manifest.json").is_file()

    with zipfile.ZipFile(pptx) as zf:
        names = zf.namelist()
        slide_xml = [zf.read(n) for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
    present = {
        "smartArt": "ppt/diagrams/data1.xml" in names,
        "svgIcon": any(re.fullmatch(r"ppt/media/[^/]+\.svg", n) for n in names),
        "artisticEffects": any(b"imgEffect" in x or b"imgLayer" in x for x in slide_xml),
    }
    excluded = {}
    for item in manifest["excluded"]:
        excluded.setdefault(item["feature"].split(":")[0], []).append(item)
    for feature, found in present.items():
        # a feature is either in the zip or in `excluded` with its reason, never both, never neither
        assert found != bool(excluded.get(feature)), (feature, found, excluded.get(feature))
        if not found:
            assert feature in MAY_BE_EXCLUDED, f"{feature} must be authored: {excluded.get(feature)}"
            assert all(item["reason"] for item in excluded[feature])
    assert present["svgIcon"] and present["artisticEffects"]
    assert len(manifest["slides"]) == sum(1 for _ in Presentation(str(pptx)).slides)

    # every declared feature is on its authored slide, and the preset geometries are the declared ones
    prs = Presentation(str(pptx))
    problems = []
    slide_table = {e["id"]: c for e, c in zip(com_deck.manifest()["slides"], com_deck.SLIDES, strict=True)}
    names = {"svgIcon": lambda c: {f"COM SVG {c.variant}"},
             "artisticEffects": lambda c: {"COM Picture original", f"COM Picture {c.variant}"},
             "smartArt": lambda c: {f"COM SmartArt {c.variant}"}}
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        problems += [f"{entry['id']}: {f}" for f in com_deck.missing_features(slide, entry["features"])]
        # the names the action sets through Set-ComProperty
        com = slide_table[entry["id"]]
        missing_names = names[com.kind](com) - {shape.name for shape in slide.shapes}
        problems += [f"{entry['id']}: no shape named {name!r}" for name in sorted(missing_names)]
        declared = {f.split(":", 1)[1] for f in entry["features"] if f.startswith("prstGeom:")}
        if declared != set(drawn_presets(slide._element)):
            problems.append(f"{entry['id']}: prstGeom features {sorted(declared)} != drawn")
        assert slide.shapes[-1].name == deck_module.LABEL_NAME, f"{entry['id']}: the label is not on top"
    assert not problems, "\n".join(problems)

    assert powerpoint_pids() == before, "a PowerPoint the run started is still running"
