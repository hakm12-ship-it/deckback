"""Atlas section `fills`: solid and theme colours, alpha, linear and path gradients, multi-stop gradients with
transparent stops, all 54 preset patterns (12 per slide), texture tiles, picture fills and transparent picture fills.

Transparent samples sit on black-and-white stripes so the alpha is measurable in a render."""

from harness.atlas import drawingml as dml
from harness.atlas import images

SECTION = "fills"
INK = dml.ln(1, color="404040")
ALPHAS = (10, 25, 50, 75, 90)
PATTERN_COLOURS = (  # (fg, bg) per pattern slide
    ("000000", "FFFFFF"), ("1F3864", "FFF2CC"), ("C00000", "E7E6E6"), ("375623", "FFFFFF"), ("FFFFFF", "1F3864"),
)


def _stripes(shapes, x, y, w, h, n=8, name="stripes"):
    """Black and white vertical stripes behind transparent samples."""
    step = w / n
    for i in range(n):
        color = "000000" if i % 2 == 0 else "FFFFFF"
        dml.add_sp(shapes, dml.sp_pr(x + i * step, y, step, h, fill=dml.solid_fill(color)), name=f"{name} {i}")


def _box(shapes, cell, fill, name, *, prst="rect", w=130, h=80, dy=16, stripes=False, **kwargs):
    """A sample shape centred in `cell`; stripes=True first draws black/white stripes just behind it."""
    x, y, cw, ch = cell
    left = x + (cw - w) / 2
    if stripes:
        _stripes(shapes, left - 12, y + dy - 8, w + 24, h + 16, n=6, name=f"stripes {name}")
    return dml.add_sp(shapes, dml.sp_pr(left, y + dy, w, h, prst=prst, fill=fill, line=INK, **kwargs), name=name)


def _solid(deck):
    colours = ("FFFFFF", "000000", "808080", "FF0000", "00FF00", "0000FF", "00FFFF", "FF00FF", "FFFF00",
               "CD2E3A", "0047A0", "F4B183")
    slide = deck.slide(SECTION, ["solidFill:srgb"], smoke=True, title="단색 채우기 (RGB)")
    for cell, colour in zip(deck.grid(4, 3), colours):
        _box(slide.shapes, cell, dml.solid_fill(colour), f"solid {colour}")
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"srgbClr {colour}")


def _scheme(deck):
    samples = (
        ("accent1", {}), ("accent2", {}), ("accent3", {}), ("accent4", {}), ("accent5", {}), ("accent6", {}),
        ("tx2", {}), ("bg2", {}), ("accent1", {"lum_mod": 75}), ("accent1", {"lum_mod": 60, "lum_off": 40}),
        ("accent2", {"shade": 50}), ("accent2", {"tint": 40}),
    )
    slide = deck.slide(SECTION, ["solidFill:scheme", "color:lumMod", "color:lumOff", "color:shade", "color:tint"],
                       title="테마 색 채우기")
    for cell, (name, mods) in zip(deck.grid(4, 3), samples):
        label = name + "".join(f" {k}={v}" for k, v in mods.items())
        _box(slide.shapes, cell, dml.solid_fill(name, **mods), f"scheme {label}")
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"schemeClr {label}")


def _alpha(deck):
    slide = deck.slide(SECTION, [f"alpha:{a}" for a in ALPHAS] + ["solidFill:alpha"], smoke=True,
                       title="단색 투명도 (alpha 10/25/50/75/90%)")
    cells = deck.grid(5, 2)
    for row, colour in enumerate(("C00000", "0070C0")):
        for col, alpha in enumerate(ALPHAS):
            cell = cells[row * 5 + col]
            _box(slide.shapes, cell, dml.solid_fill(colour, alpha=alpha), f"{colour} alpha {alpha}", w=120, h=150,
                 dy=16, stripes=True)
            deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"{colour} alpha {alpha}%")


