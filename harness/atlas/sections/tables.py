"""Atlas section `tables`: native PowerPoint tables (a:tbl in a graphic frame) with the default and other table
styles and their row/column flags, merged cells (gridSpan, rowSpan, hMerge, vMerge), per-side and diagonal cell
borders, cell fills (solid, gradient, pattern, none), mixed fonts, cell anchors, margins and vertical text.

python-pptx writes cell text without fonts; every cell here gets its own paragraphs (deck.para / deck.rich, so
every run and every empty paragraph names its font for latin, ea and cs) and its own a:tcPr."""

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn
from pptx.util import Pt

from harness.atlas import drawingml as dml

SECTION = "tables"
INK = "262626"
# Built-in table style ids (PowerPoint resolves them itself; tableStyles.xml need not define them).
MEDIUM_STYLE_2_ACCENT_1 = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"  # python-pptx's and PowerPoint's default
NO_STYLE_NO_GRID = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
NO_STYLE_TABLE_GRID = "{5940675A-B579-460E-94D1-54222C63F5DA}"
FLAGS = ("firstRow", "lastRow", "firstCol", "lastCol", "bandRow", "bandCol")
THIN = dict(width_pt=0.75, color="7F7F7F")


def add_table(slide, rows, cols, x, y, w, h, *, name, style=MEDIUM_STYLE_2_ACCENT_1, flags=("firstRow", "bandRow"),
              col_widths=None):
    """A python-pptx table with the given style id and row/column flags; returns the python-pptx Table."""
    frame = slide.shapes.add_table(rows, cols, Pt(x), Pt(y), Pt(w), Pt(h))
    frame.name = name
    table = frame.table
    tbl_pr = table._tbl.tblPr
    for flag in FLAGS:
        if flag in flags:
            tbl_pr.set(flag, "1")
        elif flag in tbl_pr.attrib:
            del tbl_pr.attrib[flag]
    style_id = tbl_pr.find(qn("a:tableStyleId"))
    style_id.text = style
    if col_widths is not None:
        for column, width in zip(table.columns, col_widths):
            column.width = Pt(width)
    return table


def set_cell(cell, paragraphs, tc_pr=None, body=None):
    """Replace the cell's text with `paragraphs` (a:p XML) and, when given, its properties with `tc_pr` (a:tcPr)."""
    tc = cell._tc
    txbody = parse_xml(f'<a:txBody {nsdecls("a", "r")}>{body or "<a:bodyPr/>"}<a:lstStyle/>{"".join(paragraphs)}'
                       "</a:txBody>")
    tc.replace(tc.find(qn("a:txBody")), txbody)
    if tc_pr is not None:
        new = parse_xml(tc_pr.replace("<a:tcPr", f'<a:tcPr {nsdecls("a", "r")}', 1))
        old = tc.find(qn("a:tcPr"))
        if old is not None:
            tc.replace(old, new)
        else:
            txbody.addnext(new)


def fill_cells(deck, table, values, *, role="BODY", size=14, numbers_right=True, bold_rows=(), colour=INK):
    """Write a 2-D list of strings into the table (numbers right-aligned); an empty string gives an empty
    paragraph whose end properties still name the font."""
    for r, row in enumerate(values):
        for c, text in enumerate(row):
            numeric = numbers_right and text and text.replace(",", "").replace(".", "").replace("-", "") \
                .replace("%", "").replace("(", "").replace(")", "").isdigit()
            align = "r" if numeric else None
            set_cell(table.cell(r, c), [deck.para(text, role, size, align=align, bold=r in bold_rows or None,
                                                  color=colour)])


def _empty(deck, role="BODY", size=14):
    return [deck.para("", role, size)]


def _basic(deck):
    slide = deck.slide(SECTION, ["tbl", "tbl:styleId", "tbl:firstRow", "tbl:bandRow", "algn:r"], smoke=True,
                       title="기본 표 (표 스타일, 머리글 행, 줄무늬 행)")
    values = [["지역", "1분기", "2분기", "3분기", "4분기"], ["서울", "1,250", "1,310", "1,420", "1,580"],
              ["부산", "830", "845", "910", "960"], ["대구", "540", "560", "575", "610"],
              ["인천", "620", "655", "690", "720"], ["광주", "410", "425", "440", "470"]]
    x, y, w, _ = deck.content
    table = add_table(slide, 6, 5, x, y, w, 300, name="Basic table")
    fill_cells(deck, table, values, size=16)


