"""DrawingML XML builders for the feature atlas.

Extends harness/spikes/pptx_xml.py (custGeom, gradFill) with the rest of what the atlas authors: preset shapes,
connectors, fills, lines, effects, 3-D, text runs and paragraphs (underline, strike, baseline, spacing, highlight,
hyperlinks, bullets, numbering, tabs), text bodies (vertical text, columns, autofit, WordArt warps), table-cell
properties, pictures (crop, recolour, geometry), backgrounds and footer placeholders. pptx_xml stays where it is
because the M0 spike scripts import it as a sibling file; this module imports it as `harness.spikes.pptx_xml` and
re-exports its helpers.

Every builder returns an XML string (no namespace declarations; `add_sp` / `add_cxn` / `group` parse them inside a
p:sp, p:cxnSp or p:grpSp that declares a:, p: and r:). Child elements are always written in the order the ECMA-376
schema requires — PowerPoint shows a repair prompt for out-of-order children.

Units: positions and lengths in points (1 pt = 12700 EMU), angles in degrees (clockwise, 0 = +x), percentages as
0..100 (written in 1/1000 %). Colours: 'RRGGBB' hex or a scheme colour name ('accent1', 'tx1', ...).
"""

from xml.sax.saxutils import escape, quoteattr

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

from harness.spikes import pptx_xml
from harness.spikes.pptx_xml import EMU_PER_PT, add_custgeom, add_gradfill  # noqa: F401  (re-exported)

# ECMA-376 Part 1, 20.1.10.56 ST_ShapeType: every preset geometry, in schema order (187 values).
ST_SHAPE_TYPE = (
    "line", "lineInv", "triangle", "rtTriangle", "rect", "diamond", "parallelogram", "trapezoid",
    "nonIsoscelesTrapezoid", "pentagon", "hexagon", "heptagon", "octagon", "decagon", "dodecagon",
    "star4", "star5", "star6", "star7", "star8", "star10", "star12", "star16", "star24", "star32",
    "roundRect", "round1Rect", "round2SameRect", "round2DiagRect", "snipRoundRect", "snip1Rect",
    "snip2SameRect", "snip2DiagRect", "plaque", "ellipse", "teardrop", "homePlate", "chevron", "pieWedge",
    "pie", "blockArc", "donut", "noSmoking", "rightArrow", "leftArrow", "upArrow", "downArrow",
    "stripedRightArrow", "notchedRightArrow", "bentUpArrow", "leftRightArrow", "upDownArrow", "leftUpArrow",
    "leftRightUpArrow", "quadArrow", "leftArrowCallout", "rightArrowCallout", "upArrowCallout",
    "downArrowCallout", "leftRightArrowCallout", "upDownArrowCallout", "quadArrowCallout", "bentArrow",
    "uturnArrow", "circularArrow", "leftCircularArrow", "leftRightCircularArrow", "curvedRightArrow",
    "curvedLeftArrow", "curvedUpArrow", "curvedDownArrow", "swooshArrow", "cube", "can", "lightningBolt",
    "heart", "sun", "moon", "smileyFace", "irregularSeal1", "irregularSeal2", "foldedCorner", "bevel",
    "frame", "halfFrame", "corner", "diagStripe", "chord", "arc", "leftBracket", "rightBracket", "leftBrace",
    "rightBrace", "bracketPair", "bracePair", "straightConnector1", "bentConnector2", "bentConnector3",
    "bentConnector4", "bentConnector5", "curvedConnector2", "curvedConnector3", "curvedConnector4",
    "curvedConnector5", "callout1", "callout2", "callout3", "accentCallout1", "accentCallout2",
    "accentCallout3", "borderCallout1", "borderCallout2", "borderCallout3", "accentBorderCallout1",
    "accentBorderCallout2", "accentBorderCallout3", "wedgeRectCallout", "wedgeRoundRectCallout",
    "wedgeEllipseCallout", "cloudCallout", "cloud", "ribbon", "ribbon2", "ellipseRibbon", "ellipseRibbon2",
    "leftRightRibbon", "verticalScroll", "horizontalScroll", "wave", "doubleWave", "plus", "flowChartProcess",
    "flowChartDecision", "flowChartInputOutput", "flowChartPredefinedProcess", "flowChartInternalStorage",
    "flowChartDocument", "flowChartMultidocument", "flowChartTerminator", "flowChartPreparation",
    "flowChartManualInput", "flowChartManualOperation", "flowChartConnector", "flowChartPunchedCard",
    "flowChartPunchedTape", "flowChartSummingJunction", "flowChartOr", "flowChartCollate", "flowChartSort",
    "flowChartExtract", "flowChartMerge", "flowChartOfflineStorage", "flowChartOnlineStorage",
    "flowChartMagneticTape", "flowChartMagneticDisk", "flowChartMagneticDrum", "flowChartDisplay",
    "flowChartDelay", "flowChartAlternateProcess", "flowChartOffpageConnector", "actionButtonBlank",
    "actionButtonHome", "actionButtonHelp", "actionButtonInformation", "actionButtonForwardNext",
    "actionButtonBackPrevious", "actionButtonEnd", "actionButtonBeginning", "actionButtonReturn",
    "actionButtonDocument", "actionButtonSound", "actionButtonMovie", "gear6", "gear9", "funnel", "mathPlus",
    "mathMinus", "mathMultiply", "mathDivide", "mathEqual", "mathNotEqual", "cornerTabs", "squareTabs",
    "plaqueTabs", "chartX", "chartStar", "chartPlus",
)

# 20.1.10.48 ST_PresetLineDashVal (11 values).
PRST_DASH = (
    "solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot",
    "sysDash", "sysDot", "sysDashDot", "sysDashDotDot",
)

# 20.1.10.51 ST_PresetPatternVal (54 values; PowerPoint's picker shows 48 — all but the six legacy hatches
# horz, vert, cross, dnDiag, upDiag, diagCross).
PRST_PATTERN = (
    "pct5", "pct10", "pct20", "pct25", "pct30", "pct40", "pct50", "pct60", "pct70", "pct75", "pct80", "pct90",
    "horz", "vert", "ltHorz", "ltVert", "dkHorz", "dkVert", "narHorz", "narVert", "dashHorz", "dashVert",
    "cross", "dnDiag", "upDiag", "ltDnDiag", "ltUpDiag", "dkDnDiag", "dkUpDiag", "wdDnDiag", "wdUpDiag",
    "dashDnDiag", "dashUpDiag", "diagCross", "smCheck", "lgCheck", "smGrid", "lgGrid", "dotGrid",
    "smConfetti", "lgConfetti", "horzBrick", "diagBrick", "solidDmnd", "openDmnd", "dotDmnd", "plaid",
    "sphere", "weave", "divot", "shingle", "wave", "trellis", "zigZag",
)

