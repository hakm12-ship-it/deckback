"""Shared helpers that write DrawingML custom geometry (custGeom) and gradient fills (gradFill)
into a python-pptx slide. Used by the M0 engine spikes and the PowerPoint render harness.

All coordinates are in points (1 pt = 12700 EMU), slide frame, origin top-left, y down.
"""

import re

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

EMU_PER_PT = 12700

_FILL_TAGS = ("a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill")
_HEX = re.compile(r"^[0-9A-Fa-f]{6}$")


def _emu(points):
    return int(round(points * EMU_PER_PT))


def _hex(rgb):
    """'1F4E79', '#1f4e79' or (31, 78, 121) -> '1F4E79'."""
    if isinstance(rgb, str):
        text = rgb.lstrip("#")
        if not _HEX.match(text):
            raise ValueError(f"not a 6-digit hex colour: {rgb!r}")
        return text.upper()
    r, g, b = rgb
    if not all(isinstance(c, int) and 0 <= c <= 255 for c in (r, g, b)):
        raise ValueError(f"RGB components must be integers 0-255: {rgb!r}")
    return "%02X%02X%02X" % (r, g, b)


def _segment_xml(segment, to_pt):
    """(x, y) -> lnTo; (x1, y1, x2, y2, x3, y3) -> cubicBezTo."""
    if len(segment) == 2:
        return f"<a:lnTo>{to_pt(*segment)}</a:lnTo>"
    if len(segment) == 6:
        pts = "".join(to_pt(segment[i], segment[i + 1]) for i in (0, 2, 4))
        return f"<a:cubicBezTo>{pts}</a:cubicBezTo>"
    raise ValueError(f"a segment is (x, y) or (x1, y1, x2, y2, x3, y3): {segment!r}")


def add_custgeom(slide, subpaths, fill_rgb, line=None, separate_paths=False):
    """Add one freeform shape made of closed subpaths and return it.

    subpaths: list of subpaths. A subpath is a list of tuples: the first is the start point
        (x, y) (moveTo); each following tuple is either (x, y) (lnTo) or
        (x1, y1, x2, y2, x3, y3) (cubicBezTo). Every subpath is closed.
    fill_rgb: '1F4E79' / '#1F4E79' / (31, 78, 121), or None for no fill.
    line: None for no outline, or (rgb, width_pt).
    separate_paths: False puts all subpaths into a single a:path (so overlap/nesting is decided by
        the renderer's fill rule); True gives every subpath its own a:path.
    """
    if not subpaths:
        raise ValueError("subpaths must not be empty")
    coords = []
    for sub in subpaths:
        if not sub or len(sub[0]) != 2:
            raise ValueError(f"a subpath must start with an (x, y) point: {sub!r}")
        for seg in sub:
            coords.extend(zip(seg[0::2], seg[1::2]))
    x0 = min(x for x, _ in coords)
    y0 = min(y for _, y in coords)
    width = max(x for x, _ in coords) - x0
    height = max(y for _, y in coords) - y0
    w_emu, h_emu = max(1, _emu(width)), max(1, _emu(height))

    def to_pt(x, y):
        return f'<a:pt x="{_emu(x - x0)}" y="{_emu(y - y0)}"/>'

    def subpath_xml(sub):
        return (
            f"<a:moveTo>{to_pt(*sub[0])}</a:moveTo>"
            + "".join(_segment_xml(seg, to_pt) for seg in sub[1:])
            + "<a:close/>"
        )

    path_open = f'<a:path w="{w_emu}" h="{h_emu}">'
    if separate_paths:
        path_xml = "".join(f"{path_open}{subpath_xml(s)}</a:path>" for s in subpaths)
    else:
        path_xml = f"{path_open}{''.join(subpath_xml(s) for s in subpaths)}</a:path>"

    fill_xml = "<a:noFill/>" if fill_rgb is None else (
        f'<a:solidFill><a:srgbClr val="{_hex(fill_rgb)}"/></a:solidFill>'
    )
    if line is None:
        line_xml = "<a:ln><a:noFill/></a:ln>"
    else:
        line_rgb, line_pt = line
        line_xml = (
            f'<a:ln w="{_emu(line_pt)}"><a:solidFill><a:srgbClr val="{_hex(line_rgb)}"/>'
            "</a:solidFill></a:ln>"
        )

    shape_id = slide.shapes._next_shape_id
    sp = parse_xml(
        f'<p:sp {nsdecls("p", "a")}>'
        f'<p:nvSpPr><p:cNvPr id="{shape_id}" name="Freeform {shape_id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(x0)}" y="{_emu(y0)}"/><a:ext cx="{w_emu}" cy="{h_emu}"/></a:xfrm>'
        '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
        f"<a:pathLst>{path_xml}</a:pathLst></a:custGeom>{fill_xml}{line_xml}</p:spPr></p:sp>"
    )
    slide.shapes._spTree.insert_element_before(sp, "p:extLst")
    return slide.shapes[-1]


def add_gradfill(shape, stops, angle_deg, scaled=False):
    """Replace the shape's fill with a linear gradient.

    stops: [(position 0..1, '1F4E79'), ...], at least two. Written as a:gs pos in 1/1000 %.
    angle_deg: direction of the gradient line, clockwise from the +x axis; written as a:lin ang
        in 1/60000 degree (normalised to 0..360).
    scaled: a:lin scaled attribute.
    """
    if len(stops) < 2:
        raise ValueError("a gradient needs at least two stops")
    gs = []
    for position, rgb in stops:
        if not 0 <= position <= 1:
            raise ValueError(f"stop position must be within 0..1: {position!r}")
        gs.append(f'<a:gs pos="{int(round(position * 100000))}"><a:srgbClr val="{_hex(rgb)}"/></a:gs>')
    grad = parse_xml(
        f'<a:gradFill {nsdecls("a")} rotWithShape="1"><a:gsLst>{"".join(gs)}</a:gsLst>'
        f'<a:lin ang="{int(round((angle_deg % 360) * 60000))}" scaled="{1 if scaled else 0}"/></a:gradFill>'
    )
    sp_pr = shape._element.spPr
    for tag in _FILL_TAGS:
        for old in sp_pr.findall(qn(tag)):
            sp_pr.remove(old)
    for tag in ("a:custGeom", "a:prstGeom", "a:xfrm"):
        anchor = sp_pr.find(qn(tag))
        if anchor is not None:
            anchor.addnext(grad)
            return
    sp_pr.insert(0, grad)
