"""Atlas section `lines`: dash presets, widths, caps, joins, compound lines, arrowheads, connectors (free and glued
to shapes), line fills and outline dashes."""

from harness.atlas import drawingml as dml

SECTION = "lines"
INK = "1F3864"
REF = "FF0000"
WIDTHS = (0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6, 9, 12)


def _rows(deck, n):
    x, y, w, h = deck.content
    step = h / n
    return [y + step * (i + 0.5) for i in range(n)]


def _line(shapes, x1, y1, x2, y2, line, name, prst="straightConnector1"):
    return dml.add_cxn(shapes, prst, (x1, y1), (x2, y2), line=line, name=name)


def _dashes(deck):
    slide = deck.slide(SECTION, [f"prstDash:{d}" for d in dml.PRST_DASH], smoke=True, title="선 점선 프리셋 11종")
    for y, dash in zip(_rows(deck, len(dml.PRST_DASH)), dml.PRST_DASH):
        deck.caption(slide.shapes, 24, y - 8, 150, dash, align="l")
        _line(slide.shapes, 190, y, 930, y, dml.ln(3, color=INK, dash=dash), f"dash {dash}")


def _widths(deck):
    slide = deck.slide(SECTION, [f"lineWidth:{w}" for w in WIDTHS], title="선 굵기")
    for y, width in zip(_rows(deck, len(WIDTHS)), WIDTHS):
        deck.caption(slide.shapes, 24, y - 8, 150, f"{width} pt", align="l")
        _line(slide.shapes, 190, y, 930, y, dml.ln(width, color=INK), f"width {width}")


def _caps(deck):
    slide = deck.slide(SECTION, [f"lineCap:{c}" for c in dml.LINE_CAPS] + ["prstDash:dash"],
                       title="선 끝 모양 (cap)")
    rows = _rows(deck, len(dml.LINE_CAPS))
    for y, cap in zip(rows, dml.LINE_CAPS):
        deck.caption(slide.shapes, 24, y - 8, 150, f"cap={cap}", align="l")
        _line(slide.shapes, 220, y, 520, y, dml.ln(18, color=INK, cap=cap), f"cap {cap}")
        _line(slide.shapes, 600, y, 900, y, dml.ln(12, color=INK, cap=cap, dash="dash"), f"cap {cap} dashed")
    top, bottom = deck.content[1], deck.content[1] + deck.content[3]
    for x in (220, 520, 600, 900):  # hairlines at the geometric end points: caps rnd/sq reach past them
        _line(slide.shapes, x, top, x, bottom, dml.ln(0.5, color=REF), f"end reference {x}")


def _joins(deck):
    slide = deck.slide(SECTION, [f"lineJoin:{j}" for j in dml.LINE_JOINS] + ["custGeom:open-path"],
                       title="선 꺾임 모양 (join)")
    cells = deck.grid(3, 3)
    zigzag = [(0, 80), (40, 0), (80, 80), (120, 0), (160, 80)]
    for col, join in enumerate(dml.LINE_JOINS):
        line = dml.ln(10, color=INK, join=join, miter_limit=800 if join == "miter" else None)
        x, y, w, h = cells[col]
        dml.add_sp(slide.shapes, dml.sp_pr(x + (w - 90) / 2, y + 22, 90, 90, prst="star5", fill=dml.no_fill(),
                                           line=line), name=f"star5 {join}")
        x, y, w, h = cells[3 + col]
        dml.add_sp(slide.shapes, dml.sp_pr(x + (w - 160) / 2, y + 22, 160, 80,
                                           geom=dml.path_geom(zigzag, 160, 80, closed=False),
                                           fill=dml.no_fill(), line=line), name=f"zigzag {join}")
        x, y, w, h = cells[6 + col]
        dml.add_sp(slide.shapes, dml.sp_pr(x + (w - 160) / 2, y + 22, 160, 80, prst="triangle",
                                           av={"adj": 15000}, fill=dml.no_fill(), line=line),
                   name=f"triangle {join}")
        for row in range(3):
            cx, cy, cw, ch = cells[row * 3 + col]
            deck.caption(slide.shapes, cx, cy + ch - 24, cw, f"join={join}")


