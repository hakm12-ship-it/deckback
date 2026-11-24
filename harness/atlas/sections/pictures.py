"""Atlas section `pictures`: p:pic pictures -- RGB PNG, transparent (RGBA) PNG, RGB JPEG and CMYK JPEG; crop
(srcRect), rotation (15 deg and more), flips, greyscale, duotone, black-and-white and brightness/contrast recolours,
transparency, borders, shadows and other effects, non-rectangular geometry (roundRect and more), stretched and tiny
pictures, and a group of pictures.

All images are drawn deterministically with numpy and Pillow (harness/atlas/images.py and the generators here): no
text, no randomness, no metadata, so the same Pillow and libjpeg versions give the same bytes. Pillow writes CMYK
JPEGs the way Photoshop does (Adobe APP14 marker, inverted samples), which is what PowerPoint expects."""

import io

import numpy as np
from PIL import Image, ImageDraw

from harness.atlas import drawingml as dml
from harness.atlas import images

SECTION = "pictures"
JPEG_QUALITY = 90
BORDER = dml.ln(1.5, color="1F3864")


def landscape(width=360, height=240):
    """An RGB scene with smooth gradients (sky, sea, hills, sun): JPEG-friendly, orientation visible."""
    yy, xx = np.mgrid[0:height, 0:width]
    horizon = int(height * 0.55)
    sky = np.stack([70 + 120 * yy / horizon, 130 + 90 * yy / horizon, 230 - 20 * yy / horizon], axis=-1)
    sea = np.stack([20 + 30 * xx / width, 80 + 40 * (yy - horizon) / (height - horizon), 150 + 0 * xx], axis=-1)
    rgb = np.where((yy < horizon)[..., None], sky, sea).clip(0, 255).astype(np.uint8)
    image = Image.fromarray(rgb, "RGB")
    draw = ImageDraw.Draw(image)
    draw.ellipse([width - 110, 25, width - 40, 95], fill=(255, 200, 40))
    draw.polygon([(0, horizon), (90, horizon - 70), (170, horizon), (250, horizon - 40), (width, horizon)],
                 fill=(60, 120, 60))
    draw.rectangle([0, 0, 15, 15], fill=(200, 0, 0))  # top-left marker (flips and rotations)
    return image


def jpeg_bytes(image, mode="RGB"):
    """JPEG bytes of the image converted to `mode` ('RGB' gives 3 components, 'CMYK' gives 4)."""
    buf = io.BytesIO()
    image.convert(mode).save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


class _Media:
    """The images once per deck (python-pptx stores each distinct image once per package)."""

    def __init__(self):
        self.png = images.png_bytes(images.picture())
        self.rgba = images.png_bytes(images.picture_rgba())
        self.jpeg = jpeg_bytes(landscape())
        self.cmyk = jpeg_bytes(landscape(), "CMYK")
        self.photo_jpeg = jpeg_bytes(images.picture())
        self.photo_cmyk = jpeg_bytes(images.picture(), "CMYK")


def _stripes(slide, x, y, w, h, n=8):
    step = w / n
    for i in range(n):
        dml.add_sp(slide.shapes, dml.sp_pr(x + i * step, y, step, h,
                                           fill=dml.solid_fill("000000" if i % 2 == 0 else "FFFFFF")),
                   name=f"Stripe {i}")


def _pic(slide, blob, cell, *, w=200, h=125, dy=8, name, **kwargs):
    """A picture centred in `cell` (x, y, w, h) above its caption line."""
    x, y, cw, ch = cell
    r_id = dml.image_rid(slide, blob)
    return dml.add_pic(slide.shapes, r_id, x + (cw - w) / 2, y + dy + (ch - 34 - h) / 2, w, h, name=name, **kwargs)


def _caption(deck, slide, cell, text):
    x, y, w, h = cell
    deck.caption(slide.shapes, x, y + h - 22, w, text)


def _formats(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:png:rgb", "pic:png:rgba", "pic:jpeg:rgb", "pic:jpeg:cmyk"], smoke=True,
                       title="그림 형식 (PNG RGB, PNG 투명, JPEG RGB, JPEG CMYK)")
    cells = deck.grid(2, 2)
    samples = ((media.png, "PNG RGB (색 형식 2)", 240, 150), (media.rgba, "PNG RGBA (투명, 색 형식 6)", 240, 150),
               (media.jpeg, "JPEG RGB (3 성분)", 240, 160), (media.cmyk, "JPEG CMYK (4 성분)", 240, 160))
    for i, (cell, (blob, label, w, h)) in enumerate(zip(cells, samples)):
        if i == 1:
            x, y, cw, ch = cell
            _stripes(slide, x + (cw - w) / 2 - 10, y + 8 + (ch - 34 - h) / 2 - 10, w + 20, h + 20)
        _pic(slide, blob, cell, w=w, h=h, name=label)
        _caption(deck, slide, cell, label)


