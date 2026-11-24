"""Tests for harness/atlas/normalize.py: byte-stable .pptx zip containers."""

import io
import zipfile

from pptx import Presentation

from harness.atlas.normalize import FIXED_DATE_TIME, FIXED_W3CDTF, normalize_pptx


def saved_deck(path):
    prs = Presentation()
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.core_properties.title = "normalize test"
    prs.save(str(path))
    return path


def entries(path):
    with zipfile.ZipFile(path) as zf:
        return {info.filename: zf.read(info) for info in zf.infolist()}


def test_normalize_fixes_dates_order_and_core_properties(tmp_path):
    path = saved_deck(tmp_path / "d.pptx")
    before = entries(path)
    normalize_pptx(path)
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        names = [i.filename for i in infos]
        assert names[0] == "[Content_Types].xml"
        assert names == sorted(names)
        assert {i.date_time for i in infos} == {FIXED_DATE_TIME} == {(1980, 1, 1, 0, 0, 0)}
        assert {i.create_system for i in infos} == {0}
        core = zf.read("docProps/core.xml").decode("utf-8")
    assert core.count(FIXED_W3CDTF) == 2  # created and modified
    assert "normalize test" in core
    after = entries(path)
    assert set(after) == set(before)
    for name, data in before.items():
        if name != "docProps/core.xml":
            assert after[name] == data, name
    assert len(Presentation(str(path)).slides) == 1


def test_normalize_is_idempotent_and_ignores_save_time(tmp_path):
    a = normalize_pptx(saved_deck(tmp_path / "a.pptx"))
    first = (tmp_path / "a.pptx").read_bytes()
    normalize_pptx(a)
    assert (tmp_path / "a.pptx").read_bytes() == first
    b = saved_deck(tmp_path / "b.pptx")
    with zipfile.ZipFile(b) as zf:  # simulate a save at another time
        data = {i.filename: zf.read(i) for i in zf.infolist()}
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in reversed(list(data)):
            info = zipfile.ZipInfo(name, (2031, 12, 31, 23, 59, 58))
            core = data[name].replace(b"2013-01-27T09:15:58Z", b"2031-12-31T23:59:58Z")
            zf.writestr(info, core if name == "docProps/core.xml" else data[name])
    normalize_pptx(b)
    assert (tmp_path / "b.pptx").read_bytes() == first


def _zip_bytes(members, date_time):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members:
            zf.writestr(zipfile.ZipInfo(name, date_time), data)
    return buf.getvalue()


def _workbook(stamp, order):
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.'
        'openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">'
        f"{stamp}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:modified>"
        "</cp:coreProperties>"
    ).encode()
    members = [("[Content_Types].xml", b"<Types/>"), ("docProps/core.xml", core), ("xl/workbook.xml", b"<wb/>")]
    return _zip_bytes(members[::order], (2026, 11, 4, 12, 0, 0))


def test_embedded_workbooks_are_normalized_too(tmp_path):
    # python-pptx embeds each chart's data as an .xlsx written by XlsxWriter, whose core.xml carries the build time
    early = _zip_bytes([("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx", _workbook("2026-11-04T01:02:03Z", 1))],
                       (2026, 1, 1, 0, 0, 0))
    late = _zip_bytes([("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx", _workbook("2031-12-31T23:59:58Z", -1))],
                      (2031, 1, 1, 0, 0, 0))
    a, b = tmp_path / "a.pptx", tmp_path / "b.pptx"
    a.write_bytes(early)
    b.write_bytes(late)
    normalize_pptx(a)
    normalize_pptx(b)
    assert a.read_bytes() == b.read_bytes()
    with zipfile.ZipFile(a) as outer:
        inner = zipfile.ZipFile(io.BytesIO(outer.read("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx")))
    assert [i.filename for i in inner.infolist()] == ["[Content_Types].xml", "docProps/core.xml", "xl/workbook.xml"]
    assert {i.date_time for i in inner.infolist()} == {FIXED_DATE_TIME}
    assert inner.read("docProps/core.xml").decode().count(FIXED_W3CDTF) == 2