def _compound(deck):
    slide = deck.slide(SECTION, [f"cmpd:{c}" for c in dml.COMPOUND_LINES], title="겹선 (compound)")
    for y, cmpd in zip(_rows(deck, len(dml.COMPOUND_LINES)), dml.COMPOUND_LINES):
        deck.caption(slide.shapes, 24, y - 8, 150, f"cmpd={cmpd}", align="l")
        _line(slide.shapes, 190, y, 620, y, dml.ln(12, color=INK, cmpd=cmpd), f"cmpd {cmpd}")
        dml.add_sp(slide.shapes, dml.sp_pr(700, y - 30, 200, 60, fill=dml.no_fill(),
                                           line=dml.ln(9, color="843C0C", cmpd=cmpd)), name=f"rect cmpd {cmpd}")


def _arrowheads(deck):
    features = [f"lineEnd:{t}:{s}" for t in dml.LINE_END_TYPES for s in dml.LINE_END_SIZES]
    slide = deck.slide(SECTION, features, smoke=True, title="화살촉 종류와 크기")
    rows = _rows(deck, len(dml.LINE_END_TYPES))
    for y, end_type in zip(rows, dml.LINE_END_TYPES):
        deck.caption(slide.shapes, 24, y - 8, 90, end_type, align="l")
        for col, size in enumerate(dml.LINE_END_SIZES):
            x0 = 130 + col * 270
            _line(slide.shapes, x0, y, x0 + 200, y,
                  dml.ln(2.5, color=INK, tail=(end_type, size, size)), f"{end_type} {size}")
            deck.caption(slide.shapes, x0 + 205, y - 8, 50, size, align="l")


def _arrowheads_mixed(deck):
    slide = deck.slide(SECTION, ["lineEnd:w-len-mixed", "lineEnd:head+tail", "lineEnd:thick-line",
                                 "lineEnd:on-bentConnector3", "lineEnd:on-curvedConnector3", "lineEnd:diagonal"],
                       title="화살촉 조합")
    cells = deck.grid(4, 3)
    items = [
        ("straightConnector1", dict(tail=("triangle", "sm", "lg")), 2.5, "triangle w=sm len=lg"),
        ("straightConnector1", dict(tail=("triangle", "lg", "sm")), 2.5, "triangle w=lg len=sm"),
        ("straightConnector1", dict(tail=("stealth", "med", "lg")), 2.5, "stealth w=med len=lg"),
        ("straightConnector1", dict(tail=("diamond", "lg", "med")), 2.5, "diamond w=lg len=med"),
        ("straightConnector1", dict(head=("stealth", "med", "med"), tail=("diamond", "med", "med")), 2.5,
         "head stealth, tail diamond"),
        ("straightConnector1", dict(head=("oval", "med", "med"), tail=("arrow", "med", "med")), 2.5,
         "head oval, tail arrow"),
        ("straightConnector1", dict(head=("triangle", "lg", "lg"), tail=("triangle", "lg", "lg")), 2.5,
         "triangle both ends"),
        ("straightConnector1", dict(head=("arrow", "sm", "sm"), tail=("stealth", "sm", "sm")), 2.5,
         "head arrow, tail stealth"),
        ("straightConnector1", dict(tail=("triangle", "lg", "lg")), 8, "8 pt line, triangle lg"),
        ("bentConnector3", dict(tail=("triangle", "med", "med")), 2.5, "bentConnector3 + triangle"),
        ("curvedConnector3", dict(head=("oval", "sm", "sm"), tail=("stealth", "lg", "lg")), 2.5,
         "curvedConnector3 + ends"),
        ("straightConnector1", dict(tail=("arrow", "lg", "lg")), 4, "diagonal, arrow lg"),
    ]
    for (x, y, w, h), (prst, ends, width, label) in zip(cells, items):
        if prst == "straightConnector1" and not label.startswith("diagonal"):
            y1 = y2 = y + 50  # horizontal
        else:
            y1, y2 = y + 20, y + 90  # descending: elbows and curves need some height
        _line(slide.shapes, x + 30, y1, x + w - 30, y2, dml.ln(width, color=INK, **ends), label, prst=prst)
        deck.caption(slide.shapes, x, y + h - 26, w, label)


