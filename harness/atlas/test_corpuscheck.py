"""Tests that the corpus checks (harness/atlas/corpuscheck.py) bite: each rule fails on a file that breaks it and
passes on one that keeps it. They use synthetic PDFs and a freshly built deck, never the committed corpus."""

import io
import zipfile

import pymupdf
import pytest
from PIL import Image

from harness.atlas import corpuscheck, decks
from harness.atlas.test_export import static_ttf

POWERPOINT = "Microsoft® PowerPoint® 2024"
INFO = {"title": "deckback feature atlas: probe", "author": "deckback harness", "subject": "", "keywords": "",
        "creator": POWERPOINT, "producer": POWERPOINT}


def xmp(creator="deckback harness", tool=POWERPOINT, producer=POWERPOINT, extra=""):
    """An XMP packet shaped like PowerPoint's."""
    return (
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">'
        f"<pdf:Producer>{producer}</pdf:Producer></rdf:Description>"
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f"<dc:creator><rdf:Seq><rdf:li>{creator}</rdf:li></rdf:Seq></dc:creator></rdf:Description>"
        '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">'
        f"<xmp:CreatorTool>{tool}</xmp:CreatorTool></rdf:Description>{extra}</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )


def metadata_pdf(path, info=None, packet=None, extra_info_key=None):
    doc = pymupdf.open()
    doc.new_page()
    doc.set_metadata(dict(INFO, **(info or {})))
    if packet is not False:
        doc.set_xml_metadata(packet or xmp())
    if extra_info_key:
        info_xref = int(doc.xref_get_key(-1, "Info")[1].split()[0])
        doc.xref_set_key(info_xref, extra_info_key, "(somebody)")
    doc.save(path)
    doc.close()
    return path


def test_pdf_metadata_check_passes_what_powerpoint_writes(tmp_path):
    assert corpuscheck.pdf_metadata_problems(metadata_pdf(tmp_path / "good.pdf")) == []


@pytest.mark.parametrize("name, kwargs, expected", [
    ("author", {"info": {"author": "Some Person"}}, "Author"),
    ("creator", {"info": {"creator": "Word"}}, "Creator"),
    ("producer", {"info": {"producer": "pypdf"}}, "Producer"),
    ("title", {"info": {"title": "deckback-com-1234.pptx"}}, "Title"),
    ("subject", {"info": {"subject": "private"}}, "Subject"),
    ("xmp-creator", {"packet": xmp(creator="Some Person")}, "dc:creator"),
    ("xmp-tool", {"packet": xmp(tool="Acrobat")}, "CreatorTool"),
    ("xmp-producer", {"packet": xmp(producer="Acrobat")}, "pdf:Producer"),
    ("xmp-extra", {"packet": xmp(extra='<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
                                 "<dc:contributor>Some Person</dc:contributor></rdf:Description>")}, "contributor"),
    ("no-xmp", {"packet": False}, "XMP"),
    ("extra-key", {"extra_info_key": "Company"}, "Info key"),
])
def test_pdf_metadata_check_bites(tmp_path, name, kwargs, expected):
    problems = corpuscheck.pdf_metadata_problems(metadata_pdf(tmp_path / f"{name}.pdf", **kwargs))
    assert any(expected in problem for problem in problems), problems


def one_font_pdf(path, font_bytes=None, base_font="ABCDEF+Pretendard-Regular"):
    """A one-page PDF whose only font is the base-14 Helvetica (not embedded), or `font_bytes` embedded with its font
    dictionaries renamed to the BaseFont `base_font` (PyMuPDF would take the name from the font's family and style)."""
    doc = pymupdf.open()
    page = doc.new_page()
    if font_bytes is None:
        page.insert_text((72, 72), "A", fontname="helv")
    else:
        page.insert_font(fontname="F1", fontbuffer=font_bytes)
        page.insert_text((72, 72), "A", fontname="F1")
        for xref in range(1, doc.xref_length()):
            if "/BaseFont" in doc.xref_object(xref, compressed=True):
                doc.xref_set_key(xref, "BaseFont", f"/{base_font}")
    doc.save(path)
    doc.close()
    return path


def test_embedded_font_check_bites(tmp_path):
    lock_names = {"familyName": "Pretendard", "styleName": "Regular", "psName": "Pretendard-Regular"}
    good = one_font_pdf(tmp_path / "good.pdf", static_ttf(False, lock_names))
    assert corpuscheck.pdf_font_problems(good) == ([], {("Pretendard", "Pretendard-Regular")})  # the control passes

    cases = {
        "base14": (one_font_pdf(tmp_path / "base14.pdf"), "not embedded"),
        "other": (one_font_pdf(tmp_path / "other.pdf", static_ttf(False)), "is not one lock file"),
        "variable": (one_font_pdf(tmp_path / "variable.pdf", static_ttf(True, lock_names)), "variable font"),
        "base-font": (one_font_pdf(tmp_path / "base.pdf", static_ttf(False, lock_names), "Other-Name"),
                      "BaseFont is not a lock PostScript name"),
    }
    for name, (path, expected) in cases.items():
        problems, _ = corpuscheck.pdf_font_problems(path)
        assert any(expected in problem for problem in problems), (name, problems)


LOCK_REGULAR = {"familyName": "Pretendard", "styleName": "Regular", "psName": "Pretendard-Regular"}


def test_embedded_font_check_reads_fonts_no_page_resource_names(tmp_path):
    # Minor m10: a font used only by an annotation's appearance stream, and a font object nothing refers to, are in
    # the PDF just the same; the check reads every font object, not only those of the pages' resources.
    good = one_font_pdf(tmp_path / "good.pdf", static_ttf(False, LOCK_REGULAR))
    annotated = tmp_path / "annotated.pdf"
    with pymupdf.open(good) as doc:
        annot = doc[0].add_freetext_annot(pymupdf.Rect(72, 100, 300, 140), "note", fontname="Helv")
        annot.update()
        doc.save(annotated)
    problems, pairs = corpuscheck.pdf_font_problems(annotated)
    assert any("Helvetica" in p and "not embedded" in p for p in problems), problems
    assert pairs == {("Pretendard", "Pretendard-Regular")}

    orphan = tmp_path / "orphan.pdf"
    with pymupdf.open(good) as doc:
        xref = doc.get_new_xref()
        doc.update_object(xref, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
        doc.save(orphan)
    problems, _ = corpuscheck.pdf_font_problems(orphan)
    assert any("Courier" in p and "not embedded" in p for p in problems), problems

    # an embedded program no font dictionary points to (a FontDescriptor left over) is checked as well
    leftover = tmp_path / "leftover.pdf"
    with pymupdf.open(good) as doc:
        stream = doc.get_new_xref()
        doc.update_object(stream, "<< >>")
        doc.update_stream(stream, static_ttf(True))  # a variable font, not a lock file
        descriptor = doc.get_new_xref()
        doc.update_object(descriptor, f"<< /Type /FontDescriptor /FontName /Leftover /FontFile2 {stream} 0 R >>")
        doc.save(leftover)
    problems, _ = corpuscheck.pdf_font_problems(leftover)
    assert any("variable font" in p for p in problems), problems
    assert corpuscheck.pdf_font_problems(good) == ([], {("Pretendard", "Pretendard-Regular")})


def test_a_bare_cff_or_damaged_program_is_a_problem_not_an_exception(tmp_path):
    # Minor m18: TTFont would raise on a program without an sfnt wrapper; the gate reports it instead.
    cff = one_font_pdf(tmp_path / "cff.pdf", pymupdf.Font("tiro").buffer)
    problems, pairs = corpuscheck.pdf_font_problems(cff)
    assert any("not TrueType" in p and "bare CFF or Type 1" in p for p in problems), problems
    assert pairs == set()
    damaged = one_font_pdf(tmp_path / "damaged.pdf", static_ttf(False, LOCK_REGULAR))
    with pymupdf.open(damaged) as doc:
        for xref in range(1, doc.xref_length()):
            if "/FontFile2" in doc.xref_object(xref, compressed=True):
                stream = int(doc.xref_get_key(xref, "FontFile2")[1].split()[0])
                doc.update_stream(stream, doc.xref_stream(stream)[:60])
        doc.save(tmp_path / "damaged2.pdf")
    problems, _ = corpuscheck.pdf_font_problems(tmp_path / "damaged2.pdf")
    assert any("cannot be read" in p for p in problems), problems


def test_coverage_check_wants_exactly_the_lock_truetype_files():
    every = corpuscheck.lock_truetype_pairs()
    assert len(every) == 11 and ("Source Sans 3", "SourceSans3-Regular") not in every  # the CFF file is no TrueType
    assert corpuscheck.coverage_problems(every) == []
    missing = corpuscheck.coverage_problems(every - {("Pretendard Light", "Pretendard-Light")})
    assert any("Pretendard-Light" in problem and "never embedded" in problem for problem in missing)
    extra = corpuscheck.coverage_problems(every | {("Other", "Other-Regular")})
    assert any("Other-Regular" in problem for problem in extra)


def png(path, size=(1920, 1080), mode="RGB"):
    Image.new(mode, size).save(path)
    return path


def test_png_check_bites(tmp_path):
    assert corpuscheck.png_problems(png(tmp_path / "ok.png")) == []
    assert corpuscheck.png_problems(png(tmp_path / "rgba.png", mode="RGBA")) == []
    assert any("colour type" in p for p in corpuscheck.png_problems(png(tmp_path / "palette.png", mode="P")))
    assert any("1920x1080" in p for p in corpuscheck.png_problems(png(tmp_path / "small.png", size=(960, 540))))


# --- decks: a freshly built probe is the control, mutated copies are the cases ----------------------------------------


def mutate(source, target, edits):
    """Copy the zip `source` to `target`, applying edits = {member name: bytes -> bytes}."""
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename in edits:
                data = edits[info.filename](data)
            zout.writestr(info, data)
    return target


def replace(old, new):
    def edit(data):
        assert old in data, old
        return data.replace(old, new, 1)

    return edit


@pytest.fixture(scope="module")
def probe_pptx(tmp_path_factory):
    path = tmp_path_factory.mktemp("probe") / "probe.pptx"
    decks.build_deck(decks.RECIPES["probe"]("ofl")[0], "ofl").save(path)
    return path


def test_pptx_check_passes_a_harness_deck(probe_pptx, atlas_ofl):
    assert corpuscheck.pptx_problems(probe_pptx) == []
    assert corpuscheck.pptx_problems(atlas_ofl[0]) == []  # the full atlas: Source Sans 3 only on atlas/fonts/01


def embedded_workbook(probe):
    with zipfile.ZipFile(probe) as zf:
        return next(name for name in zf.namelist() if name.endswith(".xlsx"))


def test_pptx_check_bites_on_metadata(probe_pptx, tmp_path):
    core = "docProps/core.xml"
    cases = {
        "creator": {core: replace(b"<dc:creator>deckback harness</dc:creator>",
                                  b"<dc:creator>Some Person</dc:creator>")},
        "modified-by": {core: replace(b"<cp:lastModifiedBy>deckback harness</cp:lastModifiedBy>",
                                      b"<cp:lastModifiedBy>Some Person</cp:lastModifiedBy>")},
        "company": {"docProps/app.xml": replace(b"<Company/>", b"<Company>Some Firm</Company>")},
    }
    for name, edits in cases.items():
        problems = corpuscheck.pptx_problems(mutate(probe_pptx, tmp_path / f"{name}.pptx", edits))
        assert problems, name

    workbook = embedded_workbook(probe_pptx)

    def edit_workbook(data):
        return mutate_bytes(data, {core: replace(b"<dc:creator/>", b"<dc:creator>Some Person</dc:creator>")})

    problems = corpuscheck.pptx_problems(mutate(probe_pptx, tmp_path / "workbook.pptx", {workbook: edit_workbook}))
    assert any("embedded" in problem and "dc:creator" in problem for problem in problems), problems


def mutate_bytes(data, edits):
    buffer = io.BytesIO()
    source = io.BytesIO(data)
    mutate(source, buffer, edits)
    return buffer.getvalue()


def test_pptx_check_bites_on_fonts(probe_pptx, tmp_path):
    slide = "ppt/slides/slide1.xml"
    cff = replace(b'typeface="Pretendard"', b'typeface="Source Sans 3"')
    other = replace(b'typeface="Pretendard"', b'typeface="Calibri"')
    cases = {
        "cff-off-the-fonts-slide": ({slide: cff}, "Source Sans 3"),
        "cff-in-the-theme": ({"ppt/theme/theme1.xml": replace(b'<a:latin typeface="Pretendard"',
                                                              b'<a:latin typeface="Source Sans 3"')}, "Source Sans 3"),
        "not-in-the-lock": ({slide: other}, "Calibri"),
    }
    for name, (edits, expected) in cases.items():
        problems = corpuscheck.pptx_problems(mutate(probe_pptx, tmp_path / f"{name}.pptx", edits))
        assert any(expected in problem for problem in problems), (name, problems)


def test_corpus_check_reports_what_is_missing(tmp_path):
    problems = corpuscheck.corpus_problems(tmp_path)
    assert any("probe.pptx" in problem and "missing" in problem for problem in problems)
    assert any("atlas-smoke_std.pdf" in problem and "missing" in problem for problem in problems)
    assert any("probe_gt/slide1.png" in problem and "missing" in problem for problem in problems)
    assert any("probe.export.json" in problem and "missing" in problem for problem in problems)


def test_corpus_check_wants_every_pdf_to_be_the_export_its_stamp_records(tmp_path, probe_pptx):
    """M1-R77: each committed PDF is the export of the committed deck and manifest, as its stamp records."""
    import shutil

    from harness.atlas import export

    for stem in corpuscheck.STEMS:
        shutil.copyfile(probe_pptx, tmp_path / f"{stem}.pptx")
        (tmp_path / f"{stem}.manifest.json").write_text("{}", encoding="utf-8")
        for variant in ("std", "notags"):
            doc = pymupdf.open()
            doc.new_page()
            doc.save(str(tmp_path / f"{stem}_{variant}.pdf"))
            doc.close()
        export.write_stamp(tmp_path / f"{stem}.pptx", tmp_path, ["std", "notags"], ["std", "notags"], None,
                           version_known=True)

    def stamp_problems():
        return [p for p in corpuscheck.corpus_problems(tmp_path) if "export" in p]

    assert stamp_problems() == []
    (tmp_path / "probe.manifest.json").write_text('{"changed": true}', encoding="utf-8")
    (tmp_path / "atlas-smoke_notags.pdf").write_bytes((tmp_path / "atlas-smoke_notags.pdf").read_bytes() + b"\n%")
    problems = stamp_problems()
    assert any(p.startswith("probe_std.pdf: ") and "manifest" in p for p in problems), problems
    assert any(p.startswith("atlas-smoke_notags.pdf: ") and "not the PDF" in p for p in problems), problems
    (tmp_path / "probe.export.json").unlink()
    assert "probe.export.json: missing" in stamp_problems()
