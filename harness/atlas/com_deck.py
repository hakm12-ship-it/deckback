"""The COM-authored supplement to the feature atlas: `atlas-com`, nine slides that only PowerPoint can write.

  harness/.venv/Scripts/python -m harness.atlas.com_deck --out out/atlas

writes `<out>/atlas-com.pptx` and `<out>/atlas-com.manifest.json`. The M1 atlas is authored with python-pptx and so
cannot hold SmartArt, SVG pictures or picture effects (`decks.EXCLUDED`); this deck adds them, with PowerPoint's COM
interface doing the authoring, so that the PDFs PowerPoint exports from them (harness/atlas/export.py) widen the evidence
the walker is swept against (`npm run oracle:sweep`, set `atlas`). Slides, ids `atlas-com/<section>/<nn>`:

  smartart (4)         basic process, cycle, hierarchy and pyramid, with Korean node text in Pretendard
  svg (3)              a filled icon, a dashed and gradient-stroked icon, an icon with nested transforms and a clip
  pictureEffects (2)   pencil sketch and blur on a JPEG (shown next to the original)

How. python-pptx writes the base deck (title, caption and label of each slide, the same AtlasDeck as every atlas deck, OFL
fonts). The assets are generated here at run time into a temp directory: the SVG icons from strings, the JPEG with
Pillow, so nothing binary is committed. `author_com.ps1` then adds the SmartArt, the pictures and the effects to a temp
copy of the base deck in one PowerPoint run (Invoke-DeckbackPowerPoint: windowless, a GUID-named copy, the module's
rules) and writes the result with SaveCopyAs. The deck is not byte-deterministic (PowerPoint writes it) and is never
committed; it is written only inside out/, corpus/private/ or the system temp directory.

The run stays windowless and never opens a window. A call that fails that way is not worked around: the slide it belongs to
is left out of the deck and the manifest, and its feature goes to the manifest's `excluded` with the reason, so the
measurements never pretend to cover it. (On PowerPoint 2024, build 17932, Application.SmartArtLayouts is not available
to a windowless instance -- error 0x80048010, "Object does not exist" -- so the four SmartArt slides are recorded
that way.) PowerPoint refusing a call because it is busy (a dialog is open in it, possibly the author's) is no such failure
and no fault of a slide (ruling M1-R74): it fails the whole run (an AuthorError, whose message carries the script's reason
`powerpoint-busy`; it has no reason field), nothing is written and nothing is put in `excluded`. Each manifest feature is
a checkable promise about its slide: `check_for` / `missing_features` check them on an authored deck, with the vocabulary
of features.py for the names it has (`pic`, `prstGeom:rect`). `build()` does not run them; the `powerpoint` test does.

Exit codes of the command: 0 deck written (also with excluded features, listed on stdout), 2 usage error or a refused
location, 3 OFL fonts not ready, or PowerPoint authoring failed as a whole (nothing written).
"""

import argparse
import json
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

from harness.atlas import build as atlas_build
from harness.atlas import export, features
from harness.atlas.deck import AtlasDeck, LABEL_NAME
from harness.atlas.sections import pictures
from harness.ppt.never_stop import LeftRunning, run_script

DECK = "atlas-com"
SIZE_PT = (960, 540)
FONTS = "ofl"
AUTHOR_PS1 = Path(__file__).with_name("author_com.ps1")
COM_MODULE = Path(__file__).resolve().parents[1] / "ppt" / "DeckbackCom.psm1"
REPO_ROOT = atlas_build.REPO_ROOT
EXIT_USAGE = 2
EXIT_FAILED = 3
REASON_LIMIT = 240
EXCLUDED_NOTE = "windowless run, no window is opened"

# msoPictureEffectType values (Office); the numbers are checked in the authored deck: a14:artisticBlur and
# a14:artisticPencilSketch must be in the slide (`artisticEffects:blur`, `artisticEffects:pencilSketch`).
EFFECT_BLUR = 2
EFFECT_PENCIL_SKETCH = 21

PHOTO_SIZE = (480, 320)
LAYOUT = "urn:microsoft.com/office/officeart/2005/8/layout/"
CAPTION_Y = 486  # the slide's caption line; the samples end above it
SMARTART_BOX = (72, 68, 816, 396)
SVG_BOX = (300, 76, 360, 360)
PHOTO_BOXES = ((40, 110, 420, 280), (500, 110, 420, 280))
ASSET_FILES = {"filled": "icon-filled.svg", "stroked": "icon-stroked.svg", "clipped": "icon-clipped.svg",
               "photo": "photo.jpg"}

