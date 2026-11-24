"""Atlas section `effects`: outer shadow, inner shadow, glow, soft edge, reflection, bevel and 3-D rotation, each on
shapes (spPr) and on text (run effectLst; text bevel and 3-D rotation in bodyPr)."""

from harness.atlas import drawingml as dml

SECTION = "effects"
INK = dml.ln(1, color="1F2A44")
TEXT = "효과 Effect"


def _shape_slide(deck, effect, title, samples, *, smoke=False, cols=3, rows=2, w=150, h=90, extra_features=()):
    """samples: [(label, sp_pr keyword arguments)] drawn as shapes, one per cell."""
    slide = deck.slide(SECTION, [f"effect:{effect}:shape", *extra_features], smoke=smoke, title=title)
    for (x, y, cw, ch), (label, kwargs) in zip(deck.grid(cols, rows), samples):
        kwargs = dict(kwargs)
        prst = kwargs.pop("prst", "roundRect")
        fill = kwargs.pop("fill", dml.solid_fill("4472C4"))
        line = kwargs.pop("line", INK)
        dml.add_sp(slide.shapes, dml.sp_pr(x + (cw - w) / 2, y + (ch - h) / 2 - 10, w, h, prst=prst, fill=fill,
                                           line=line, **kwargs), name=f"{effect} {label}")
        deck.caption(slide.shapes, x, y + ch - 24, cw, label)
    return slide