LINE_CAPS = ("flat", "rnd", "sq")  # ST_LineCap
LINE_JOINS = ("round", "bevel", "miter")  # EG_LineJoinProperties
COMPOUND_LINES = ("sng", "dbl", "thickThin", "thinThick", "tri")  # ST_CompoundLine
LINE_END_TYPES = ("none", "triangle", "stealth", "diamond", "oval", "arrow")  # ST_LineEndType
LINE_END_SIZES = ("sm", "med", "lg")  # ST_LineEndWidth / ST_LineEndLength
BEVEL_PRESETS = (  # ST_BevelPresetType
    "relaxedInset", "circle", "slope", "cross", "angle", "softRound",
    "convex", "coolSlant", "divot", "riblet", "hardEdge", "artDeco",
)
SCHEME_COLORS = (  # ST_SchemeColorVal
    "bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink", "phClr", "dk1", "lt1", "dk2", "lt2",
)
# CT_EffectList children, in schema order.
EFFECT_ORDER = ("blur", "fillOverlay", "glow", "innerShdw", "outerShdw", "prstShdw", "reflection", "softEdge")
PATH_SHADE_TYPES = ("circle", "rect", "shape")  # ST_PathShadeType

# 20.1.10.76 ST_TextShapeType: every WordArt transform (a:prstTxWarp), in schema order (41 values).
PRST_TX_WARP = (
    "textNoShape", "textPlain", "textStop", "textTriangle", "textTriangleInverted", "textChevron",
    "textChevronInverted", "textRingInside", "textRingOutside", "textArchUp", "textArchDown", "textCircle",
    "textButton", "textArchUpPour", "textArchDownPour", "textCirclePour", "textButtonPour", "textCurveUp",
    "textCurveDown", "textCanUp", "textCanDown", "textWave1", "textWave2", "textDoubleWave1", "textWave4",
    "textInflate", "textDeflate", "textInflateBottom", "textDeflateBottom", "textInflateTop", "textDeflateTop",
    "textDeflateInflate", "textDeflateInflateDeflate", "textFadeRight", "textFadeLeft", "textFadeUp", "textFadeDown",
    "textSlantUp", "textSlantDown", "textCascadeUp", "textCascadeDown",
)
UNDERLINE_TYPES = (  # ST_TextUnderlineType
    "none", "words", "sng", "dbl", "heavy", "dotted", "dottedHeavy", "dash", "dashHeavy", "dashLong",
    "dashLongHeavy", "dotDash", "dotDashHeavy", "dotDotDash", "dotDotDashHeavy", "wavy", "wavyHeavy", "wavyDbl",
)
STRIKE_TYPES = ("noStrike", "sngStrike", "dblStrike")  # ST_TextStrikeType
CAP_TYPES = ("none", "small", "all")  # ST_TextCapsType
TEXT_ALIGN = ("l", "ctr", "r", "just", "justLow", "dist", "thaiDist")  # ST_TextAlignType
TEXT_VERT = ("horz", "vert", "vert270", "wordArtVert", "eaVert", "mongolianVert", "wordArtVertRtl")
TEXT_ANCHOR = ("t", "ctr", "b", "just", "dist")  # ST_TextAnchoringType
TAB_ALIGN = ("l", "ctr", "r", "dec")  # ST_TextTabAlignType
AUTONUM_SCHEMES = (  # ST_TextAutonumberScheme
    "alphaLcParenBoth", "alphaUcParenBoth", "alphaLcParenR", "alphaUcParenR", "alphaLcPeriod", "alphaUcPeriod",
    "arabicParenBoth", "arabicParenR", "arabicPeriod", "arabicPlain", "romanLcParenBoth", "romanUcParenBoth",
    "romanLcParenR", "romanUcParenR", "romanLcPeriod", "romanUcPeriod", "circleNumDbPlain", "circleNumWdBlackPlain",
    "circleNumWdWhitePlain", "arabicDbPeriod", "arabicDbPlain", "ea1ChsPeriod", "ea1ChsPlain", "ea1ChtPeriod",
    "ea1ChtPlain", "ea1JpnChsDbPeriod", "ea1JpnKorPlain", "ea1JpnKorPeriod", "arabic1Minus", "arabic2Minus",
    "hebrew2Minus", "thaiAlphaPeriod", "thaiAlphaParenR", "thaiAlphaParenBoth", "thaiNumPeriod", "thaiNumParenR",
    "thaiNumParenBoth", "hindiAlphaPeriod", "hindiNumPeriod", "hindiNumParenR", "hindiAlpha1Period",
)
# a:ln and the table-cell border lines that share its CT_LineProperties type, plus the run underline line.
LINE_TAGS = ("a:ln", "a:lnL", "a:lnR", "a:lnT", "a:lnB", "a:lnTlToBr", "a:lnBlToTr", "a:uLn")
TABLE_BORDERS = ("L", "R", "T", "B", "TlToBr", "BlToTr")  # CT_TableCellProperties line children, in order
# CT_TextCharacterProperties children that follow latin/ea/cs (apply_fonts inserts the fonts before them).
_AFTER_FONTS = ("sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst")

_hex = pptx_xml._hex


def emu(points):
    return int(round(points * EMU_PER_PT))


def ang(degrees):
    """Degrees -> ST_PositiveFixedAngle (1/60000 degree, 0..21599999)."""
    return int(round((degrees % 360) * 60000)) % 21600000


def pct(percent):
    """0..100 -> ST_Percentage units (1/1000 %)."""
    return int(round(percent * 1000))


def _attrs(**values):
    """' name="value"' for every value that is not None (False/True -> "0"/"1")."""
    out = []
    for name, value in values.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = int(value)
        out.append(f' {name}="{value}"')
    return "".join(out)


# --- colours and fills --------------------------------------------------------------------------------------------


def color(value, alpha=None, lum_mod=None, lum_off=None, shade=None, tint=None):
    """An srgbClr (hex value) or schemeClr (scheme name) with optional transforms. alpha is the opacity in %."""
    mods = ""
    for tag, amount in (("tint", tint), ("shade", shade), ("alpha", alpha), ("lumMod", lum_mod), ("lumOff", lum_off)):
        if amount is not None:
            mods += f'<a:{tag} val="{pct(amount)}"/>'
    if isinstance(value, str) and value in SCHEME_COLORS:
        return f'<a:schemeClr val="{value}">{mods}</a:schemeClr>' if mods else f'<a:schemeClr val="{value}"/>'
    try:
        hex_value = _hex(value)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"not a hex colour or scheme colour name: {value!r}") from exc
    return f'<a:srgbClr val="{hex_value}">{mods}</a:srgbClr>' if mods else f'<a:srgbClr val="{hex_value}"/>'


