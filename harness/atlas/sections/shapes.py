"""Atlas section `shapes`: every ECMA-376 ST_ShapeType preset (12 per slide), then rotated, flipped, adjusted and
grouped shapes."""

from harness.atlas import drawingml as dml

SECTION = "shapes"
PER_SLIDE = 12
PALETTE = ("4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47",
           "264478", "9E480E", "7F6000", "C00000", "7030A0", "00B0F0")
OUTLINE = dml.ln(1.25, color="1F2A44")


def _shape(shapes, x, y, w, h, prst, color, *, name=None, text=None, deck=None, **kwargs):
    txbody = None
    if text is not None:
        body = dml.body_pr(anchor="ctr", insets=(2, 2, 2, 2))
        txbody = dml.tx_body([deck.para(text, "BODY", 11, align="ctr", color="FFFFFF", bold=True)], body=body)
    sppr = dml.sp_pr(x, y, w, h, prst=prst, fill=dml.solid_fill(color), line=OUTLINE, **kwargs)
    return dml.add_sp(shapes, sppr, name=name or prst, txbody=txbody)


def _presets(deck):
    presets = dml.ST_SHAPE_TYPE
    pages = -(-len(presets) // PER_SLIDE)
    for page in range(pages):
        chunk = presets[page * PER_SLIDE:(page + 1) * PER_SLIDE]
        slide = deck.slide(SECTION, [f"prstGeom:{p}" for p in chunk], smoke=page in (0, 8),
                           title=f"도형 프리셋 {page + 1}/{pages}")
        for i, ((x, y, w, h), prst) in enumerate(zip(deck.grid(4, 3), chunk)):
            _shape(slide.shapes, x + (w - 110) / 2, y + 20, 110, 70, prst, PALETTE[i])
            deck.caption(slide.shapes, x, y + h - 26, w, prst)


def _rotated(deck):
    angles = (0, 15, 30, 45, 60, 90, 120, 135, 180, 225, 270, 315)
    slide = deck.slide(SECTION, ["xfrm:rot", "txBody:rotated-with-shape"],
                       title="회전한 도형과 글자")
    for (x, y, w, h), angle in zip(deck.grid(4, 3), angles):
        _shape(slide.shapes, x + (w - 120) / 2, y + 30, 120, 60, "rightArrow", "4472C4", rot=angle,
               text=f"회전 {angle}", deck=deck, name=f"rot {angle}")
        deck.caption(slide.shapes, x, y + h - 26, w, f"rot={angle}")


def _flipped(deck):
    flips = ((False, False, "none"), (True, False, "flipH"), (False, True, "flipV"), (True, True, "flipH+flipV"))
    slide = deck.slide(SECTION, ["xfrm:flipH", "xfrm:flipV", "xfrm:flipH+flipV", "txBody:flipped"],
                       title="뒤집은 도형")
    cells = deck.grid(4, 3)
    for row, prst in enumerate(("rtTriangle", "bentArrow", "curvedRightArrow")):
        for col, (flip_h, flip_v, label) in enumerate(flips):
            x, y, w, h = cells[row * 4 + col]
            _shape(slide.shapes, x + (w - 110) / 2, y + 16, 110, 80, prst, PALETTE[row * 4 + col],
                   flip_h=flip_h, flip_v=flip_v, text="가A", deck=deck, name=f"{prst} {label}")
            deck.caption(slide.shapes, x, y + h - 26, w, f"{prst} {label}")


def _rotated_flipped_adjusted(deck):
    slide = deck.slide(SECTION, ["xfrm:rot+flip", "txBody:rotated-with-shape", "avLst:adjusted"],
                       title="회전과 뒤집기, 조정점")
    cells = deck.grid(4, 3)
    combos = ((30, True, False), (30, False, True), (30, True, True), (300, True, False))
    for i, (rot, flip_h, flip_v) in enumerate(combos):
        x, y, w, h = cells[i]
        label = f"rot={rot} " + ("flipH " if flip_h else "") + ("flipV" if flip_v else "")
        _shape(slide.shapes, x + (w - 100) / 2, y + 16, 100, 80, "rtTriangle", PALETTE[i], rot=rot,
               flip_h=flip_h, flip_v=flip_v, text="가A", deck=deck, name=label.strip())
        deck.caption(slide.shapes, x, y + h - 26, w, label.strip())
    adjusted = (
        ("roundRect", {"adj": 5000}), ("roundRect", {"adj": 50000}), ("star5", {"adj": 10000, "hf": 105146,
                                                                              "vf": 110557}),
        ("rightArrow", {"adj1": 80000, "adj2": 20000}), ("donut", {"adj": 10000}),
        ("blockArc", {"adj1": 10800000, "adj2": 0, "adj3": 10000}), ("chevron", {"adj": 80000}),
        ("can", {"adj": 50000}),
    )
    for i, (prst, av) in enumerate(adjusted, start=4):
        x, y, w, h = cells[i]
        _shape(slide.shapes, x + (w - 110) / 2, y + 16, 110, 75, prst, PALETTE[i], av=av)
        deck.caption(slide.shapes, x, y + h - 26, w, prst + " " + " ".join(f"{k}={v}" for k, v in av.items()))


def _group_children(deck, shapes, x, y, label):
    """Three shapes and a text shape inside a 150 x 90 pt box at (x, y)."""
    _shape(shapes, x, y, 70, 45, "rect", "4472C4", name=f"{label} rect")
    _shape(shapes, x + 80, y, 70, 45, "ellipse", "ED7D31", name=f"{label} ellipse")
    _shape(shapes, x + 40, y + 50, 70, 40, "triangle", "70AD47", name=f"{label} triangle", text="그룹",
           deck=deck)


def _grouped(deck):
    slide = deck.slide(SECTION, ["grpSp", "grpSp:nested", "grpSp:connector", "grpSp:text"], smoke=True,
                       title="그룹")
    cells = deck.grid(2, 2)
    # a plain group
    x, y, w, h = cells[0]
    group = slide.shapes.add_group_shape()
    group.name = "group"
    _group_children(deck, group.shapes, x + (w - 150) / 2, y + 30, "group")
    deck.caption(slide.shapes, x, y + h - 26, w, "grpSp")
    # a nested group: an inner group plus a sibling shape
    x, y, w, h = cells[1]
    outer = slide.shapes.add_group_shape()
    outer.name = "outer group"
    inner = outer.shapes.add_group_shape()
    inner.name = "inner group"
    _group_children(deck, inner.shapes, x + 40, y + 30, "inner")
    _shape(outer.shapes, x + 220, y + 40, 90, 70, "star5", "FFC000", name="outer star")
    deck.caption(slide.shapes, x, y + h - 26, w, "grpSp > grpSp (nested)")
    # a group holding two shapes glued by a connector
    x, y, w, h = cells[2]
    linked = slide.shapes.add_group_shape()
    linked.name = "group with connector"
    a = _shape(linked.shapes, x + 60, y + 40, 90, 50, "roundRect", "5B9BD5", name="A")
    b = _shape(linked.shapes, x + 260, y + 90, 90, 50, "roundRect", "70AD47", name="B")
    dml.add_cxn(linked.shapes, "bentConnector3", start=(a, 3), end=(b, 1),
                line=dml.ln(2, color="1F2A44", tail=("triangle", "med", "med")), name="A to B")
    deck.caption(slide.shapes, x, y + h - 26, w, "grpSp with cxnSp")
    # a group of text boxes
    x, y, w, h = cells[3]
    texts = slide.shapes.add_group_shape()
    texts.name = "group of text"
    deck.text(texts.shapes, x + 40, y + 30, 300, 30, "그룹 안의 글상자 1", "BODY", 16, name="group text 1")
    deck.text(texts.shapes, x + 40, y + 70, 300, 30, "Grouped text box 2", "SERIF", 16, name="group text 2")
    deck.caption(slide.shapes, x, y + h - 26, w, "grpSp of text boxes")


def _grouped_transformed(deck):
    slide = deck.slide(SECTION, ["grpSp:rot", "grpSp:flipH", "grpSp:flipV", "grpSp:scaled", "grpSp:rot-child",
                                 "grpSp:nested-rot", "grpSp:rot-text"], title="회전, 뒤집기, 크기 조절한 그룹")
    cells = deck.grid(3, 2)
    variants = (
        ("rot=30", dict(rot=30)),
        ("flipH", dict(flip_h=True)),
        ("flipV", dict(flip_v=True)),
        ("rot=45 + child rot=30", dict(rot=45)),
        ("scaled 60% x 80%", dict(scale=(0.6, 0.8))),
        ("nested, outer rot=20", dict(rot=20)),
    )
    for i, ((x, y, w, h), (label, transform)) in enumerate(zip(cells, variants)):
        group = slide.shapes.add_group_shape()
        group.name = f"group {label}"
        bx, by = x + (w - 150) / 2, y + 40
        if i == 5:
            inner = group.shapes.add_group_shape()
            inner.name = "inner group"
            _group_children(deck, inner.shapes, bx, by, "inner")
            _shape(group.shapes, bx + 160, by + 20, 40, 40, "ellipse", "C00000", name="outer dot")
            dml.set_group_transform(inner, rot=-20)
        else:
            _group_children(deck, group.shapes, bx, by, label)
        if i == 3:
            _shape(group.shapes, bx + 155, by + 10, 40, 60, "rect", "7030A0", rot=30, name="rotated child")
        dml.set_group_transform(group, **transform)
        deck.caption(slide.shapes, x, y + h - 26, w, label)


def build(deck):
    _presets(deck)
    _rotated(deck)
    _flipped(deck)
    _rotated_flipped_adjusted(deck)
    _grouped(deck)
    _grouped_transformed(deck)