# The icons are drawn here as strings (PowerPoint keeps each one as the SVG part of a picture, and writes a PNG fallback).
SVG_FILLED = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <circle cx="128" cy="128" r="112" fill="#2F5597"/>
  <path d="M128 48 L148 106 L210 106 L160 142 L179 202 L128 166 L77 202 L96 142 L46 106 L108 106 Z" fill="#FFC000"/>
  <rect x="104" y="214" width="48" height="12" rx="6" fill="#FFFFFF" fill-opacity="0.85"/>
</svg>
"""
SVG_STROKED = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="256" y2="256" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C00000"/>
      <stop offset="0.5" stop-color="#FFC000"/>
      <stop offset="1" stop-color="#2F5597"/>
    </linearGradient>
  </defs>
  <circle cx="128" cy="128" r="100" fill="none" stroke="url(#grad)" stroke-width="14" stroke-dasharray="36 18" stroke-linecap="round"/>
  <path d="M70 134 L112 176 L190 84" fill="none" stroke="url(#grad)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M40 232 H216" fill="none" stroke="#2F5597" stroke-width="6" stroke-dasharray="2 10" stroke-linecap="round"/>
</svg>
"""
SVG_CLIPPED = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <clipPath id="disc"><circle cx="128" cy="128" r="104"/></clipPath>
  </defs>
  <g transform="translate(128 128) rotate(20) scale(1.1 0.9) translate(-128 -128)">
    <g clip-path="url(#disc)">
      <rect width="256" height="256" fill="#DEEAF6"/>
      <g transform="translate(36 70) rotate(-12) scale(1.2)">
        <rect width="120" height="64" rx="10" fill="#2F5597"/>
        <path d="M18 44 L56 14 L100 44 Z" fill="#FFC000" transform="skewX(-12)"/>
      </g>
      <circle cx="196" cy="196" r="52" fill="#70AD47" fill-opacity="0.8"/>
    </g>
  </g>
