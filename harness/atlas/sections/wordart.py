"""Atlas section `wordart`: all 41 ECMA-376 text warps (a:prstTxWarp, ST_TextShapeType), 6 per slide, each slide in
another WordArt style (solid, gradient, outline-only, shadow, glow, reflection, outlined white)."""

from harness.atlas import drawingml as dml

SECTION = "wordart"
PER_SLIDE = 6
TEXT = "워드아트 WordArt"

# (features, run keyword arguments) per slide, in order
STYLES = (
    (["text:solidFill:srgb"], {"color": "2F5597"}),
    (["text:gradFill", "text:ln"], {"fill": dml.grad_fill([(0, "FFC000"), (100, "ED7D31")], angle=90),
                                    "line": dml.ln(0.75, color="843C0C")}),
    (["text:outline-only", "text:noFill", "text:ln"], {"fill": dml.no_fill(), "line": dml.ln(1.5, color="7030A0")}),
    (["effect:outerShdw:text"], {"color": "C00000", "effects": dml.effect_lst(dml.outer_shdw(blur=4, dist=4))}),
    (["text:gradFill", "effect:glow:text"], {"fill": dml.grad_fill([(0, "00B0F0"), (100, "002060")], angle=0),
                                             "effects": dml.effect_lst(dml.glow(5, "FFC000", 60))}),
    (["effect:reflection:text"], {"color": "548235", "effects": dml.effect_lst(dml.reflection(end_pos=45, dist=2))}),
    (["text:ln", "effect:outerShdw:text"], {"color": "FFFFFF", "line": dml.ln(1.25, color="1F3864"),
                                            "effects": dml.effect_lst(dml.outer_shdw(blur=2, dist=3, alpha=60))}),
)


def build(deck):
    presets = dml.PRST_TX_WARP
    pages = -(-len(presets) // PER_SLIDE)
    for page in range(pages):
        chunk = presets[page * PER_SLIDE:(page + 1) * PER_SLIDE]
        style_features, run_kwargs = STYLES[page % len(STYLES)]
        slide = deck.slide(SECTION, [f"prstTxWarp:{p}" for p in chunk] + style_features, smoke=page in (0, 3),
                           title=f"워드아트 변환 {page + 1}/{pages}")
        for (x, y, w, h), preset in zip(deck.grid(3, 2), chunk):
            body = dml.body_pr(wrap=False, anchor="ctr", warp=preset, insets=(4, 4, 4, 4))
            if preset.endswith("Pour"):  # the "pour" warps fill several lines
                paragraphs = [deck.para(line, "HEAD", 30, align="ctr", **run_kwargs) for line in ("워드아트", "WordArt")]
            else:
                paragraphs = [deck.para(TEXT, "HEAD", 30, align="ctr", **run_kwargs)]
            deck.textbox(slide.shapes, x + 14, y + 8, w - 28, h - 44, paragraphs, name=f"WordArt {preset}", body=body)
            deck.caption(slide.shapes, x, y + h - 26, w, preset)
