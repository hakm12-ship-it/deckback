"""The emoji-run table (M5 Task 5): harness/atlas/emoji_runs.py's output, checked without PowerPoint."""

import re

import pymupdf

from harness.atlas import emoji_runs


def committed():
    text = emoji_runs.TABLE.read_text(encoding="utf-8")
    unicode = re.search(r"\(Unicode ([\d.]+), ASCII left out\)", text).group(1)
    counts = re.search(r"^// (\d+ of \d+ in .*)\.$", text, re.M).group(1)
    runs = [[int(a, 16), int(b, 16)] for a, b in re.findall(r"\[0x([0-9a-f]+), 0x([0-9a-f]+)\]", text)]
    return text, unicode, counts, runs


def test_the_committed_table_is_what_the_script_writes_of_its_ranges():
    text, unicode, counts, runs = committed()
    assert emoji_runs.table_text(unicode, runs, counts) == text


def test_the_ranges_are_sorted_apart_and_hold_the_measured_characters():
    _, _, _, runs = committed()
    assert all(first <= last for first, last in runs)
    assert all(a[1] + 1 < b[0] for a, b in zip(runs, runs[1:]))  # sorted, neither overlapping nor touching
    inside = lambda c: any(first <= c <= last for first, last in runs)  # noqa: E731
    assert inside(0x25B6)  # ▶, atlas text/25 and text/26
    assert inside(0x2714) and inside(0x2665) and inside(0x1F600)
    assert not any(inside(c) for c in (0xA9, 0xAE, 0x25A0, 0x25CB, 0x2022))  # ©, ®, ■, ○, •: text
    assert all(first >= 0x80 for first, _ in runs)


def test_ranges_joins_neighbours():
    assert emoji_runs.ranges([5, 3, 4, 9, 11, 10, 20]) == [[3, 5], [9, 11], [20, 20]]


def test_pictured_finds_the_cell_an_image_lies_in(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=960, height=540)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), 0)
    pix.set_rect(pix.irect, (200, 0, 0))
    # cell (3, 2) of the first face's slide: x 72..96, y 52..78
    page.insert_image(pymupdf.Rect(74, 54, 94, 76), pixmap=pix)
    slides = [(emoji_runs.FACES[0], list(range(0x2600, 0x2600 + 200)))]
    found = emoji_runs.pictured(doc, slides)
    assert found == {emoji_runs.FACES[0]: {0x2600 + 2 * emoji_runs.COLS + 3}, emoji_runs.FACES[1]: set()}