def _text_slide(deck, effect, title, samples, *, smoke=False, extra_features=()):
    """samples: [(label, rpr keyword arguments, bodyPr keyword arguments)] drawn as 40 pt HEAD text, 2 per row."""
    slide = deck.slide(SECTION, [f"effect:{effect}:text", *extra_features], smoke=smoke, title=title)
    rows = -(-len(samples) // 2)
    for (x, y, cw, ch), (label, rpr_kwargs, body_kwargs) in zip(deck.grid(2, rows), samples):
        rpr_kwargs = dict(rpr_kwargs)
        rpr_kwargs.setdefault("color", "2F5597")
        body = dml.body_pr(anchor="ctr", wrap=False, **body_kwargs)
        para = deck.para(TEXT, "HEAD", 40, align="ctr", **rpr_kwargs)
        deck.textbox(slide.shapes, x + 10, y + 4, cw - 20, ch - 34, [para], name=f"{effect} text {label}",
                     body=body)
        deck.caption(slide.shapes, x, y + ch - 24, cw, label)
    return slide


def _fx(*effects):
    return {"effects": dml.effect_lst(*effects)}


def _outer_shadow(deck):
    _shape_slide(deck, "outerShdw", "바깥쪽 그림자 (도형)", [
        ("offset bottom-right", _fx(dml.outer_shdw(blur=4, dist=4, direction=45))),
        ("large blur", _fx(dml.outer_shdw(blur=14, dist=8, direction=45, alpha=50))),
        ("hard, no blur", _fx(dml.outer_shdw(blur=0, dist=6, direction=45, alpha=70))),
        ("coloured, up-left", _fx(dml.outer_shdw(blur=6, dist=6, direction=225, color_value="0070C0",
                                                 alpha=60))),
        ("perspective", _fx(dml.outer_shdw(blur=6, dist=0, direction=0, sy=30, kx=-45, algn="bl", alpha=50))),
        ("ellipse, centred halo", dict(prst="ellipse", **_fx(dml.outer_shdw(blur=18, dist=0, alpha=60)))),
    ], smoke=True)
    _text_slide(deck, "outerShdw", "바깥쪽 그림자 (글자)", [
        ("offset bottom-right", _fx(dml.outer_shdw(blur=3, dist=3, direction=45)), {}),
        ("large blur", _fx(dml.outer_shdw(blur=10, dist=6, direction=45, alpha=60)), {}),
        ("coloured, up-left", _fx(dml.outer_shdw(blur=4, dist=4, direction=225, color_value="C00000",
                                                 alpha=70)), {}),
        ("perspective", _fx(dml.outer_shdw(blur=4, dist=0, direction=0, sy=40, kx=-40, algn="bl")), {}),
    ], smoke=True)


def _inner_shadow(deck):
    _shape_slide(deck, "innerShdw", "안쪽 그림자 (도형)", [
        ("top-left", _fx(dml.inner_shdw(blur=6, dist=4, direction=225))),
        ("bottom-right", _fx(dml.inner_shdw(blur=6, dist=4, direction=45))),
        ("centred, wide blur", _fx(dml.inner_shdw(blur=20, dist=0, alpha=70))),
        ("coloured", _fx(dml.inner_shdw(blur=8, dist=5, direction=90, color_value="FFC000", alpha=90))),
        ("on ellipse", dict(prst="ellipse", **_fx(dml.inner_shdw(blur=10, dist=6, direction=315)))),
        ("on light fill", dict(fill=dml.solid_fill("DEEBF7"), **_fx(dml.inner_shdw(blur=8, dist=4, direction=45)))),
    ])
    _text_slide(deck, "innerShdw", "안쪽 그림자 (글자)", [
        ("top-left", _fx(dml.inner_shdw(blur=3, dist=2, direction=225, alpha=80)), {}),
        ("bottom-right", _fx(dml.inner_shdw(blur=3, dist=2, direction=45, alpha=80)), {}),
        ("centred blur", _fx(dml.inner_shdw(blur=6, dist=0, alpha=90)), {}),
        ("coloured", _fx(dml.inner_shdw(blur=3, dist=2, direction=90, color_value="FFC000", alpha=100)), {}),
    ])


def _glow(deck):
    _shape_slide(deck, "glow", "네온 (glow, 도형)", [
        ("5 pt gold 60%", _fx(dml.glow(5, "FFC000", 60))),
        ("10 pt blue 40%", _fx(dml.glow(10, "00B0F0", 40))),
        ("18 pt green 80%", _fx(dml.glow(18, "92D050", 80))),
        ("scheme accent2", _fx(f'<a:glow rad="{dml.emu(8)}">{dml.color("accent2", alpha=60)}</a:glow>')),
        ("on ellipse", dict(prst="ellipse", **_fx(dml.glow(10, "FF00FF", 50)))),
        ("on outline only", dict(fill=dml.no_fill(), line=dml.ln(3, color="7030A0"),
                                 **_fx(dml.glow(8, "7030A0", 50)))),
    ])
    _text_slide(deck, "glow", "네온 (glow, 글자)", [
        ("5 pt gold", _fx(dml.glow(5, "FFC000", 60)), {}),
        ("10 pt blue", _fx(dml.glow(10, "00B0F0", 40)), {}),
        ("18 pt green", _fx(dml.glow(18, "92D050", 80)), {}),
        ("white text, dark glow", dict(color="FFFFFF", **_fx(dml.glow(6, "1F2A44", 90))), {}),
    ])


def _soft_edge(deck):
    _shape_slide(deck, "softEdge", "부드러운 가장자리 (도형)", [
        ("2.5 pt", _fx(dml.soft_edge(2.5))),
        ("5 pt", _fx(dml.soft_edge(5))),
        ("10 pt", _fx(dml.soft_edge(10))),
        ("25 pt", _fx(dml.soft_edge(25))),
        ("ellipse 10 pt", dict(prst="ellipse", **_fx(dml.soft_edge(10)))),
        ("star5 5 pt", dict(prst="star5", fill=dml.solid_fill("C00000"), **_fx(dml.soft_edge(5)))),
    ])
    _text_slide(deck, "softEdge", "부드러운 가장자리 (글자)", [
        ("1 pt", _fx(dml.soft_edge(1)), {}),
        ("2.5 pt", _fx(dml.soft_edge(2.5)), {}),
        ("5 pt", _fx(dml.soft_edge(5)), {}),
        ("2.5 pt + shadow", _fx(dml.soft_edge(2.5), dml.outer_shdw(blur=3, dist=3)), {}),
    ])


def _reflection(deck):
    _shape_slide(deck, "reflection", "반사 (도형)", [
        ("tight, touching", _fx(dml.reflection(end_pos=35))),
        ("half, 4 pt offset", _fx(dml.reflection(end_pos=55, dist=4))),
        ("full, 8 pt offset", _fx(dml.reflection(end_pos=90, dist=8))),
        ("blurred", _fx(dml.reflection(blur=6, end_pos=60, dist=2))),
        ("ellipse", dict(prst="ellipse", **_fx(dml.reflection(end_pos=55)))),
        ("with shadow", _fx(dml.reflection(end_pos=45, dist=2), dml.outer_shdw(blur=4, dist=3))),
    ], h=70)
    _text_slide(deck, "reflection", "반사 (글자)", [
        ("tight", _fx(dml.reflection(end_pos=35)), {}),
        ("half, 4 pt offset", _fx(dml.reflection(end_pos=55, dist=4)), {}),
        ("full, 8 pt offset", _fx(dml.reflection(end_pos=90, dist=8)), {}),
        ("blurred", _fx(dml.reflection(blur=3, end_pos=60, dist=2)), {}),
    ])


def _bevel(deck):
    flat_front = dml.scene3d("orthographicFront")
    _shape_slide(deck, "bevel", "입체 테두리 (bevel, 도형 12종)", [
        (prst, dict(scene=flat_front, shape3d=dml.sp3d(bevel_top=(8, 8, prst))))
        for prst in dml.BEVEL_PRESETS
    ], cols=4, rows=3, w=120, h=70, extra_features=[f"bevel:{p}" for p in dml.BEVEL_PRESETS])
    text_bevels = ("circle", "angle", "artDeco", "convex", "coolSlant", "relaxedInset")
    _text_slide(deck, "bevel", "입체 테두리 (bevel, 글자)", [
        (f"bevel {prst}", {}, dict(scene=flat_front, shape3d=dml.sp3d(bevel_top=(3, 3, prst))))
        for prst in text_bevels
    ], extra_features=[f"bevel:{p}" for p in text_bevels])


CAMERAS = (
    "isometricLeftDown", "isometricRightUp", "isometricTopUp", "isometricOffAxis1Left", "obliqueTopLeft",
    "obliqueBottomRight", "perspectiveFront", "perspectiveLeft", "perspectiveRight", "perspectiveAbove",
    "perspectiveContrastingLeftFacing",
)


def _rotation_3d(deck):
    samples = [
        (camera, dict(scene=dml.scene3d(camera), shape3d=dml.sp3d(extrusion=12, extrusion_color="1F3864",
                                                                   bevel_top=(4, 4, "circle"))))
        for camera in CAMERAS
    ]
    samples.append(("orthographicFront rot 20/30/0", dict(
        scene=dml.scene3d("orthographicFront", rot=(20, 30, 0)),
        shape3d=dml.sp3d(extrusion=12, extrusion_color="1F3864"))))
    _shape_slide(deck, "3dRotation", "3차원 회전 (도형)", samples, cols=4, rows=3, w=110, h=66, smoke=True,
                 extra_features=[f"camera:{c}" for c in CAMERAS] + ["camera:rot", "sp3d:extrusion"])
    _text_slide(deck, "3dRotation", "3차원 회전 (글자)", [
        ("perspectiveLeft", {}, dict(scene=dml.scene3d("perspectiveLeft"))),
        ("perspectiveRight", {}, dict(scene=dml.scene3d("perspectiveRight"))),
        ("isometricLeftDown + depth", {}, dict(scene=dml.scene3d("isometricLeftDown"),
                                               shape3d=dml.sp3d(extrusion=6, extrusion_color="1F3864"))),
        ("orthographicFront rot 0/40/0", {}, dict(scene=dml.scene3d("orthographicFront", rot=(0, 40, 0)))),
        ("perspectiveAbove", {}, dict(scene=dml.scene3d("perspectiveAbove"))),
        ("obliqueTopLeft + depth", {}, dict(scene=dml.scene3d("obliqueTopLeft"),
                                            shape3d=dml.sp3d(extrusion=4))),
    ], extra_features=["camera:rot", "sp3d:extrusion", "camera:perspectiveLeft", "camera:perspectiveRight",
                       "camera:isometricLeftDown", "camera:perspectiveAbove", "camera:obliqueTopLeft"])


def build(deck):
    _outer_shadow(deck)
    _inner_shadow(deck)
    _glow(deck)
    _soft_edge(deck)
    _reflection(deck)
    _bevel(deck)
    _rotation_3d(deck)