def _merged(deck):
    slide = deck.slide(SECTION, ["tbl", "tbl:gridSpan", "tbl:rowSpan", "tbl:hMerge", "tbl:vMerge", "algn:ctr"],
                       smoke=True, title="셀 병합 (가로, 세로, 블록)")
    x, y, w, _ = deck.content
    table = add_table(slide, 7, 6, x, y, w, 360, name="Merged table")
    values = [["2026년 부서별 실적 (억 원)", "", "", "", "", ""],
              ["부서", "상반기", "", "하반기", "", "합계"],
              ["", "1분기", "2분기", "3분기", "4분기", ""],
              ["영업부", "120", "135", "150", "170", "575"],
              ["개발부", "80", "90", "미집계", "", "170"],
              ["인사부", "40", "42", "", "", "82"],
              ["재무부", "55", "60", "65", "70", "250"]]
    fill_cells(deck, table, values, size=15)
    for (r1, c1), (r2, c2) in (((0, 0), (0, 5)), ((1, 0), (2, 0)), ((1, 1), (1, 2)), ((1, 3), (1, 4)),
                               ((1, 5), (2, 5)), ((4, 3), (5, 4))):
        table.cell(r1, c1).merge(table.cell(r2, c2))
    set_cell(table.cell(0, 0), [deck.para(values[0][0], "HEAD", 18, align="ctr", color="FFFFFF")])
    for r, c in ((1, 1), (1, 3)):
        set_cell(table.cell(r, c), [deck.para(values[r][c], "BODY", 15, align="ctr", bold=True, color=INK)])
    set_cell(table.cell(4, 3), [deck.para("미집계 (2×2 병합)", "BODY", 15, align="ctr", color="C00000")],
             dml.tc_pr(anchor="ctr", fill=dml.solid_fill("FCE4D6")))
    for r, c in ((4, 4), (5, 3), (5, 4)):  # cells hidden by the block merge keep an empty, font-naming paragraph
        set_cell(table.cell(r, c), _empty(deck, size=15))


def _borders(deck):
    slide = deck.slide(SECTION, ["tbl", "tc:lnL", "tc:lnR", "tc:lnT", "tc:lnB", "tc:lnTlToBr", "tc:lnBlToTr"],
                       title="셀 테두리 (변마다 다르게, 대각선)")
    x, y, w, _ = deck.content
    table = add_table(slide, 4, 4, x + 60, y + 10, w - 120, 400, name="Border table", style=NO_STYLE_NO_GRID,
                      flags=())
    showcase = {"L": dict(width_pt=1, color="00B050", dash="dash"), "R": dict(width_pt=3, color="7030A0"),
                "T": dict(width_pt=6, color="0070C0"), "B": dict(width_pt=4, color="C00000", cmpd="dbl")}
    cells = {
        (0, 0): ("위·아래만 Top+Bottom", {"T": THIN, "B": THIN}),
        (0, 1): ("왼쪽 점선 Left dot", {"L": dict(width_pt=2, color="000000", dash="sysDot")}),
        (0, 2): ("오른쪽 굵게 Right 4.5", {"R": dict(width_pt=4.5, color="ED7D31")}),
        (0, 3): ("테두리 없음 None", {s: dict(fill=dml.no_fill()) for s in "LRTB"}),
        (1, 1): ("네 변 모두 다름 L/R/T/B", showcase),
        (1, 2): ("대각선 TlToBr", {**{s: THIN for s in "LRTB"}, "TlToBr": dict(width_pt=1.5, color="C00000")}),
        (2, 1): ("대각선 BlToTr", {**{s: THIN for s in "LRTB"}, "BlToTr": dict(width_pt=1.5, color="0070C0")}),
        (2, 2): ("X 두 대각선", {"TlToBr": dict(width_pt=1, color="000000"),
                              "BlToTr": dict(width_pt=1, color="000000")}),
        (3, 0): ("이중선 Double", {"T": dict(width_pt=3, color="000000", cmpd="dbl"),
                                 "B": dict(width_pt=3, color="000000", cmpd="dbl")}),
        (3, 3): ("굵은 상자 Thick box", {s: dict(width_pt=6, color="1F3864") for s in "LRTB"}),
    }
    for r in range(4):
        for c in range(4):
            text, borders = cells.get((r, c), ("", {s: THIN for s in "B"}))
            paragraphs = [deck.para(text, "BODY", 13, align="ctr", color=INK)]
            set_cell(table.cell(r, c), paragraphs, dml.tc_pr(borders=borders, anchor="ctr"))