color_xml = color  # for builders whose own keyword argument `color` shadows the function


def _color_of(spec):
    """'RRGGBB' | scheme name | (value, alpha%) -> colour XML."""
    if isinstance(spec, tuple) and len(spec) == 2 and not isinstance(spec[0], int):
        return color(spec[0], alpha=spec[1])
    return color(spec)


def no_fill():
    return "<a:noFill/>"


def solid_fill(value, alpha=None, **mods):
    return f"<a:solidFill>{color(value, alpha=alpha, **mods)}</a:solidFill>"


def grad_fill(stops, *, angle=None, scaled=False, path=None, focus=None, rot_with_shape=True, flip=None,
              tile_rect=None):
    """A gradient fill.

    stops: [(position 0..100, colour[, alpha %]), ...], at least two.
    angle: linear gradient direction in degrees (a:lin). path: 'circle' | 'rect' | 'shape' (a:path) instead.
    focus: fillToRect of a path gradient as (l, t, r, b) insets in % of the shape box (default centre).
    scaled applies to linear gradients only, focus to path gradients only (a mismatch raises ValueError).
    flip: None | 'x' | 'y' | 'xy'; tile_rect: (l, t, r, b) in % or None.
    """
    if len(stops) < 2:
        raise ValueError("a gradient needs at least two stops")
    if (angle is None) == (path is None):
        raise ValueError("give exactly one of angle (linear) or path (circle/rect/shape)")
    if path is None and focus is not None:
        raise ValueError("focus (fillToRect) applies to path gradients only")
    if path is not None and scaled:
        raise ValueError("scaled applies to linear gradients only")
    gs = []
    for stop in stops:
        position, value = stop[0], stop[1]
        alpha = stop[2] if len(stop) > 2 else None
        if not 0 <= position <= 100:
            raise ValueError(f"stop position must be within 0..100: {position!r}")
        gs.append(f'<a:gs pos="{pct(position)}">{color(value, alpha=alpha)}</a:gs>')
    if path is not None:
        if path not in PATH_SHADE_TYPES:
            raise ValueError(f"unknown path gradient {path!r}")
        l, t, r, b = (pct(v) for v in (focus or (50, 50, 50, 50)))
        shade = f'<a:path path="{path}"><a:fillToRect l="{l}" t="{t}" r="{r}" b="{b}"/></a:path>'
    else:
        shade = f'<a:lin ang="{ang(angle)}" scaled="{int(bool(scaled))}"/>'
    tile = ""
    if tile_rect is not None:
        l, t, r, b = (pct(v) for v in tile_rect)
        tile = f'<a:tileRect l="{l}" t="{t}" r="{r}" b="{b}"/>'
    return (
        f'<a:gradFill{_attrs(flip=flip, rotWithShape=bool(rot_with_shape))}>'
        f'<a:gsLst>{"".join(gs)}</a:gsLst>{shade}{tile}</a:gradFill>'
    )


def patt_fill(prst, fg, bg):
    """A preset pattern fill; fg/bg are colours or (colour, alpha %)."""
    if prst not in PRST_PATTERN:
        raise ValueError(f"unknown preset pattern {prst!r}")
    return (
        f'<a:pattFill prst="{prst}"><a:fgClr>{_color_of(fg)}</a:fgClr>'
        f"<a:bgClr>{_color_of(bg)}</a:bgClr></a:pattFill>"
    )


def grayscl():
    """Picture recolour: greyscale (a:blip child)."""
    return "<a:grayscl/>"


def duotone(dark, light):
    """Picture recolour: map dark..light luminance onto two colours (a:blip child)."""
    return f"<a:duotone>{color(dark)}{color(light)}</a:duotone>"


def bi_level(threshold):
    """Picture recolour: black and white at a luminance threshold in % (a:blip child)."""
    return f'<a:biLevel thresh="{pct(threshold)}"/>'


def lum(bright=0, contrast=0):
    """Picture brightness / contrast in % (-100..100; a:blip child)."""
    attrs = _attrs(bright=pct(bright) if bright else None, contrast=pct(contrast) if contrast else None)
    return f"<a:lum{attrs}/>"


def blip_fill(r_id, *, alpha=None, src_rect=None, fill_rect=None, tile=None, rot_with_shape=True, element="a",
              blip_effects=()):
    """A picture fill: stretched (default) or tiled (tile = dict(tx, ty, sx, sy, flip, algn); tx/ty in pt,
    sx/sy in %). alpha: picture transparency as remaining opacity % (a:alphaModFix). src_rect / fill_rect:
    (l, t, r, b) in % (crop / stretch insets). element: 'a' inside spPr, 'p' for a p:pic. blip_effects: recolour
    XML (grayscl(), duotone(), bi_level(), lum()) written inside a:blip before the alphaModFix."""
    if tile is not None and fill_rect is not None:
        raise ValueError("fill_rect applies to stretched picture fills only, not to tiles")
    effects = "".join(blip_effects)
    effects += f'<a:alphaModFix amt="{pct(alpha)}"/>' if alpha is not None else ""
    src = ""
    if src_rect is not None:
        l, t, r, b = (pct(v) for v in src_rect)
        src = f'<a:srcRect l="{l}" t="{t}" r="{r}" b="{b}"/>'
    if tile is not None:
        mode = "<a:tile" + _attrs(
            tx=emu(tile.get("tx", 0)), ty=emu(tile.get("ty", 0)),
            sx=pct(tile.get("sx", 100)), sy=pct(tile.get("sy", 100)),
            flip=tile.get("flip", "none"), algn=tile.get("algn", "tl"),
        ) + "/>"
    else:
        rect = ""
        if fill_rect is not None:
            l, t, r, b = (pct(v) for v in fill_rect)
            rect = f' l="{l}" t="{t}" r="{r}" b="{b}"'
        mode = f"<a:stretch><a:fillRect{rect}/></a:stretch>"
    return (
        f'<{element}:blipFill{_attrs(rotWithShape=bool(rot_with_shape))}>'
        f'<a:blip r:embed="{r_id}">{effects}</a:blip>{src}{mode}</{element}:blipFill>'
    )