</svg>
"""
SVG_SOURCES = {"filled": SVG_FILLED, "stroked": SVG_STROKED, "clipped": SVG_CLIPPED}


@dataclass(frozen=True)
class ComSlide:
    section: str  # the section of the slide id: atlas-com/<section>/<nn>
    kind: str  # what PowerPoint authors, and the class of its `excluded` entry: smartArt | svgIcon | artisticEffects
    variant: str  # which one: the layout, the icon, the effect (`excluded` names it `<kind>:<variant>`)
    title: str
    caption: str
    features: tuple  # manifest features, each checked on the authored slide
    boxes: tuple  # (x, y, w, h) in pt of what PowerPoint adds, in the order author_com.ps1 adds it
    spec: dict = field(default_factory=dict)  # kind-specific: SmartArt layout and nodes; asset and effect number
    box_captions: tuple = ()  # one line under each box, if given


def _smartart(variant, title, caption, nodes):
    return ComSlide("smartart", "smartArt", variant, title, caption,
                    ("smartArt", f"smartArt:{variant}", "smartArt:korean"), (SMARTART_BOX,),
                    {"layout": f"{LAYOUT}{variant}", "nodes": nodes})


SLIDES = (
    _smartart("process1", "SmartArt: 기본 프로세스 (process1)", "SmartArt 기본 프로세스, 한글 글자는 Pretendard",
              ("기획", "개발", "검증")),
    _smartart("cycle2", "SmartArt: 기본 주기 (cycle2)", "SmartArt 기본 주기, 한글 글자는 Pretendard",
              ("기획", "설계", "구현", "시험", "배포")),
    _smartart("hierarchy1", "SmartArt: 계층 구조 (hierarchy1)", "SmartArt 계층 구조, 한글 글자는 Pretendard",
              ("대표", "개발팀", "디자인팀", "운영팀", "기획팀")),
    _smartart("pyramid1", "SmartArt: 기본 피라미드 (pyramid1)", "SmartArt 기본 피라미드, 한글 글자는 Pretendard",
              ("비전", "전략", "실행", "기반")),
    ComSlide("svg", "svgIcon", "filled", "SVG 아이콘: 채우기 (path, circle, 투명도)",
             "SVG 그림, 채우기만 있는 아이콘 (원, 별 모양 path, 반투명 둥근 사각형)",
             ("svg", "svg:fill", "svg:fill-opacity", "pic", "prstGeom:rect"), (SVG_BOX,), {"asset": "filled"}),
    ComSlide("svg", "svgIcon", "stroked", "SVG 아이콘: 점선과 그라데이션 선",
             "SVG 그림, 점선(stroke-dasharray)과 그라데이션 선(linearGradient), 둥근 끝과 꺾임",
             ("svg", "svg:stroke-dasharray", "svg:linearGradient", "pic", "prstGeom:rect"), (SVG_BOX,),
             {"asset": "stroked"}),
    ComSlide("svg", "svgIcon", "clipped", "SVG 아이콘: 겹친 변환과 클립",
             "SVG 그림, 겹친 transform (이동, 회전, 배율, 기울임)과 clipPath",
             ("svg", "svg:transform:nested", "svg:clipPath", "pic", "prstGeom:rect"), (SVG_BOX,),
             {"asset": "clipped"}),
    ComSlide("pictureEffects", "artisticEffects", "pencilSketch", "그림 효과: 연필 스케치",
             "JPEG 그림에 연필 스케치 (artisticPencilSketch)",
             ("artisticEffects", "artisticEffects:pencilSketch", "pic", "prstGeom:rect"), PHOTO_BOXES,
             {"asset": "photo", "effect": EFFECT_PENCIL_SKETCH}, ("원본", "연필 스케치")),
    ComSlide("pictureEffects", "artisticEffects", "blur", "그림 효과: 흐리게",
             "JPEG 그림에 흐리게 (artisticBlur)",
             ("artisticEffects", "artisticEffects:blur", "pic", "prstGeom:rect"), PHOTO_BOXES,
             {"asset": "photo", "effect": EFFECT_BLUR}, ("원본", "흐리게")),
)


# ---- the base deck, the manifest and the plan for PowerPoint --------------------------------------------------------


def base_deck():
    """The python-pptx part: nine slides with their title, caption and label, and none of what PowerPoint adds."""
    deck = AtlasDeck(FONTS, SIZE_PT, deck=DECK)
    for com in SLIDES:
        slide = deck.slide(com.section, list(com.features), title=com.title)
        deck.caption(slide.shapes, 24, CAPTION_Y, 912, com.caption, size=11)
        for (x, y, w, h), text in zip(com.boxes, com.box_captions):
            deck.caption(slide.shapes, x, y + h + 6, w, text, size=11)
    return deck


# A Windows drive path, a UNC path or a POSIX absolute path (two or more segments).
_PATH = re.compile(r"[A-Za-z]:[\\/][^\s\"'<>|]*|\\\\[^\s\"'<>|]+|(?<![\w.])/(?:[\w.-]+/)+[\w.-]*")


def clean_reason(text):
    """A failure reason for the manifest: one line, no path (a message from PowerPoint or PowerShell may quote one),
    at most REASON_LIMIT characters."""
    text = _PATH.sub("<path>", str(text))
    return " ".join(text.split())[:REASON_LIMIT] or "unknown error"


def manifest(failures=None):
    """The manifest of the deck: AtlasDeck's, with the slides in `failures` ({slide id: reason}) left out and each of them
    recorded in `excluded` as `<kind>:<variant>` with its reason. ValueError for an unknown id and when no slide would be
    left. Without failures `excluded` is empty."""
    deck = base_deck()
    failures = dict(failures or {})
    slides = {entry["id"]: com for entry, com in zip(deck.manifest()["slides"], SLIDES, strict=True)}
    if failures:
        deck.drop_slides(list(failures))  # raises for an unknown id or when nothing would be left
        for slide_id in slides:  # in slide order
            if slide_id in failures:
                com = slides[slide_id]
                deck.exclude(f"{com.kind}:{com.variant}", f"{clean_reason(failures[slide_id])}; {EXCLUDED_NOTE}")
    return deck.manifest()


def plan(deck):
    """What author_com.ps1 adds to which slide: {slideCount, labelName, slides: [{id, slide (1-based), kind, variant,
    boxes: [{x, y, w, h}] in pt, and per kind: smartArt layout, nodes, font; svgIcon file; artisticEffects file, effect}]}."""
    ids = [entry["id"] for entry in deck.manifest()["slides"]]
    items = []
    for number, (slide_id, com) in enumerate(zip(ids, SLIDES, strict=True), 1):
        item = {"id": slide_id, "slide": number, "kind": com.kind, "variant": com.variant,
                "boxes": [dict(zip("xywh", box)) for box in com.boxes]}
        if com.kind == "smartArt":
            item.update(layout=com.spec["layout"], nodes=list(com.spec["nodes"]), font=deck.font("BODY").family)
        else:
            item["file"] = ASSET_FILES[com.spec["asset"]]
            if com.kind == "artisticEffects":
                item["effect"] = com.spec["effect"]
        items.append(item)
    return {"slideCount": len(items), "labelName": LABEL_NAME, "slides": items}


def write_assets(directory):
    """Write the SVG icons and the JPEG into `directory`; returns {asset: file name}. Generated at run time, never
    committed: the SVG from the strings above, the JPEG with Pillow (the atlas's `pictures` landscape)."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for asset, source in SVG_SOURCES.items():
        (directory / ASSET_FILES[asset]).write_bytes(source.encode("utf-8"))
    (directory / ASSET_FILES["photo"]).write_bytes(pictures.jpeg_bytes(pictures.landscape(*PHOTO_SIZE)))
    return dict(ASSET_FILES)


# ---- the vocabulary: how each declared feature is checked on the authored deck ----------------------------------------

_NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
    "s": "http://www.w3.org/2000/svg",
}
_HANGUL = re.compile("[가-힣]")
_BLIP = ".//p:pic/p:blipFill/a:blip"