def _fills(deck):
    patterns = ("pct50", "dkDnDiag", "smCheck", "horzBrick")
    slide = deck.slide(SECTION, ["tbl", "tc:solidFill", "tc:gradFill", "tc:pattFill", "tc:noFill"]
                       + [f"pattFill:{p}" for p in patterns], title="셀 채우기 (단색, 그라데이션, 무늬, 없음)")
    x, y, w, _ = deck.content
    # stripes behind the table make the transparent and unfilled cells measurable
    for i in range(16):
        dml.add_sp(slide.shapes, dml.sp_pr(x + i * w / 16, y, w / 16, 400,
                                           fill=dml.solid_fill("000000" if i % 2 == 0 else "FFFFFF")),
                   name=f"Stripe {i}")
    table = add_table(slide, 4, 4, x + 20, y + 10, w - 40, 380, name="Fill table", style=NO_STYLE_TABLE_GRID,
                      flags=())
    fills = [
        ("빨강 C00000", dml.solid_fill("C00000"), "FFFFFF"), ("노랑 FFC000", dml.solid_fill("FFC000"), INK),
        ("테마 accent1", dml.solid_fill("accent1"), "FFFFFF"), ("투명도 50%", dml.solid_fill("0070C0", alpha=50),
                                                              "FFFFFF"),
        ("선형 그라데이션", dml.grad_fill([(0, "FFFFFF"), (100, "2F5597")], angle=90), INK),
        ("원형 그라데이션", dml.grad_fill([(0, "FFF2CC"), (100, "C55A11")], path="circle"), INK),
        ("세 점 그라데이션", dml.grad_fill([(0, "FF0000"), (50, "FFFF00"), (100, "00B050")], angle=0), INK),
        ("채우기 없음 noFill", dml.no_fill(), "FFC000"),
    ]
    fills += [(f"무늬 {p}", dml.patt_fill(p, "1F3864", "DEEBF7"), INK) for p in patterns]
    fills += [("흰색 FFFFFF", dml.solid_fill("FFFFFF"), INK), ("회색 D9D9D9", dml.solid_fill("D9D9D9"), INK),
              ("어두운 1F3864", dml.solid_fill("1F3864"), "FFFFFF"), ("연두 E2F0D9", dml.solid_fill("E2F0D9"), INK)]
    for i, (label, fill, colour) in enumerate(fills):
        set_cell(table.cell(i // 4, i % 4), [deck.para(label, "BODY", 14, align="ctr", bold=True, color=colour)],
                 dml.tc_pr(fill=fill, anchor="ctr"))


def _mixed_fonts(deck):
    roles = ("HEAD", "BODY", "SERIF", "ALT", "BODY_LIGHT", "BODY_BLACK", "ALT_XBOLD")
    faces = list(dict.fromkeys(f"typeface:{deck.font(r).family}" for r in roles))
    slide = deck.slide(SECTION, ["tbl", "tbl:mixed-fonts", "rPr:b", "rPr:i"] + faces, title="표 안의 여러 글꼴")
    x, y, w, _ = deck.content
    table = add_table(slide, len(roles) + 1, 4, x, y, w, 420, name="Font table", col_widths=(170, 250, 250, 242))
    header = ["역할 Role", "보통 Regular", "굵게·기울임 Bold Italic", "크기·색 섞기 Mixed"]
    for c, text in enumerate(header):
        set_cell(table.cell(0, c), [deck.para(text, "HEAD", 15, color="FFFFFF")])
    for r, role in enumerate(roles, start=1):
        family = deck.font(role).family
        set_cell(table.cell(r, 0), [deck.para(family, "BODY", 12, color=INK)])
        set_cell(table.cell(r, 1), [deck.para("가나다 Hangul 123", role, 16, color=INK)])
        set_cell(table.cell(r, 2), [deck.para("굵게 기울임 Bold", role, 16, bold=True, italic=True, color=INK)])
        set_cell(table.cell(r, 3), [deck.rich([("작게 ", role, 11), ("크게 ", role, 20, {"color": "C00000"}),
                                                ("Mixed", "SERIF", 14, {"italic": True})])])


def _cell_layout(deck):
    slide = deck.slide(SECTION, ["tbl", "tc:anchor:t", "tc:anchor:ctr", "tc:anchor:b", "algn:l", "algn:ctr",
                                 "algn:r", "tc:margins", "tc:vert:eaVert", "tc:vert:vert270"],
                       title="셀 안 맞춤, 여백, 세로 쓰기")
    x, y, w, _ = deck.content
    table = add_table(slide, 3, 5, x, y, w, 420, name="Layout table", style=NO_STYLE_TABLE_GRID, flags=(),
                      col_widths=(200, 200, 200, 156, 156))
    for row, table_row in enumerate(table.rows):
        table_row.height = Pt(140)
        for col, anchor in enumerate(("t", "ctr", "b")):
            align = ("l", "ctr", "r")[row]
            margins = (18, 12, 18, 12) if row == 1 else None
            label = f"anchor={anchor}, algn={align}" + (", 여백 18 pt" if margins else "")
            set_cell(table.cell(row, col), [deck.para(label, "BODY", 14, align=align, color=INK)],
                     dml.tc_pr(anchor=anchor, margins=margins, borders={s: THIN for s in "LRTB"}))
    for row in range(3):
        for col, vert in ((3, "eaVert"), (4, "vert270")):
            set_cell(table.cell(row, col), [deck.para(f"세로 {vert} 가나다", "BODY", 14, align="ctr", color=INK)],
                     dml.tc_pr(vert=vert, anchor="ctr", borders={s: THIN for s in "LRTB"}))


def _dense(deck):
    slide = deck.slide(SECTION, ["tbl", "tbl:firstRow", "tbl:firstCol", "tbl:lastRow", "tbl:bandRow", "algn:r",
                                 "text:solidFill:srgb"], title="촘촘한 재무 표 (첫 열, 요약 행)")
    rows = [["계정 과목", "2021", "2022", "2023", "2024", "2025", "증감률"],
            ["매출액", "12,450", "13,820", "15,010", "16,240", "18,330", "12.9%"],
            ["매출원가", "(8,120)", "(8,950)", "(9,600)", "(10,210)", "(11,480)", "12.4%"],
            ["매출총이익", "4,330", "4,870", "5,410", "6,030", "6,850", "13.6%"],
            ["판매관리비", "(2,210)", "(2,390)", "(2,560)", "(2,800)", "(3,050)", "8.9%"],
            ["영업이익", "2,120", "2,480", "2,850", "3,230", "3,800", "17.6%"],
            ["금융손익", "(150)", "(120)", "(90)", "(60)", "(40)", "-33.3%"],
            ["법인세", "(470)", "(560)", "(650)", "(740)", "(880)", "18.9%"],
            ["기타", "35", "-12", "48", "20", "-8", "-"],
            ["당기순이익", "1,535", "1,788", "2,158", "2,450", "2,872", "17.2%"]]
    x, y, w, _ = deck.content
    table = add_table(slide, len(rows), 7, x, y, w, 420, name="Dense table",
                      flags=("firstRow", "firstCol", "lastRow", "bandRow"), col_widths=(152,) + (128,) * 5 + (120,))
    fill_cells(deck, table, rows, size=11)
    for r, row in enumerate(rows):  # negative amounts in red
        for c, text in enumerate(row):
            if text.startswith("(") or text.startswith("-") and text != "-":
                set_cell(table.cell(r, c), [deck.para(text, "BODY", 11, align="r", color="C00000")])


def _styles(deck):
    slide = deck.slide(SECTION, ["tbl", "tbl:styleId", "tbl:bandCol", "tbl:lastCol", "tbl:firstRow"],
                       title="표 스타일과 열 옵션 (줄무늬 열, 마지막 열)")
    values = [["항목", "월", "화", "수", "목", "금", "합계"], ["방문자", "120", "135", "128", "142", "160", "685"],
              ["가입자", "12", "15", "11", "18", "21", "77"], ["문의", "30", "28", "35", "31", "25", "149"]]
    x, y, w, _ = deck.content
    first = add_table(slide, 4, 7, x, y, w, 190, name="Grid style table", style=NO_STYLE_TABLE_GRID,
                      flags=("firstRow", "bandCol", "lastCol"))
    fill_cells(deck, first, values, size=14)
    second = add_table(slide, 4, 7, x, y + 230, w, 190, name="Banded columns table",
                       flags=("bandCol", "lastCol"))
    fill_cells(deck, second, values, role="ALT", size=14)


def build(deck):
    _basic(deck)
    _merged(deck)
    _borders(deck)
    _fills(deck)
    _mixed_fonts(deck)
    _cell_layout(deck)
    _dense(deck)
    _styles(deck)