def _cmyk(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:jpeg:cmyk", "pic:jpeg:rgb"], title="CMYK JPEG과 RGB JPEG 비교")
    for cell, (blob, label) in zip(deck.grid(2, 1), ((media.photo_jpeg, "RGB JPEG"), (media.photo_cmyk,
                                                                                      "CMYK JPEG"))):
        _pic(slide, blob, cell, w=400, h=250, name=label)
        _caption(deck, slide, cell, label)


CROPS = ((25, 0, 0, 0), (0, 20, 0, 20), (10, 10, 10, 10), (0, 0, 40, 0), (30, 25, 5, 5), (0, 0, 0, 50))


def _crop(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:srcRect"], title="자르기 (srcRect)")
    for cell, (l, t, r, b) in zip(deck.grid(3, 2), CROPS):
        w, h = 220 * (100 - l - r) / 100, 137.5 * (100 - t - b) / 100  # keep the cropped part's aspect ratio
        _pic(slide, media.png, cell, w=w, h=h, src_rect=(l, t, r, b), name=f"Crop {l}/{t}/{r}/{b}")
        _caption(deck, slide, cell, f"srcRect l={l} t={t} r={r} b={b} %")


ROTATIONS = (15, 30, 45, 90, 180, 345)


def _rotate(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:rot"] + [f"pic:rot:{a}" for a in ROTATIONS], smoke=True,
                       title="그림 회전 (15°부터)")
    for cell, angle in zip(deck.grid(3, 2), ROTATIONS):
        _pic(slide, media.png, cell, w=160, h=100, rot=angle, name=f"Rotate {angle}")
        _caption(deck, slide, cell, f"rot={angle}°")


def _flip(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:flipH", "pic:flipV", "pic:rot"], title="그림 뒤집기")
    flips = (("원본", {}), ("flipH", {"flip_h": True}), ("flipV", {"flip_v": True}),
             ("flipH + flipV", {"flip_h": True, "flip_v": True}), ("rot 30 + flipH", {"rot": 30, "flip_h": True}),
             ("rot 30 + flipV", {"rot": 30, "flip_v": True}))
    for cell, (label, kwargs) in zip(deck.grid(3, 2), flips):
        _pic(slide, media.jpeg, cell, w=180, h=120, name=f"Flip {label}", **kwargs)
        _caption(deck, slide, cell, label)


def _recolour(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:grayscl", "pic:duotone", "pic:biLevel", "pic:lum"], smoke=True,
                       title="다시 칠하기 (회색조, 이중톤, 흑백, 밝기·대비)")
    samples = (("원본", ()), ("회색조 grayscl", (dml.grayscl(),)),
               ("이중톤 duotone 검정→파랑", (dml.duotone("000000", "4472C4"),)),
               ("이중톤 duotone 남색→금색", (dml.duotone("1F3864", "FFC000"),)),
               ("흑백 biLevel 50%", (dml.bi_level(50),)), ("밝기 +30% 대비 -20%", (dml.lum(bright=30, contrast=-20),)))
    for cell, (label, effects) in zip(deck.grid(3, 2), samples):
        _pic(slide, media.png, cell, w=200, h=125, blip_effects=effects, name=f"Recolour {label}")
        _caption(deck, slide, cell, label)


def _transparency(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:alphaModFix", "pic:png:rgba"], title="그림 투명도")
    samples = ((media.png, 25, "불투명도 25%"), (media.png, 50, "불투명도 50%"), (media.png, 75, "불투명도 75%"),
               (media.rgba, None, "PNG 투명 (알파 채널)"), (media.rgba, 50, "PNG 투명 + 불투명도 50%"),
               (media.jpeg, 60, "JPEG + 불투명도 60%"))
    for cell, (blob, alpha, label) in zip(deck.grid(3, 2), samples):
        x, y, cw, ch = cell
        _stripes(slide, x + (cw - 200) / 2 - 10, y + 8 + (ch - 34 - 125) / 2 - 10, 220, 145, n=6)
        _pic(slide, blob, cell, w=200, h=125, alpha=alpha, name=f"Transparency {label}")
        _caption(deck, slide, cell, label)


def _border_shadow(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:ln", "pic:effect:outerShdw"], title="그림 테두리와 그림자")
    samples = (
        ("테두리 1 pt", {"line": dml.ln(1, color="000000")}),
        ("테두리 3 pt", {"line": dml.ln(3, color="C00000")}),
        ("이중 테두리 6 pt", {"line": dml.ln(6, color="1F3864", cmpd="dbl")}),
        ("점선 테두리 2 pt", {"line": dml.ln(2, color="7030A0", dash="dash")}),
        ("그림자", {"effects": dml.effect_lst(dml.outer_shdw(blur=8, dist=6, alpha=50))}),
        ("테두리 + 그림자", {"line": dml.ln(4, color="FFFFFF"),
                         "effects": dml.effect_lst(dml.outer_shdw(blur=10, dist=5, direction=45, alpha=55))}),
    )
    for cell, (label, kwargs) in zip(deck.grid(3, 2), samples):
        _pic(slide, media.png, cell, w=190, h=119, name=f"Border {label}", **kwargs)
        _caption(deck, slide, cell, label)


def _effects(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:effect:glow", "pic:effect:softEdge", "pic:effect:reflection",
                                 "pic:effect:innerShdw"], title="그림 효과 (네온, 부드러운 가장자리, 반사, 안쪽 그림자)")
    samples = (("네온 glow", dml.glow(8, "00B0F0", 60)), ("부드러운 가장자리 8 pt", dml.soft_edge(8)),
               ("반사 reflection", dml.reflection(end_pos=45, dist=3)), ("안쪽 그림자", dml.inner_shdw(blur=12, dist=6)),
               ("네온 gold", dml.glow(12, "FFC000", 70)), ("부드러운 가장자리 20 pt", dml.soft_edge(20)))
    for cell, (label, effect) in zip(deck.grid(3, 2), samples):
        _pic(slide, media.jpeg, cell, w=180, h=120, dy=-6, effects=dml.effect_lst(effect), name=f"Effect {label}")
        _caption(deck, slide, cell, label)


GEOMETRIES = ("roundRect", "ellipse", "hexagon", "snip2SameRect", "teardrop", "star5")


def _geometry(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:geom", "pic:ln"], title="도형 모양 그림 (둥근 사각형 등)")
    for cell, prst in zip(deck.grid(3, 2), GEOMETRIES):
        _pic(slide, media.png, cell, w=200, h=125, prst=prst, line=BORDER, name=f"Geometry {prst}")
        _caption(deck, slide, cell, prst)


def _scaling(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:distorted"], title="늘리고 줄인 그림")
    x, y, w, h = deck.content
    dml.add_pic(slide.shapes, dml.image_rid(slide, media.png), x, y, 400, 100, name="Stretched wide")
    deck.caption(slide.shapes, x, y + 104, 400, "가로로 늘림 (4:1)")
    dml.add_pic(slide.shapes, dml.image_rid(slide, media.png), x + 430, y, 80, 300, name="Stretched tall")
    deck.caption(slide.shapes, x + 400, y + 304, 140, "세로로 늘림")
    for i, (pw, ph) in enumerate(((40, 25), (16, 10), (64, 40))):
        dml.add_pic(slide.shapes, dml.image_rid(slide, media.jpeg), x + 560 + i * 90, y, pw, ph,
                    name=f"Tiny {pw}x{ph}")
    deck.caption(slide.shapes, x + 560, y + 50, 260, "작은 그림 40×25, 16×10, 64×40 pt", align="l")
    dml.add_pic(slide.shapes, dml.image_rid(slide, media.jpeg), x, y + 140, 420, 280, name="Large")
    deck.caption(slide.shapes, x + 430, y + 400, 200, "큰 그림 420×280 pt", align="l")


def _combined(deck, media):
    slide = deck.slide(SECTION, ["pic", "pic:srcRect", "pic:rot", "pic:flipH", "pic:ln", "pic:effect:outerShdw",
                                 "pic:grayscl", "grpSp", "grpSp:pic", "grpSp:rot"], title="효과를 겹친 그림, 그림 묶음")
    cells = deck.grid(2, 1)
    _pic(slide, media.png, cells[0], w=240, h=110, src_rect=(10, 20, 10, 20), rot=20, flip_h=True,
         line=dml.ln(3, color="C00000"), effects=dml.effect_lst(dml.outer_shdw(blur=8, dist=6)),
         blip_effects=(dml.grayscl(),), name="Combined")
    _caption(deck, slide, cells[0], "자르기 + 회전 + 뒤집기 + 테두리 + 그림자 + 회색조")
    group = slide.shapes.add_group_shape()
    group.name = "Picture group"
    x, y, w, _ = cells[1]
    for i, blob in enumerate((media.png, media.jpeg, media.rgba)):
        dml.add_pic(group.shapes, dml.image_rid(slide, blob), x + 30 + i * 120, y + 60 + i * 50, 150, 94,
                    line=BORDER, name=f"Grouped picture {i + 1}")
    dml.set_group_transform(group, rot=10)
    _caption(deck, slide, cells[1], "그림 세 장 묶음, 묶음 회전 10°")


def build(deck):
    media = _Media()
    _formats(deck, media)
    _cmyk(deck, media)
    _crop(deck, media)
    _rotate(deck, media)
    _flip(deck, media)
    _recolour(deck, media)
    _transparency(deck, media)
    _border_shadow(deck, media)
    _effects(deck, media)
    _geometry(deck, media)
    _scaling(deck, media)
    _combined(deck, media)