def _linear(deck):
    slide = deck.slide(SECTION, [f"gradFill:lin:{a}" for a in (0, 45, 90, 135, 180, 225, 270, 315)]
                       + ["gradFill:scaled", "gradFill:rotWithShape"], smoke=True, title="선형 그라데이션 (각도)")
    cells = deck.grid(4, 3)
    stops = [(0, "0070C0"), (100, "FFC000")]
    for cell, angle in zip(cells, (0, 45, 90, 135, 180, 225, 270, 315)):
        _box(slide.shapes, cell, dml.grad_fill(stops, angle=angle), f"lin {angle}", w=110, h=80)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"lin ang={angle}")
    extras = (
        ("lin 45 scaled=0 (wide)", dict(fill=dml.grad_fill(stops, angle=45, scaled=False), w=190, h=60)),
        ("lin 45 scaled=1 (wide)", dict(fill=dml.grad_fill(stops, angle=45, scaled=True), w=190, h=60)),
        ("rot 30, rotWithShape=1", dict(fill=dml.grad_fill(stops, angle=0, rot_with_shape=True), rot=30)),
        ("rot 30, rotWithShape=0", dict(fill=dml.grad_fill(stops, angle=0, rot_with_shape=False), rot=30)),
    )
    for cell, (label, kwargs) in zip(cells[8:], extras):
        fill = kwargs.pop("fill")
        _box(slide.shapes, cell, fill, label, **kwargs)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], label)


def _path(deck):
    slide = deck.slide(SECTION, ["gradFill:path:circle", "gradFill:path:rect", "gradFill:path:shape",
                                 "gradFill:fillToRect"], title="방사형, 사각형, 도형 그라데이션")
    stops = [(0, "FFFFFF"), (100, "C00000")]
    samples = (
        ("circle centre", "circle", (50, 50, 50, 50), "rect"),
        ("circle top-left", "circle", (0, 0, 100, 100), "rect"),
        ("circle bottom-right", "circle", (100, 100, 0, 0), "rect"),
        ("circle on ellipse", "circle", (50, 50, 50, 50), "ellipse"),
        ("rect centre", "rect", (50, 50, 50, 50), "rect"),
        ("rect top-right", "rect", (100, 0, 0, 100), "rect"),
        ("rect on wide box", "rect", (50, 50, 50, 50), "rect"),
        ("rect off-centre", "rect", (30, 60, 70, 40), "roundRect"),
        ("shape on star5", "shape", (50, 50, 50, 50), "star5"),
        ("shape on heart", "shape", (50, 50, 50, 50), "heart"),
        ("shape on rect", "shape", (50, 50, 50, 50), "rect"),
        ("shape on chevron", "shape", (50, 50, 50, 50), "chevron"),
    )
    for cell, (label, path, focus, prst) in zip(deck.grid(4, 3), samples):
        w = 190 if "wide" in label else 110
        _box(slide.shapes, cell, dml.grad_fill(stops, path=path, focus=focus), label, prst=prst, w=w, h=90,
             dy=10)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"path={label}")


def _multi_stop(deck):
    slide = deck.slide(SECTION, ["gradFill:multi-stop", "gradFill:alpha-stops", "gradFill:hard-stop"],
                       title="여러 색 그라데이션과 투명 정지점")
    samples = (
        ("3 stops", [(0, "C00000"), (50, "FFFFFF"), (100, "0070C0")], dict(angle=0)),
        ("5 stops", [(0, "7030A0"), (25, "0070C0"), (50, "00B050"), (75, "FFC000"), (100, "C00000")],
         dict(angle=90)),
        ("rainbow 7 stops", [(0, "FF0000"), (17, "FF7F00"), (33, "FFFF00"), (50, "00FF00"), (67, "0000FF"),
                             (83, "4B0082"), (100, "8F00FF")], dict(angle=45)),
        ("opaque to clear", [(0, "0070C0"), (100, "0070C0", 0)], dict(angle=0)),
        ("clear middle stop", [(0, "C00000"), (50, "C00000", 0), (100, "00B050")], dict(angle=0)),
        ("alpha 100/50/10", [(0, "7030A0"), (50, "7030A0", 50), (100, "7030A0", 10)], dict(angle=90)),
        ("radial clear edge", [(0, "FFC000"), (60, "FFC000", 60), (100, "FFC000", 0)], dict(path="circle")),
        ("hard stop at 50", [(0, "0070C0"), (50, "0070C0"), (50, "FFC000"), (100, "FFC000")], dict(angle=0)),
    )
    for cell, (label, stops, kwargs) in zip(deck.grid(4, 2), samples):
        _box(slide.shapes, cell, dml.grad_fill(stops, **kwargs), label, w=150, h=150, dy=24, stripes=True)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], label)