# --- lines --------------------------------------------------------------------------------------------------------


def ln(width_pt=None, *, color=None, alpha=None, fill=None, dash=None, cust_dash=None, cap=None, cmpd=None,
       algn=None, join=None, miter_limit=None, head=None, tail=None, tag="a:ln"):
    """An a:ln. color/alpha make a solid line; fill gives any fill XML instead (no_fill() for none).
    dash: a PRST_DASH value; cust_dash: [(dash %, space %), ...] of the line width. head/tail: (type, w, len).
    tag: 'a:ln', or a table-cell border ('a:lnL', 'a:lnR', 'a:lnT', 'a:lnB', 'a:lnTlToBr', 'a:lnBlToTr').
    Arguments that would be ignored raise ValueError: fill with color/alpha, alpha without color, dash with
    cust_dash, miter_limit without join='miter'."""
    if tag not in LINE_TAGS:
        raise ValueError(f"not a line element: {tag!r}")
    if fill is not None and (color is not None or alpha is not None):
        raise ValueError("give either fill= or color=/alpha=, not both")
    if alpha is not None and color is None:
        raise ValueError("alpha needs a color")
    if dash is not None and cust_dash is not None:
        raise ValueError("give either dash= or cust_dash=, not both")
    if miter_limit is not None and join != "miter":
        raise ValueError("miter_limit needs join='miter'")
    if dash is not None and dash not in PRST_DASH:
        raise ValueError(f"unknown preset dash {dash!r}")
    if cap is not None and cap not in LINE_CAPS:
        raise ValueError(f"unknown line cap {cap!r}")
    if cmpd is not None and cmpd not in COMPOUND_LINES:
        raise ValueError(f"unknown compound line {cmpd!r}")
    if join is not None and join not in LINE_JOINS:
        raise ValueError(f"unknown line join {join!r}")
    body = fill if fill is not None else (solid_fill(color, alpha=alpha) if color is not None else "")
    if dash is not None:
        body += f'<a:prstDash val="{dash}"/>'
    elif cust_dash is not None:
        body += "<a:custDash>" + "".join(f'<a:ds d="{pct(d)}" sp="{pct(s)}"/>' for d, s in cust_dash) + "</a:custDash>"
    if join == "miter":
        body += f'<a:miter lim="{pct(miter_limit)}"/>' if miter_limit is not None else "<a:miter/>"
    elif join is not None:
        body += f"<a:{join}/>"
    for end_tag, end in (("headEnd", head), ("tailEnd", tail)):
        if end is not None:
            end_type, w, length = end
            if end_type not in LINE_END_TYPES or w not in LINE_END_SIZES or length not in LINE_END_SIZES:
                raise ValueError(f"bad line end {end!r}")
            body += f'<a:{end_tag} type="{end_type}" w="{w}" len="{length}"/>'
    width = emu(width_pt) if width_pt is not None else None
    return f"<{tag}{_attrs(w=width, cap=cap, cmpd=cmpd, algn=algn)}>{body}</{tag}>"


# --- effects and 3-D ----------------------------------------------------------------------------------------------


def _fixed_angle(degrees):
    """Degrees -> ST_FixedAngle (1/60000 degree, -90..90 for skews)."""
    if not -90 < degrees < 90:
        raise ValueError(f"skew angle must be within -90..90 degrees: {degrees!r}")
    return int(round(degrees * 60000))


def outer_shdw(blur=4, dist=3, direction=45, color_value="000000", alpha=40, sx=100, sy=100, kx=0, ky=0,
               algn="tl", rot_with_shape=False):
    return (
        "<a:outerShdw" + _attrs(blurRad=emu(blur), dist=emu(dist), dir=ang(direction), sx=pct(sx), sy=pct(sy),
                                kx=_fixed_angle(kx), ky=_fixed_angle(ky),
                                algn=algn, rotWithShape=bool(rot_with_shape))
        + f">{color(color_value, alpha=alpha)}</a:outerShdw>"
    )


def inner_shdw(blur=5, dist=3, direction=45, color_value="000000", alpha=50):
    return (
        f'<a:innerShdw blurRad="{emu(blur)}" dist="{emu(dist)}" dir="{ang(direction)}">'
        f"{color(color_value, alpha=alpha)}</a:innerShdw>"
    )


def glow(radius, color_value, alpha=60):
    return f'<a:glow rad="{emu(radius)}">{color(color_value, alpha=alpha)}</a:glow>'


def soft_edge(radius):
    return f'<a:softEdge rad="{emu(radius)}"/>'


def reflection(blur=0.5, start_alpha=50, end_alpha=0.3, end_pos=55, dist=0, direction=90, sy=-100, algn="bl",
               rot_with_shape=False):
    return "<a:reflection" + _attrs(
        blurRad=emu(blur), stA=pct(start_alpha), endA=pct(end_alpha), endPos=pct(end_pos), dist=emu(dist),
        dir=ang(direction), sy=pct(sy), algn=algn, rotWithShape=bool(rot_with_shape),
    ) + "/>"


def effect_lst(*effects):
    """An a:effectLst holding the given effect elements, sorted into schema order."""
    def rank(xml):
        name = xml[3:].split(" ", 1)[0].split(">", 1)[0].split("/", 1)[0]
        if name not in EFFECT_ORDER:
            raise ValueError(f"not an effect-list effect: {xml[:40]!r}")
        return EFFECT_ORDER.index(name)

    return "<a:effectLst>" + "".join(sorted(effects, key=rank)) + "</a:effectLst>"


def scene3d(camera="orthographicFront", rot=None, fov=None, rig="threePt", light_dir="t"):
    """a:scene3d. rot = (lat, lon, rev) in degrees for an explicit camera rotation."""
    rot_xml = f'<a:rot lat="{ang(rot[0])}" lon="{ang(rot[1])}" rev="{ang(rot[2])}"/>' if rot is not None else ""
    fov_attr = f' fov="{ang(fov)}"' if fov is not None else ""
    cam = f'<a:camera prst="{camera}"{fov_attr}>{rot_xml}</a:camera>' if rot_xml else (
        f'<a:camera prst="{camera}"{fov_attr}/>'
    )
    return f'<a:scene3d>{cam}<a:lightRig rig="{rig}" dir="{light_dir}"/></a:scene3d>'


