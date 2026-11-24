"""A deck with embedded fonts opens in PowerPoint without repair and draws its text in those fonts on a PC that does not
have them (M4 Task 5, spec §7: `convert(bytes, { embedFonts: true })`, the CLI's --embed-fonts).

1. The fonts: Pretendard Regular and Bold (OFL-1.1, harness/fonts/fonts.lock.json), the files install-fonts.ps1 put in
   the per-user font folder (their sha256 checked against the lock), each cut to the probe text and renamed with
   fontTools to a family no PC has, "Deckback Embed Probe". They are written under pytest's tmp_path only: no font
   bytes and no PDF made from them are committed (spec §8).
2. The PDF: PyMuPDF draws a line in each (Type0, FontFile2: the renamed program as it is).
3. deckback converts it with --embed-fonts and without (`node packages/cli/dist/deckback.mjs`: run `npm run build:cli`
   first). The embedded deck lists both programs under the one typeface, regular and bold.
4. render.ps1 opens the embedded deck: exit 0 and one RGB PNG, so no repair prompt or other dialog held PowerPoint.
5. PowerPoint exports both decks to PDF (harness.atlas.export, std). It embeds in its export the fonts it drew the text
   with: for the embedded deck, both probe programs (their PostScript names kept; PowerPoint loads an embedded font
   under a family name of its own) and no other font; for the plain deck, neither (the family is not installed, so the
   text falls back to other fonts).

Why the export and not render.ps1's PNG for step 5: measured (M4 Task 5 report), Slide.Export draws an embedded font that
is not installed in GDI's fallback face (Gulim here), whatever form the font is embedded in (a Windows t2embed EOT
too), while the PDF export draws it in the font. The PDF export is what checks the text's font.

PowerPoint runs only through render.ps1 and export.ps1 (DeckbackCom.psm1: GUID-named temp copies, nothing it did not
start is closed, quit or stopped). Needs `pytest --run-powerpoint` (marker `powerpoint`); CI never runs it.
"""

import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path

import pytest

from harness.atlas.export import slide_count
from harness.ppt import limits
from harness.ppt.never_stop import run_script
from harness.ppt.pngmode import RGB, png_colour_type

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "packages" / "cli" / "dist" / "deckback.mjs"
RENDER = REPO / "harness" / "ppt" / "render.ps1"
LOCK = REPO / "harness" / "fonts" / "fonts.lock.json"

FAMILY = "Deckback Embed Probe"
LINES = {  # lock file -> (PostScript name of the renamed program, style, text)
    "Pretendard-Regular.ttf": ("DeckbackEmbedProbe-Regular", "Regular", "Embed Probe 가나다라 Qg"),
    "Pretendard-Bold.ttf": ("DeckbackEmbedProbe-Bold", "Bold", "Bold Probe 마바사 Kj"),
}


def _installed(file):
    """The lock's font file in the per-user font folder, its sha256 the lock's."""
    entry = next(f for fam in json.loads(LOCK.read_text(encoding="utf-8"))["families"] for f in fam["files"] if f["file"] == file)
    path = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts" / file
    assert path.is_file(), f"{file} is not installed: run harness/fonts/install-fonts.ps1"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], f"{path} is not the lock's {file}"
    return path


def _probe_font(src, out, ps_name, style, text):
    """`src` cut to `text` and renamed to FAMILY / `style` / `ps_name` (every record of names 1, 3, 4, 6, 16, 17)."""
    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(str(src))
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.layout_features = []
    options.notdef_outline = True
    options.prune_unicode_ranges = False
    options.prune_codepage_ranges = False
    options.drop_tables += ["DSIG"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    names = {1: FAMILY, 3: f"deckback;{ps_name}", 4: f"{FAMILY} {style}", 6: ps_name, 16: FAMILY, 17: style}
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID]
    font.save(str(out))
    return out


def _source_pdf(tmp_path):
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=960, height=540)
    for i, (file, (ps_name, style, text)) in enumerate(LINES.items()):
        program = _probe_font(_installed(file), tmp_path / f"{ps_name}.ttf", ps_name, style, text)
        page.insert_font(fontname=f"probe{i}", fontfile=str(program))
        page.insert_text((60, 160 + 160 * i), text, fontname=f"probe{i}", fontsize=54)
    pdf = tmp_path / "source.pdf"
    doc.save(str(pdf))
    return pdf


def _convert(pdf, out, *flags):
    done = subprocess.run(["node", str(CLI), str(pdf), "-o", str(out), "--report", str(out.with_suffix(".json")), *flags],
                          capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-500:]
    return json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))


def _exported_fonts(pptx, out_dir):
    from harness.atlas.export import export

    result = export(pptx, out_dir, ["std"], False)
    std = result["variants"].get("std") or {}
    assert std.get("ok"), f"export failed: exit {std.get('exitCode')} {std.get('reason', '')}"
    return result["fonts"]["std"]


@pytest.mark.powerpoint
def test_embedded_fonts_open_without_repair_and_draw_the_text(tmp_path):
    assert CLI.is_file(), "packages/cli/dist/deckback.mjs is missing: run `npm run build:cli` first"
    pdf = _source_pdf(tmp_path)

    embedded = tmp_path / "embedded.pptx"
    report = _convert(pdf, embedded, "--embed-fonts")
    assert [(f["latin"], f["pptxEmbedding"]) for f in report["fonts"]] == [(FAMILY, "embedded"), (FAMILY, "embedded")]
    with zipfile.ZipFile(embedded) as z:
        assert sorted(n for n in z.namelist() if n.startswith("ppt/fonts/")) == ["ppt/fonts/font1.fntdata", "ppt/fonts/font2.fntdata"]
        assert (f'<p:embeddedFont><p:font typeface="{FAMILY}"/><p:regular r:id="rId5"/><p:bold r:id="rId6"/></p:embeddedFont>'
                in z.read("ppt/presentation.xml").decode("utf-8"))
    plain = tmp_path / "plain.pptx"
    _convert(pdf, plain)

    # PowerPoint opens it as it is: a repair prompt or any other dialog would hold it past render.ps1's limit (exit 2)
    limit = 2 * limits.module_time_limit(slide_count(embedded)) + 90
    out_dir = tmp_path / "render"
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER),
                       "-Pptx", str(embedded), "-OutDir", str(out_dir)], limit)
    assert done.returncode == 0, (f"render.ps1 exit code {done.returncode} (2: a repair prompt or another dialog, "
                                  f"5: PowerPoint busy): {done.stderr.strip()[-500:]}")
    pngs = sorted(out_dir.glob("slide*.png"))
    assert len(pngs) == 1 and png_colour_type(pngs[0]) == RGB

    # PowerPoint draws the text in the embedded fonts, and in no other; without them, in neither
    probes = {ps_name for ps_name, _, _ in LINES.values()}
    drawn = _exported_fonts(embedded, tmp_path / "export-embedded")
    assert {f["psName"] for f in drawn} == probes, [f["psName"] for f in drawn]
    fallback = _exported_fonts(plain, tmp_path / "export-plain")
    assert fallback and not ({f["psName"] for f in fallback} & probes), [f["psName"] for f in fallback]