def _gradient_extras(deck):
    slide = deck.slide(SECTION, ["gradFill:tileRect", "gradFill:flip", "gradFill:scheme", "gradFill:custGeom"],
                       title="그라데이션 타일, 뒤집기, 테마 색, 자유형")
    cells = deck.grid(3, 2)
    stops = [(0, "002060"), (100, "00B0F0")]
    samples = (
        ("tileRect 50%, flip=x", dml.grad_fill(stops, angle=0, flip="x", tile_rect=(0, 0, 50, 0))),
        ("tileRect 50%, flip=xy", dml.grad_fill(stops, path="circle", flip="xy", tile_rect=(25, 25, 25, 25))),
        ("scheme accent1 to accent6", dml.grad_fill([(0, "accent1"), (100, "accent6")], angle=0)),
        ("scheme with lumMod stop", f'<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">'
                                    f'{dml.color("accent2", lum_mod=50)}</a:gs><a:gs pos="100000">'
                                    f'{dml.color("accent2", lum_mod=40, lum_off=60)}</a:gs></a:gsLst>'
                                    f'<a:lin ang="5400000" scaled="0"/></a:gradFill>'),
    )
    for cell, (label, fill) in zip(cells, samples):
        _box(slide.shapes, cell, fill, label, w=180, h=110, dy=20)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], label)
    freeforms = (
        ("freeform mountains", 180, 100, [(0, 100), (40, 0), (90, 60), (140, 10), (180, 100)]),
        ("freeform star", 110, 110, [(55, 0), (68, 42), (110, 42), (76, 67), (89, 110), (55, 83), (21, 110),
                                     (34, 67), (0, 42), (42, 42)]),
    )
    for (x, y, cw, ch), (label, w, h, pts) in zip(cells[4:], freeforms):
        dml.add_sp(slide.shapes, dml.sp_pr(x + (cw - w) / 2, y + 20, w, h, geom=dml.path_geom(pts, w, h),
                                           fill=dml.grad_fill(stops, angle=60), line=INK), name=label)
        deck.caption(slide.shapes, x, y + ch - 26, cw, label)


def _patterns(deck):
    pages = [dml.PRST_PATTERN[i:i + 12] for i in range(0, len(dml.PRST_PATTERN), 12)]
    for page, chunk in enumerate(pages):
        fg, bg = PATTERN_COLOURS[page]
        features = [f"pattFill:{p}" for p in chunk]
        transparent = len(chunk) < 12  # the last page: the remaining presets, then repeats with clear backgrounds
        if transparent:
            features.append("pattFill:alpha")
        slide = deck.slide(SECTION, features, smoke=page == 0,
                           title=f"무늬 채우기 {page + 1}/{len(pages)}")
        cells = deck.grid(4, 3)
        for cell, prst in zip(cells, chunk):
            _box(slide.shapes, cell, dml.patt_fill(prst, fg, bg), f"pattern {prst}")
            deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], prst)
        if transparent:
            for cell, prst in zip(cells[len(chunk):], chunk):
                _box(slide.shapes, cell, dml.patt_fill(prst, ("C00000", 100), ("FFFFFF", 0)), f"pattern {prst} clear",
                     stripes=True)
                deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], f"{prst}, bg alpha 0")