def sp3d(bevel_top=None, bevel_bottom=None, extrusion=None, contour=None, extrusion_color=None,
         contour_color=None, material=None, z=None):
    """a:sp3d. bevel_top / bevel_bottom = (w pt, h pt, preset); extrusion / contour in pt."""
    body = ""
    for tag, bevel in (("bevelT", bevel_top), ("bevelB", bevel_bottom)):
        if bevel is not None:
            w, h, prst = bevel
            if prst not in BEVEL_PRESETS:
                raise ValueError(f"unknown bevel preset {prst!r}")
            body += f'<a:{tag} w="{emu(w)}" h="{emu(h)}" prst="{prst}"/>'
    if extrusion_color is not None:
        body += f"<a:extrusionClr>{color(extrusion_color)}</a:extrusionClr>"
    if contour_color is not None:
        body += f"<a:contourClr>{color(contour_color)}</a:contourClr>"
    attrs = _attrs(
        z=emu(z) if z is not None else None,
        extrusionH=emu(extrusion) if extrusion is not None else None,
        contourW=emu(contour) if contour is not None else None,
        prstMaterial=material,
    )
    return f"<a:sp3d{attrs}>{body}</a:sp3d>" if body else f"<a:sp3d{attrs}/>"


# --- geometry and shape properties --------------------------------------------------------------------------------


def xfrm(x, y, w, h, rot=0, flip_h=False, flip_v=False, child=None):
    """a:xfrm; child = (x, y, w, h) adds chOff/chExt (group shapes)."""
    attrs = _attrs(rot=ang(rot) if rot else None, flipH=True if flip_h else None, flipV=True if flip_v else None)
    ch = ""
    if child is not None:
        cx, cy, cw, chh = child
        ch = f'<a:chOff x="{emu(cx)}" y="{emu(cy)}"/><a:chExt cx="{emu(cw)}" cy="{emu(chh)}"/>'
    return (
        f'<a:xfrm{attrs}><a:off x="{emu(x)}" y="{emu(y)}"/>'
        f'<a:ext cx="{max(0, emu(w))}" cy="{max(0, emu(h))}"/>{ch}</a:xfrm>'
    )


def prst_geom(prst, av=None):
    """a:prstGeom; av = {guide name: value} adjusts the preset (e.g. {'adj': 25000})."""
    if prst not in ST_SHAPE_TYPE:
        raise ValueError(f"not an ST_ShapeType preset: {prst!r}")
    gds = "".join(f'<a:gd name="{name}" fmla="val {int(value)}"/>' for name, value in (av or {}).items())
    return f'<a:prstGeom prst="{prst}"><a:avLst>{gds}</a:avLst></a:prstGeom>' if gds else (
        f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>'
    )


def path_geom(points, w, h, closed=True):
    """a:custGeom of one polyline path; points are (x, y) in pt relative to the shape box (w, h)."""
    if len(points) < 2:
        raise ValueError("a path needs at least two points")
    first, rest = points[0], points[1:]
    body = f'<a:moveTo><a:pt x="{emu(first[0])}" y="{emu(first[1])}"/></a:moveTo>'
    body += "".join(f'<a:lnTo><a:pt x="{emu(x)}" y="{emu(y)}"/></a:lnTo>' for x, y in rest)
    if closed:
        body += "<a:close/>"
    fill_attr = "" if closed else ' fill="none"'
    return (
        '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
        f'<a:pathLst><a:path w="{max(1, emu(w))}" h="{max(1, emu(h))}"{fill_attr}>{body}</a:path></a:pathLst>'
        "</a:custGeom>"
    )


def sp_pr(x, y, w, h, *, prst="rect", av=None, geom=None, fill=None, line=None, effects=None, scene=None,
          shape3d=None, rot=0, flip_h=False, flip_v=False):
    """p:spPr in schema order: xfrm, geometry, fill, ln, effectLst, scene3d, sp3d. geom (custGeom XML) replaces
    the preset."""
    geometry = geom if geom is not None else prst_geom(prst, av)
    return (
        "<p:spPr>" + xfrm(x, y, w, h, rot, flip_h, flip_v) + geometry + (fill or "") + (line or "")
        + (effects or "") + (scene or "") + (shape3d or "") + "</p:spPr>"
    )


# --- text ---------------------------------------------------------------------------------------------------------


def _check(value, allowed, what):
    if value is not None and value not in allowed:
        raise ValueError(f"unknown {what} {value!r}")
    return value


def rpr(typeface, size_pt=None, *, bold=False, italic=False, underline=None, strike=None, baseline=None, spc=None,
        kern=None, cap=None, color=None, fill=None, line=None, effects=None, highlight=None, hlink_rid=None,
        lang="ko-KR", tag="a:rPr"):
    """Run properties naming the typeface for latin, ea and cs, so PowerPoint never falls back to a theme or
    system font for any script. Children in schema order: ln, fill, effectLst, highlight, latin, ea, cs,
    hlinkClick.

    underline: an UNDERLINE_TYPES value; strike: 'sngStrike' | 'dblStrike' | 'noStrike'; baseline: % of the font
    size (positive = superscript, negative = subscript); spc: character spacing in pt (0 is written); kern: the
    smallest size in pt that is kerned; cap: 'small' | 'all'; highlight: a colour; hlink_rid: the r:id of a
    hyperlink relationship of the slide (hyperlink_rid())."""
    if color is not None and fill is not None:
        raise ValueError("give either color= or fill=, not both")
    _check(underline, UNDERLINE_TYPES, "underline")
    _check(strike, STRIKE_TYPES, "strike")
    _check(cap, CAP_TYPES, "caps")
    attrs = _attrs(
        lang=lang, altLang="en-US",
        sz=int(round(size_pt * 100)) if size_pt is not None else None,
        b=True if bold else None, i=True if italic else None, u=underline, strike=strike,
        kern=int(round(kern * 100)) if kern is not None else None, cap=cap,
        spc=int(round(spc * 100)) if spc is not None else None,
        baseline=pct(baseline) if baseline is not None else None, dirty=0,
    )
    body = line or ""
    body += fill if fill is not None else (solid_fill(color) if color is not None else "")
    body += effects or ""
    body += f"<a:highlight>{color_xml(highlight)}</a:highlight>" if highlight is not None else ""
    face = quoteattr(typeface)
    body += f"<a:latin typeface={face}/><a:ea typeface={face}/><a:cs typeface={face}/>"
    body += f'<a:hlinkClick r:id="{hlink_rid}"/>' if hlink_rid is not None else ""
    return f"<{tag}{attrs}>{body}</{tag}>"



def _spacing(tag, value):
    """a:lnSpc / a:spcBef / a:spcAft from ('pct', %) or ('pts', pt)."""
    kind, amount = value
    if kind == "pct":
        return f'<a:{tag}><a:spcPct val="{pct(amount)}"/></a:{tag}>'
    if kind == "pts":
        return f'<a:{tag}><a:spcPts val="{int(round(amount * 100))}"/></a:{tag}>'
    raise ValueError(f"spacing must be ('pct', %) or ('pts', pt): {value!r}")