def _xpath(element, expr):
    return etree.XPath(expr, namespaces=_NS)(element)


def _related_xml(slide, attribute):
    """The XML of the part a slide's SmartArt names in dgm:relIds (r:dm data, r:lo layout), or None."""
    ids = _xpath(slide._element, f".//dgm:relIds/@r:{attribute}")
    return etree.fromstring(slide.part.related_part(str(ids[0])).blob) if ids else None


def _svgs(slide):
    """The SVG pictures of a slide, parsed: the targets of its a:blip svgBlip extensions."""
    ids = _xpath(slide._element, f"{_BLIP}/a:extLst/a:ext/asvg:svgBlip/@r:embed")
    return [etree.fromstring(slide.part.related_part(str(rid)).blob) for rid in ids]


def _any_svg(expr):
    return lambda slide: any(_xpath(svg, expr) for svg in _svgs(slide))


def _smartart_layout(variant):
    def check(slide):
        layout = _related_xml(slide, "lo")
        return layout is not None and bool(_xpath(layout, f"self::*[@uniqueId='{LAYOUT}{variant}']"))
    return check


def _smartart_korean(slide):
    data = _related_xml(slide, "dm")
    return data is not None and any(_HANGUL.search(text) for text in _xpath(data, ".//a:t/text()"))


def _effect(name):
    suffix = f"/a14:{name}" if name else "/*"
    return f"{_BLIP}/a:extLst/a:ext/a14:imgProps/a14:imgLayer/a14:imgEffect{suffix}"


_COM_FEATURES = {
    "smartArt": f".//p:graphicFrame/a:graphic/a:graphicData[@uri='{_NS['dgm']}']/dgm:relIds",
    "smartArt:korean": _smartart_korean,
    "svg": f"{_BLIP}/a:extLst/a:ext/asvg:svgBlip",
    "svg:fill": _any_svg(".//*[@fill and @fill != 'none']"),
    "svg:fill-opacity": _any_svg(".//*[@fill-opacity]"),
    "svg:stroke-dasharray": _any_svg(".//*[@stroke-dasharray]"),
    "svg:linearGradient": _any_svg(".//s:linearGradient[s:stop] and .//*[starts-with(@stroke, 'url(#')]"),
    "svg:transform:nested": _any_svg(".//s:g[@transform]//s:g[@transform]//*[@transform]"),
    "svg:clipPath": _any_svg(".//s:clipPath/* and .//*[@clip-path]"),
    "artisticEffects": _effect(None),
    "artisticEffects:pencilSketch": _effect("artisticPencilSketch"),
    "artisticEffects:blur": _effect("artisticBlur"),
}
_COM_FEATURES.update({f"smartArt:{com.variant}": _smartart_layout(com.variant)
                      for com in SLIDES if com.kind == "smartArt"})


def check_for(feature):
    """The check of a feature (an XPath string on the slide, or a callable on the python-pptx slide), or None when it is in
    neither this vocabulary nor the atlas's (features.py)."""
    return _COM_FEATURES.get(feature) or features.check_for(feature)


def missing_features(slide, declared):
    """The declared features the authored python-pptx `slide` does not show; unknown ones are reported as such."""
    missing = []
    for feature in declared:
        check = check_for(feature)
        if check is None:
            missing.append(f"{feature} (not in the feature vocabulary)")
        elif callable(check):
            if not check(slide):
                missing.append(feature)
        elif not _xpath(slide._element, check):
            missing.append(feature)
    return missing


# ---- the PowerPoint step ------------------------------------------------------------------------------------------------


class AuthorError(RuntimeError):
    """The PowerPoint run gave no usable result (a timeout, PowerPoint busy, an error): nothing was written.
    `stderr` holds the script's progress lines and the module's messages, which quote paths: keep it private."""

    def __init__(self, message, stderr="", left_running=False):
        super().__init__(message)
        self.stderr = stderr
        self.left_running = left_running