def _texture(deck):
    slide = deck.slide(SECTION, ["blipFill:tile", "tile:scale", "tile:flip", "tile:offset", "tile:algn"],
                       title="질감 (타일) 채우기")
    r_id = dml.image_rid(slide, images.png_bytes(images.texture_tile()))
    samples = (
        ("tile 100%", dict()), ("tile 50%", dict(sx=50, sy=50)), ("tile 200%", dict(sx=200, sy=200)),
        ("flip x", dict(flip="x")), ("flip y", dict(flip="y")), ("flip xy", dict(flip="xy")),
        ("offset 10, 20 pt", dict(tx=10, ty=20)), ("algn ctr", dict(algn="ctr")),
        ("algn br, 150%", dict(algn="br", sx=150, sy=150)),
    )
    cells = deck.grid(3, 3)
    for cell, (label, tile) in zip(cells, samples):
        _box(slide.shapes, cell, dml.blip_fill(r_id, tile=tile), f"texture {label}", w=170, h=90, dy=10)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 24, cell[2], label)


def _picture(deck):
    slide = deck.slide(SECTION, ["blipFill:stretch", "blipFill:srcRect", "blipFill:fillRect",
                                 "blipFill:rotWithShape"], smoke=True, title="그림 채우기")
    r_id = dml.image_rid(slide, images.png_bytes(images.picture()))
    samples = (
        ("stretch rect", "rect", {}, 0, True),
        ("stretch ellipse", "ellipse", {}, 0, True),
        ("stretch star5", "star5", {}, 0, True),
        ("stretch heart", "heart", {}, 0, True),
        ("srcRect crop 25% left/top", "rect", dict(src_rect=(25, 25, 0, 0)), 0, True),
        ("srcRect crop centre", "roundRect", dict(src_rect=(20, 20, 20, 20)), 0, True),
        ("fillRect inset 10%", "rect", dict(fill_rect=(10, 10, 10, 10)), 0, True),
        ("fillRect outset -20%", "rect", dict(fill_rect=(-20, -20, -20, -20)), 0, True),
        ("rot 20, rotWithShape=1", "rect", {}, 20, True),
        ("rot 20, rotWithShape=0", "rect", {}, 20, False),
        ("flipH", "rect", {}, 0, True),
        ("snip2DiagRect", "snip2DiagRect", {}, 0, True),
    )
    for cell, (label, prst, kwargs, rot, rws) in zip(deck.grid(4, 3), samples):
        fill = dml.blip_fill(r_id, rot_with_shape=rws, **kwargs)
        _box(slide.shapes, cell, fill, f"picture {label}", prst=prst, w=150, h=94, dy=12, rot=rot,
             flip_h=label == "flipH")
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 24, cell[2], label)


def _transparent_picture(deck):
    slide = deck.slide(SECTION, ["blipFill:alphaModFix", "blipFill:rgba", "blipFill:rgba+alphaModFix"],
                       title="투명한 그림 채우기")
    photo = dml.image_rid(slide, images.png_bytes(images.picture()))
    rgba = dml.image_rid(slide, images.png_bytes(images.picture_rgba()))
    samples = (
        ("alphaModFix 75%", photo, 75, "rect"), ("alphaModFix 50%", photo, 50, "rect"),
        ("alphaModFix 25%", photo, 25, "rect"), ("alphaModFix 50% ellipse", photo, 50, "ellipse"),
        ("RGBA png", rgba, None, "rect"), ("RGBA png ellipse", rgba, None, "ellipse"),
        ("RGBA + alphaModFix 50%", rgba, 50, "rect"), ("RGBA + alphaModFix 50% star", rgba, 50, "star5"),
    )
    for cell, (label, r_id, alpha, prst) in zip(deck.grid(4, 2), samples):
        _box(slide.shapes, cell, dml.blip_fill(r_id, alpha=alpha), label, prst=prst, w=170, h=130, dy=40,
             stripes=True)
        deck.caption(slide.shapes, cell[0], cell[1] + cell[3] - 26, cell[2], label)


def build(deck):
    _solid(deck)
    _scheme(deck)
    _alpha(deck)
    _linear(deck)
    _path(deck)
    _multi_stop(deck)
    _gradient_extras(deck)
    _patterns(deck)
    _texture(deck)
    _picture(deck)
    _transparent_picture(deck)