def _connector_presets(deck):
    connectors = ("straightConnector1", "bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5",
                  "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5")
    slide = deck.slide(SECTION, [f"cxnSp:{c}" for c in connectors] + ["sp:line", "sp:lineInv"],
                       title="연결선 프리셋")
    cells = deck.grid(4, 3)
    line = dml.ln(2.5, color=INK, tail=("triangle", "med", "med"))
    for (x, y, w, h), prst in zip(cells, connectors):
        _line(slide.shapes, x + 30, y + 20, x + w - 30, y + h - 40, line, prst, prst=prst)
        deck.caption(slide.shapes, x, y + h - 26, w, f"cxnSp {prst}")
    for (x, y, w, h), prst in zip(cells[len(connectors):], ("line", "lineInv")):
        dml.add_sp(slide.shapes, dml.sp_pr(x + 30, y + 20, w - 60, h - 60, prst=prst, line=line), name=prst)
        deck.caption(slide.shapes, x, y + h - 26, w, f"sp {prst}")


def _connector_directions(deck):
    slide = deck.slide(SECTION, ["cxnSp:straightConnector1", "cxnSp:bentConnector3", "cxnSp:curvedConnector3",
                                 "cxn:flipH", "cxn:flipV"], smoke=True, title="연결선 방향 (뒤집기)")
    cells = deck.grid(4, 3)
    directions = (("right-down", False, False), ("left-down", True, False), ("right-up", False, True),
                  ("left-up", True, True))
    for row, prst in enumerate(("straightConnector1", "bentConnector3", "curvedConnector3")):
        for col, (label, left, up) in enumerate(directions):
            x, y, w, h = cells[row * 4 + col]
            x1, x2 = (x + w - 40, x + 40) if left else (x + 40, x + w - 40)
            y1, y2 = (y + h - 40, y + 14) if up else (y + 14, y + h - 40)
            _line(slide.shapes, x1, y1, x2, y2, dml.ln(2.5, color=INK, tail=("triangle", "med", "med")),
                  f"{prst} {label}", prst=prst)
            deck.caption(slide.shapes, x, y + h - 24, w, f"{prst} {label}")


def _glued(deck):
    slide = deck.slide(SECTION, ["cxn:stCxn", "cxn:endCxn", "cxnSp:straightConnector1", "cxnSp:bentConnector3",
                                 "cxnSp:curvedConnector3", "prstDash:dash"], title="도형에 붙은 연결선")
    x0, y0, w0, h0 = deck.content
    rows = [y0 + 20 + i * (h0 / 3) for i in range(3)]
    pairs = (  # (connector, how far B sits below A, arrowheads); glued from A's right site to B's left site
        ("straightConnector1", 0, dict()),
        ("bentConnector3", 50, dict(tail=("triangle", "med", "med"))),
        ("curvedConnector3", 60, dict(head=("oval", "sm", "sm"), tail=("stealth", "med", "med"))),
    )
    for column, dash in ((0, None), (1, "dash")):
        cx = x0 + column * (w0 / 2)
        for y, (prst, drop, ends) in zip(rows, pairs):
            a = dml.add_sp(slide.shapes, dml.sp_pr(cx + 20, y, 100, 50, prst="rect", fill=dml.solid_fill("5B9BD5"),
                                                   line=dml.ln(1, color=INK)), name=f"{prst} A{column}")
            b = dml.add_sp(slide.shapes, dml.sp_pr(cx + 300, y + drop, 100, 50, prst="roundRect",
                                                   fill=dml.solid_fill("ED7D31"), line=dml.ln(1, color=INK)),
                           name=f"{prst} B{column}")
            dml.add_cxn(slide.shapes, prst, start=(a, 3), end=(b, 1),
                        line=dml.ln(2.5, color=INK, dash=dash, **ends), name=f"{prst} glued {column}")
            deck.caption(slide.shapes, cx + 20, y + 58, 160, prst, align="l")