def p_pr(*, align=None, lvl=None, mar_l=None, indent=None, ln_spc=None, spc_bef=None, spc_aft=None, bullet=None,
         bu_font=None, bu_color=None, bu_size=None, tabs=None, ea_ln_brk=None, latin_ln_brk=None, font_algn=None):
    """a:pPr. Children in schema order: lnSpc, spcBef, spcAft, buClr, buSzPct, buFont, bullet, tabLst.

    lvl: outline level 0..8; mar_l / indent in pt; ln_spc / spc_bef / spc_aft: ('pct', %) or ('pts', pt);
    bullet: 'none' | ('char', '•') | ('autonum', scheme[, start]); bu_font: the bullet's typeface (name it: the
    template's bullet font is not ours); bu_color: a colour; bu_size: % of the text size; tabs: [(pos pt, algn)]."""
    _check(align, TEXT_ALIGN, "paragraph alignment")
    if lvl is not None and lvl not in range(9):
        raise ValueError(f"lvl must be 0..8: {lvl!r}")
    attrs = _attrs(
        marL=emu(mar_l) if mar_l is not None else None, lvl=lvl,
        indent=emu(indent) if indent is not None else None, algn=align, fontAlgn=font_algn,
        eaLnBrk=ea_ln_brk, latinLnBrk=latin_ln_brk,
    )
    body = ""
    for tag, value in (("lnSpc", ln_spc), ("spcBef", spc_bef), ("spcAft", spc_aft)):
        if value is not None:
            body += _spacing(tag, value)
    if bu_color is not None:
        body += f"<a:buClr>{color_xml(bu_color)}</a:buClr>"
    if bu_size is not None:
        body += f'<a:buSzPct val="{pct(bu_size)}"/>'
    if bu_font is not None:
        body += f"<a:buFont typeface={quoteattr(bu_font)}/>"
    if bullet == "none":
        body += "<a:buNone/>"
    elif isinstance(bullet, tuple) and bullet[0] == "char":
        body += f"<a:buChar char={quoteattr(bullet[1])}/>"
    elif isinstance(bullet, tuple) and bullet[0] == "autonum":
        _check(bullet[1], AUTONUM_SCHEMES, "auto-number scheme")
        start = bullet[2] if len(bullet) > 2 else None
        body += f'<a:buAutoNum type="{bullet[1]}"{_attrs(startAt=start)}/>'
    elif bullet is not None:
        raise ValueError(f"bullet must be 'none', ('char', c) or ('autonum', scheme[, start]): {bullet!r}")
    if tabs:
        stops = "".join(f'<a:tab pos="{emu(pos)}" algn="{_check(algn, TAB_ALIGN, "tab")}"/>' for pos, algn in tabs)
        body += f"<a:tabLst>{stops}</a:tabLst>"
    return f"<a:pPr{attrs}>{body}</a:pPr>" if body else f"<a:pPr{attrs}/>"


def field(fld_type, guid, text, props):
    """a:fld (e.g. 'slidenum'); text is the cached value PowerPoint shows until it recalculates the field."""
    return f'<a:fld id="{guid}" type="{fld_type}">{props}<a:t>{escape(text)}</a:t></a:fld>'


def paragraph(runs, *, align=None, end_rpr=None, ppr=None):
    """a:p from [(text, rPr XML), ...]; the text '\\n' writes a line break (a:br) and a plain string item is
    inserted as XML (a field()). align: a TEXT_ALIGN value, or ppr: a full p_pr() instead."""
    if align is not None and ppr is not None:
        raise ValueError("give either align= or ppr=, not both")
    ppr_xml = ppr if ppr is not None else (f'<a:pPr algn="{_check(align, TEXT_ALIGN, "alignment")}"/>' if align
                                           else "")
    body = []
    for item in runs:
        if isinstance(item, str):
            body.append(item)
            continue
        text, props = item
        body.append(f"<a:br>{props}</a:br>" if text == "\n" else f"<a:r>{props}<a:t>{escape(text)}</a:t></a:r>")
    return f"<a:p>{ppr_xml}{''.join(body)}{end_rpr or ''}</a:p>"


def body_pr(*, wrap=True, anchor="t", insets=(7.2, 3.6, 7.2, 3.6), autofit=None, scene=None, shape3d=None,
            vert=None, rot=None, num_col=None, spc_col=None, font_scale=None, ln_spc_reduction=None, warp=None,
            warp_av=None, anchor_ctr=None):
    """a:bodyPr. Children in schema order: prstTxWarp, autofit, scene3d, sp3d.

    autofit: None | 'sp' (spAutoFit) | 'norm' (normAutofit, with font_scale / ln_spc_reduction in %) | 'none'.
    scene/shape3d: text 3-D (bevel, 3-D rotation). vert: a TEXT_VERT value; rot: text rotation in degrees;
    num_col / spc_col (pt): text columns; warp: a PRST_TX_WARP preset (WordArt transform), warp_av its guides."""
    _check(vert, TEXT_VERT, "vertical text type")
    _check(anchor, TEXT_ANCHOR, "text anchor")
    _check(warp, PRST_TX_WARP, "text warp")
    if autofit not in (None, "sp", "norm", "none"):
        raise ValueError(f"autofit must be None, 'sp', 'norm' or 'none': {autofit!r}")
    if autofit != "norm" and (font_scale is not None or ln_spc_reduction is not None):
        raise ValueError("font_scale / ln_spc_reduction need autofit='norm'")
    l, t, r, b = (emu(v) for v in insets)
    attrs = _attrs(rot=ang(rot) if rot else None, vert=vert, wrap="square" if wrap else "none",
                   lIns=l, tIns=t, rIns=r, bIns=b, numCol=num_col,
                   spcCol=emu(spc_col) if spc_col is not None else None, anchor=anchor, anchorCtr=anchor_ctr,
                   rtlCol=0)
    tx_warp = ""
    if warp is not None:
        gds = "".join(f'<a:gd name="{name}" fmla="val {int(value)}"/>' for name, value in (warp_av or {}).items())
        tx_warp = f'<a:prstTxWarp prst="{warp}"><a:avLst>{gds}</a:avLst></a:prstTxWarp>' if gds else (
            f'<a:prstTxWarp prst="{warp}"><a:avLst/></a:prstTxWarp>')
    fit = ""
    if autofit == "sp":
        fit = "<a:spAutoFit/>"
    elif autofit == "none":
        fit = "<a:noAutofit/>"
    elif autofit == "norm":
        fit = "<a:normAutofit" + _attrs(
            fontScale=pct(font_scale) if font_scale is not None else None,
            lnSpcReduction=pct(ln_spc_reduction) if ln_spc_reduction is not None else None) + "/>"
    return f"<a:bodyPr{attrs}>{tx_warp}{fit}{scene or ''}{shape3d or ''}</a:bodyPr>"