def _last_json_line(text):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def run_author(base_pptx, plan_path, assets_dir, target, timeout_sec=None):
    """Run author_com.ps1 (Windows PowerShell 5.1, desktop PowerPoint through harness/ppt/DeckbackCom.psm1) on the base deck.
    Returns its result {ok, exitCode, seconds, slideCount, slides: [{id, ok[, reason]}]}, with the authored deck written to
    `target`. Raises AuthorError when the script gave no result, when the run as a whole failed (a timeout, PowerPoint
    busy, an error) and when the script did not finish within the limit derived from the module's time limits: it is then
    LEFT RUNNING, never ended (ending it could leave a PowerPoint it started behind)."""
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(AUTHOR_PS1),
               "-Pptx", str(base_pptx), "-Plan", str(plan_path), "-Assets", str(assets_dir), "-Out", str(target)]
    if timeout_sec:
        command += ["-TimeoutSec", str(int(timeout_sec))]
    try:
        done = run_script(command, export.subprocess_limit(base_pptx, 1, timeout_sec))
    except LeftRunning as exc:
        raise AuthorError(str(exc), left_running=True) from None
    result = _last_json_line(done.stdout)
    if result is None or "ok" not in result:
        raise AuthorError(f"author_com.ps1 exited {done.returncode} without a result line", done.stderr)
    if not result["ok"]:
        raise AuthorError(f"PowerPoint did not author the deck: {result.get('reason', 'error')} "
                          f"(script exit code {done.returncode})", done.stderr)
    return result


def build(out_dir, *, timeout_sec=None, author=None):
    """Author the deck and write `<out_dir>/atlas-com.pptx` and `atlas-com.manifest.json`; returns the manifest. `author`
    replaces the PowerPoint step (tests): author(base_pptx, plan_path, assets_dir, target, timeout_sec) -> run_author's
    result. Nothing is written when it raises."""
    author = author or run_author
    out_dir = Path(out_dir)
    work = Path(tempfile.mkdtemp(prefix="deckback-atlas-com-"))
    try:
        deck = base_deck()
        base = deck.save(work / "base.pptx")
        assets = work / "assets"
        write_assets(assets)
        plan_path = work / "plan.json"
        plan_path.write_text(json.dumps(plan(deck), ensure_ascii=False, indent=1), encoding="utf-8")
        authored = work / "authored.pptx"
        result = author(base, plan_path, assets, authored, timeout_sec)
        if [item["id"] for item in result["slides"]] != [item["id"] for item in plan(deck)["slides"]]:
            raise AuthorError("PowerPoint's result does not list the slides of the plan")
        failures = {item["id"]: item.get("reason", "") for item in result["slides"] if not item["ok"]}
        mf = manifest(failures)
        if export.slide_count(authored) != len(mf["slides"]):
            raise AuthorError("the authored deck does not have the slides the manifest lists")
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(authored, out_dir / f"{DECK}.pptx")
        atlas_build.write_manifest(out_dir / f"{DECK}.manifest.json", mf)
        return mf
    finally:
        shutil.rmtree(work, ignore_errors=True)


def ofl_fonts_problem():
    """None when the OFL fonts of the lock are installed (PowerPoint would otherwise substitute them), else the message."""
    return atlas_build.check_ofl_fonts()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Author the COM supplement to the feature atlas (atlas-com) with PowerPoint.")
    parser.add_argument("--out", required=True, help="output directory (inside out/, corpus/private/ or the temp directory)")
    args = parser.parse_args(argv)
    out = Path(args.out)
    if not atlas_build.windows_output_allowed(out):
        print("atlas-com decks are written by PowerPoint (not byte-deterministic) and never committed: write them only "
              "into out/ or corpus/private/ (or the system temp directory), never into corpus/generated/. Nothing was "
              "written.", file=sys.stderr)
        return EXIT_USAGE
    problem = ofl_fonts_problem()
    if problem:
        print(problem, file=sys.stderr)
        return EXIT_FAILED
    try:
        mf = build(out)
    except (AuthorError, ValueError) as exc:  # ValueError: not one slide would be left
        print(f"atlas-com: {clean_reason(exc)}. Nothing was written.", file=sys.stderr)
        return EXIT_FAILED
    print(f"{DECK}: {len(mf['slides'])} slides ({FONTS} fonts, authored by PowerPoint)")
    for item in mf["excluded"]:
        print(f"  excluded {item['feature']}: {item['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