def _line_fills(deck):
    slide = deck.slide(SECTION, ["ln:solidFill:srgb", "ln:solidFill:scheme", "ln:alpha", "ln:gradFill",
                                 "ln:pattFill", "ln:noFill", "prstDash:dash", "pattFill:dkDnDiag",
                                 "pattFill:smCheck"], title="선 채우기 (색, 투명도, 그라데이션, 무늬)")
    cells = deck.grid(4, 3)
    grad2 = dml.grad_fill([(0, "0070C0"), (100, "FF0000")], angle=0)
    grad3 = dml.grad_fill([(0, "00B050"), (50, "FFC000"), (100, "7030A0")], angle=0)
    items = (
        ("srgb C00000", dml.ln(10, color="C00000")),
        ("scheme accent2", dml.ln(10, color="accent2")),
        ("alpha 25%", dml.ln(10, color="0070C0", alpha=25)),
        ("alpha 50%", dml.ln(10, color="0070C0", alpha=50)),
        ("alpha 75%", dml.ln(10, color="0070C0", alpha=75)),
        ("gradient 2 stops", dml.ln(10, fill=grad2)),
        ("gradient 3 stops", dml.ln(14, fill=grad3)),
        ("pattern dkDnDiag", dml.ln(14, fill=dml.patt_fill("dkDnDiag", "000000", "FFFFFF"))),
        ("pattern smCheck", dml.ln(14, fill=dml.patt_fill("smCheck", "7030A0", "FFFF00"))),
        ("noFill (invisible)", dml.ln(10, fill=dml.no_fill())),
        ("alpha 50% + dash", dml.ln(10, color="00B050", alpha=50, dash="dash")),
        ("gradient rect outline", None),
    )
    for (x, y, w, h), (label, line) in zip(cells, items):
        # a dark bar under every sample, so transparency and invisible lines are measurable
        dml.add_sp(slide.shapes, dml.sp_pr(x + w / 2 - 10, y + 10, 20, 90, fill=dml.solid_fill("262626")),
                   name=f"backdrop {label}")
        if line is None:
            dml.add_sp(slide.shapes, dml.sp_pr(x + 30, y + 20, w - 60, 70, fill=dml.no_fill(),
                                               line=dml.ln(8, fill=grad3)), name=label)
        else:
            _line(slide.shapes, x + 24, y + 55, x + w - 24, y + 55, line, label)
        deck.caption(slide.shapes, x, y + h - 26, w, label)


def _outline_dashes(deck):
    slide = deck.slide(SECTION, [f"outline:prstDash:{d}" for d in dml.PRST_DASH] + ["outline:custDash"],
                       title="도형 윤곽선 점선과 사용자 점선")
    cells = deck.grid(4, 3)
    shapes_for = ("rect", "ellipse", "roundRect")
    for i, ((x, y, w, h), dash) in enumerate(zip(cells, dml.PRST_DASH)):
        dml.add_sp(slide.shapes, dml.sp_pr(x + (w - 120) / 2, y + 16, 120, 76, prst=shapes_for[i % 3],
                                           fill=dml.solid_fill("DEEBF7"), line=dml.ln(3, color=INK, dash=dash)),
                   name=f"outline {dash}")
        deck.caption(slide.shapes, x, y + h - 26, w, f"outline {dash}")
    x, y, w, h = cells[11]
    dml.add_sp(slide.shapes, dml.sp_pr(x + (w - 120) / 2, y + 16, 120, 76, prst="rect",
                                       fill=dml.solid_fill("FBE5D6"),
                                       line=dml.ln(3, color="843C0C", cust_dash=[(400, 100), (100, 100)],
                                                   cap="rnd")),
               name="outline custDash")
    deck.caption(slide.shapes, x, y + h - 26, w, "custDash 400/100/100/100")


def build(deck):
    _dashes(deck)
    _widths(deck)
    _caps(deck)
    _joins(deck)
    _compound(deck)
    _arrowheads(deck)
    _arrowheads_mixed(deck)
    _connector_presets(deck)
    _connector_directions(deck)
    _glued(deck)
    _line_fills(deck)
    _outline_dashes(deck)