def tx_body(paragraphs, *, body=None):
    return f"<p:txBody>{body or body_pr()}<a:lstStyle/>{''.join(paragraphs)}</p:txBody>"


def apply_fonts(element, typeface):
    """Name `typeface` for latin, ea and cs in every a:rPr, a:defRPr and a:endParaRPr under (and including)
    `element`, replacing any font already named, in schema order (before sym/hlinkClick/rtl/extLst). For text that
    python-pptx writes itself (chart titles, axes, legends, data labels), which otherwise has no fonts and falls back
    to the theme or the system. Runs, fields and line breaks without run properties get an empty a:rPr first."""
    for run in [e for e in element.iter() if e.tag in {qn("a:r"), qn("a:fld"), qn("a:br")}]:
        if run.find(qn("a:rPr")) is None:
            run.insert(0, run.makeelement(qn("a:rPr"), {"lang": "ko-KR", "altLang": "en-US"}))
    names = {qn(f"a:{tag}") for tag in ("rPr", "defRPr", "endParaRPr")}
    after = {qn(f"a:{tag}") for tag in _AFTER_FONTS}
    for props in [e for e in element.iter() if e.tag in names]:
        for old in [c for c in props if c.tag in {qn("a:latin"), qn("a:ea"), qn("a:cs")}]:
            props.remove(old)
        position = next((i for i, child in enumerate(props) if child.tag in after), len(props))
        for offset, tag in enumerate(("latin", "ea", "cs")):
            face = props.makeelement(qn(f"a:{tag}"), {"typeface": typeface})
            props.insert(position + offset, face)
    return element


# --- tables -------------------------------------------------------------------------------------------------------


def tc_pr(*, borders=None, fill=None, anchor=None, vert=None, margins=None, anchor_ctr=None):
    """a:tcPr. borders: {side: ln() keyword arguments} for the sides TABLE_BORDERS (L, R, T, B, TlToBr, BlToTr);
    fill: fill XML; margins: (l, t, r, b) in pt. Children in schema order: lnL, lnR, lnT, lnB, lnTlToBr, lnBlToTr,
    fill."""
    borders = dict(borders or {})
    unknown = set(borders) - set(TABLE_BORDERS)
    if unknown:
        raise ValueError(f"unknown table border sides {sorted(unknown)}; use {TABLE_BORDERS}")
    _check(anchor, ("t", "ctr", "b"), "cell anchor")
    _check(vert, TEXT_VERT, "vertical text type")
    lines = "".join(ln(**{**borders[side], "tag": f"a:ln{side}"}) for side in TABLE_BORDERS if side in borders)
    l, t, r, b = (emu(v) for v in margins) if margins is not None else (None,) * 4
    attrs = _attrs(marL=l, marR=r, marT=t, marB=b, vert=vert, anchor=anchor, anchorCtr=anchor_ctr)
    body = lines + (fill or "")
    return f"<a:tcPr{attrs}>{body}</a:tcPr>" if body else f"<a:tcPr{attrs}/>"


# --- backgrounds --------------------------------------------------------------------------------------------------


def background(fill=None, *, ref=None):
    """p:bg: a fill (p:bgPr with the required empty effect list) or ref = (theme bgFillStyleLst index 1001..,
    colour) for p:bgRef."""
    if (fill is None) == (ref is None):
        raise ValueError("give exactly one of fill or ref")
    if ref is not None:
        idx, value = ref
        return f'<p:bg><p:bgRef idx="{int(idx)}">{color(value)}</p:bgRef></p:bg>'
    return f"<p:bg><p:bgPr>{fill}<a:effectLst/></p:bgPr></p:bg>"


def set_background(owner, bg_xml):
    """Give a slide, layout or master element (p:sld / p:sldLayout / p:sldMaster) its own background, replacing
    any it has: p:bg is the first child of p:cSld."""
    c_sld = owner.find(qn("p:cSld"))
    for old in c_sld.findall(qn("p:bg")):
        c_sld.remove(old)
    c_sld.insert(0, parse_xml(bg_xml.replace("<p:bg>", f'<p:bg {nsdecls("p", "a", "r")}>', 1)))


# --- adding elements to a slide or group --------------------------------------------------------------------------


def next_shape_id(shapes):
    """The smallest unused shape id, counting only the p:cNvPr ids of the part.

    python-pptx's own `_next_shape_id` counts every `id` attribute of the part. A slide master carries p:sldLayoutId
    ids from 2147483649 up, so a shape added to a master got id 2147483660. PowerPoint keeps shape ids in 32-bit
    signed integers and refuses to open such a deck (E_FAIL on Presentations.Open)."""
    used = {int(i) for i in shapes._spTree.xpath("//p:cNvPr/@id") if i.isdigit()}
    return next(n for n in range(1, len(used) + 2) if n not in used)


def _insert(shapes, element):
    shapes._spTree.insert_element_before(element, "p:extLst")
    shape = shapes._shape_factory(element)
    recalculate = getattr(shapes, "_recalculate_extents", None)  # slide / group shapes; not layouts and masters
    if recalculate is not None:
        recalculate()  # a group keeps its frame around its children (a no-op on a slide)
    return shape


TXBOX = ' txBox="1"'


def add_sp(shapes, sp_pr_xml, *, name, txbody=None, textbox=False):
    """Add a p:sp to `shapes` (slide.shapes or group.shapes) and return the python-pptx shape."""
    shape_id = next_shape_id(shapes)
    nv = (
        f"<p:nvSpPr><p:cNvPr id=\"{shape_id}\" name={quoteattr(name)}/>"
        f"<p:cNvSpPr{TXBOX if textbox else ''}/><p:nvPr/></p:nvSpPr>"
    )
    element = parse_xml(f'<p:sp {nsdecls("p", "a", "r")}>{nv}{sp_pr_xml}{txbody or ""}</p:sp>')
    return _insert(shapes, element)


PLACEHOLDER_SIZES = {"dt": "half", "ftr": "quarter", "sldNum": "quarter"}


def add_placeholder(shapes, ph_type, idx, x, y, w, h, paragraphs, *, name, body=None):
    """Add a slide placeholder p:sp (e.g. 'dt', 'ftr', 'sldNum') that inherits its geometry and text style from the
    layout placeholder with the same idx, placed at (x, y, w, h)."""
    shape_id = next_shape_id(shapes)
    size = PLACEHOLDER_SIZES.get(ph_type)
    nv = (
        f'<p:nvSpPr><p:cNvPr id="{shape_id}" name={quoteattr(name)}/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        f'<p:nvPr><p:ph type="{ph_type}"{_attrs(sz=size)} idx="{int(idx)}"/></p:nvPr></p:nvSpPr>'
    )
    sppr = f"<p:spPr>{xfrm(x, y, w, h)}</p:spPr>"
    txbody = f"<p:txBody>{body or '<a:bodyPr/>'}<a:lstStyle/>{''.join(paragraphs)}</p:txBody>"
    element = parse_xml(f'<p:sp {nsdecls("p", "a", "r")}>{nv}{sppr}{txbody}</p:sp>')
    return _insert(shapes, element)


def add_pic(shapes, r_id, x, y, w, h, *, name, blip_effects=(), alpha=None, src_rect=None, prst="rect", av=None,
            line=None, effects=None, rot=0, flip_h=False, flip_v=False):
    """Add a p:pic showing the image related as `r_id` (image_rid()) and return the python-pptx picture.
    blip_effects: recolour XML (grayscl(), duotone(), ...); alpha: opacity %; src_rect: crop (l, t, r, b) in %;
    prst/av: the picture's geometry; line/effects: border and effect list, as for shapes."""
    shape_id = next_shape_id(shapes)
    nv = (
        f'<p:nvPicPr><p:cNvPr id="{shape_id}" name={quoteattr(name)}/>'
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    )
    fill = blip_fill(r_id, alpha=alpha, src_rect=src_rect, blip_effects=blip_effects, element="p")
    sppr = sp_pr(x, y, w, h, prst=prst, av=av, line=line, effects=effects, rot=rot, flip_h=flip_h, flip_v=flip_v)
    element = parse_xml(f'<p:pic {nsdecls("p", "a", "r")}>{nv}{fill}{sppr}</p:pic>')
    return _insert(shapes, element)


# Presets whose connection sites 0..3 are (hc, t), (l, vc), (hc, b), (r, vc) -- top, left, bottom, right -- as
# checked in ECMA-376 presetShapeDefinitions.xml. Other presets number their sites differently (ellipse has 8, the
# first two being top and top-left), so gluing to them would store a site index that does not match the geometry.
RECT_SITE_PRESETS = ("rect", "roundRect")


def connection_site(shape, idx):
    """(x, y) in pt of connection site idx 0..3 (top, left, bottom, right) of an unrotated, unflipped rect or
    roundRect; anything else raises ValueError."""
    prst = shape._element.xpath("./p:spPr/a:prstGeom/@prst")
    if not prst or prst[0] not in RECT_SITE_PRESETS:
        found = prst[0] if prst else "no preset geometry"
        raise ValueError(f"connection sites are known only for {RECT_SITE_PRESETS}, not {found}")
    if shape._element.xpath("./p:spPr/a:xfrm[@rot or @flipH or @flipV]"):
        raise ValueError("connection sites of rotated or flipped shapes are not computed")
    if idx not in (0, 1, 2, 3):
        raise ValueError(f"connection site index must be 0..3: {idx!r}")
    x, y = shape.left / EMU_PER_PT, shape.top / EMU_PER_PT
    w, h = shape.width / EMU_PER_PT, shape.height / EMU_PER_PT
    sites = {0: (x + w / 2, y), 1: (x, y + h / 2), 2: (x + w / 2, y + h), 3: (x + w, y + h / 2)}
    return sites[idx]


def add_cxn(shapes, prst, begin=None, finish=None, *, start=None, end=None, line, name=None, av=None):
    """Add a p:cxnSp connector from `begin` to `finish` ((x, y) in pt), or glued to shapes with start / end =
    (shape, connection site idx 0..3 of a rect or roundRect). Flips are set from the direction of travel."""
    if (begin is None) == (start is None) or (finish is None) == (end is None):
        raise ValueError("give each end either as a point (begin/finish) or glued to a shape (start/end)")
    if start is not None:
        begin = connection_site(*start)
    if end is not None:
        finish = connection_site(*end)
    (x1, y1), (x2, y2) = begin, finish
    flip_h, flip_v = x2 < x1, y2 < y1
    shape_id = next_shape_id(shapes)
    glue = ""
    if start is not None:
        glue += f'<a:stCxn id="{start[0].shape_id}" idx="{start[1]}"/>'
    if end is not None:
        glue += f'<a:endCxn id="{end[0].shape_id}" idx="{end[1]}"/>'
    sppr = sp_pr(min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1), prst=prst, av=av, line=line,
                 flip_h=flip_h, flip_v=flip_v)
    element = parse_xml(
        f'<p:cxnSp {nsdecls("p", "a", "r")}><p:nvCxnSpPr>'
        f'<p:cNvPr id="{shape_id}" name={quoteattr(name or f"Connector {shape_id}")}/>'
        f"<p:cNvCxnSpPr>{glue}</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>{sppr}</p:cxnSp>"
    )
    return _insert(shapes, element)


def set_group_transform(group, rot=0, flip_h=False, flip_v=False, scale=None):
    """Rotate / flip / scale a python-pptx group after its children are added. scale = (sx, sy) keeps chOff/chExt
    and shrinks or grows the group's own extent, which scales every child."""
    xf = group._element.grpSpPr.get_or_add_xfrm()
    if rot:
        xf.set("rot", str(ang(rot)))
    if flip_h:
        xf.set("flipH", "1")
    if flip_v:
        xf.set("flipV", "1")
    if scale is not None:
        ext = xf.ext
        ext.set("cx", str(int(round(int(ext.get("cx")) * scale[0]))))
        ext.set("cy", str(int(round(int(ext.get("cy")) * scale[1]))))


def image_rid(slide, image_bytes):
    """Add (or reuse) an image part on the slide (or layout / master) and return its relationship id."""
    import io

    _part, r_id = slide.part.get_or_add_image_part(io.BytesIO(image_bytes))
    return r_id


def hyperlink_rid(slide, url):
    """Relate an external hyperlink to the slide and return its relationship id (for rpr(hlink_rid=...))."""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT

    return slide.part.relate_to(url, RT.HYPERLINK, is_external=True)
