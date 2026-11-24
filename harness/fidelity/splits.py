"""Rulings M3-R49 and M3-R56 seen from the PDF: which path paints the writer splits into pieces, and the pieces' boxes.

    split_args(paints) -> [dict | None, ...]           # what pieces() needs of each paint, None for one never split
    pieces(path, filled, stroked, width=None, dashed=False, opaque=True, scale=1.0) -> [bbox, ...] | None
    split_paints(paints, scale=1.0) -> [{**paint, "pieces": [bbox, ...] | None}, ...]

The writer (packages/core/src/passes/lower/shape.ts, ``splitPieces``) writes a chart's gridlines and bars, which the
PDF draws as one path, as objects of their own:

* a stroke-only path whose every subpath is one straight segment (``M L``, of some length) is one connector per
  subpath; a translucent one (its alpha times its group alphas below 1) only when no two segments' boxes, each grown by
  half the width, overlap (M3-R56: the PDF composites a stroke's union once);
* a filled path whose every subpath is a closed axis-aligned rectangle (a stroke needs its ``Z``, and a dashed one
  must start at the bottom left corner going up, as the rect preset's dashes do: measured, M5 Task 4) is one rect per
  subpath, when no two of them overlap or nest, nor, with a stroke, come within its width of each other (each stroke
  reaching half of it past its rectangle).

A hairline (width 0) is one pixel wide on the slide, 0.75 pt, which is ``0.75 / scale`` pt of a page drawn at
``scale`` on its slide. Subpaths that draw nothing (a lone ``M``) are left out, and at least two must be left; a
zero-length subpath splits nothing. Only solid paints are split: the oracle lists a solid fill or stroke as ``fill`` or
``stroke``, a gradient or pattern one as a ``shade`` or ``pattern`` paint under a clip of the path (``clipPath``,
``clipStroke`` for a stroke: mupdf_inventory ``paths=True``). A path filled or stroked so is never split, as the
writer splits no shape whose fill or Scene line is not solid. So one PDF paint is several slide paints, one per piece,
each with the piece's box: S3 (structural.py) and S7 (roundtrip.py) count the PDF's side the same way, and S7 its
round trip's side too (ruling M3-R58), so that a PDF compared with itself has no difference.

A fill and a stroke of the same path one after the other (``B``, or ``f`` and ``S`` of one path) are one shape in the
writer (its merge pass), so ``split_args`` decides them together; a gradient or pattern fill under a path clip then a
stroke of that path likewise (M3-R29). A paint of alpha 0 paints nothing (M3-R45, M3-R47): the writer writes no fill for
it, so a stroke after a fill of alpha 0 is a stroke-only path.
"""

HAIRLINE_PT = 0.75  # the width a line of width 0 is drawn with on the slide: one pixel at 96 dpi
EPS = 1e-9

CW = {"E": "S", "S": "W", "W": "N", "N": "E"}
CCW = {"E": "N", "N": "W", "W": "S", "S": "E"}


def subpaths(path):
    """The path's subpaths: each starts at an ``M`` (segments before the first ``M`` start one too)."""
    out = []
    for seg in path or ():
        if seg[0] == "M" or not out:
            out.append([])
        out[-1].append(seg)
    return out


def _points(sub):
    points = []
    for seg in sub:
        for i in range(1, len(seg), 2):
            points.append((seg[i], seg[i + 1]))
    return points


def _draws(sub):
    return any(seg[0] in ("L", "C") for seg in sub)


def _zero_length(sub):
    if len(sub) < 2:
        return False
    points = _points(sub)
    return all(p == points[0] for p in points)


def _one_segment(sub):
    return (len(sub) == 2 and sub[0][0] == "M" and sub[1][0] == "L"
            and (sub[0][1] != sub[1][1] or sub[0][2] != sub[1][2]))


def _direction(a, b):
    if a[1] == b[1] and a[0] != b[0]:
        return "E" if b[0] > a[0] else "W"
    if a[0] == b[0] and a[1] != b[1]:
        return "S" if b[1] > a[1] else "N"
    return None


def is_rect(sub, stroked=False, dashed=False):
    """classify.ts ``isRect`` of one subpath: straight sides, closed (a stroke needs its ``Z``), four sides once
    repeated points are dropped and sides of one direction joined, each turning the same way by 90 degrees; a dashed
    stroke must start at the bottom left corner going up (M5 Task 4)."""
    if any(seg[0] == "C" for seg in sub):
        return False
    if stroked and sub[-1][0] != "Z":
        return False
    points = []
    for seg in sub:
        if seg[0] == "Z":
            continue
        point = (seg[1], seg[2])
        if not points or points[-1] != point:
            points.append(point)
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if len(points) < 4:
        return False
    dirs = []
    for i, a in enumerate(points):
        d = _direction(a, points[(i + 1) % len(points)])
        if d is None:
            return False
        if not dirs or dirs[-1] != d:
            dirs.append(d)
    if len(dirs) > 1 and dirs[0] == dirs[-1]:
        dirs.pop()
    if len(dirs) != 4:
        return False
    turn = CW if CW[dirs[0]] == dirs[1] else CCW
    if not all(turn[d] == dirs[(i + 1) % 4] for i, d in enumerate(dirs)):
        return False
    if stroked and dashed:
        x, y = points[0]
        if x != min(p[0] for p in points) or y != max(p[1] for p in points) or dirs[0] != "N" or turn is not CW:
            return False
    return True


def _box(sub, by=0.0):
    points = _points(sub)
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [min(xs) - by, min(ys) - by, max(xs) + by, max(ys) + by]


def _overlap(a, b):
    return min(a[2], b[2]) > max(a[0], b[0]) + EPS and min(a[3], b[3]) > max(a[1], b[1]) + EPS


def _apart(subs, reach):
    grown = [_box(sub, reach) for sub in subs]
    for i in range(len(grown)):
        for j in range(i + 1, len(grown)):
            if _overlap(grown[i], grown[j]):
                return False
    return True


def pieces(path, filled, stroked, width=None, dashed=False, opaque=True, scale=1.0):
    """The boxes of the pieces the writer makes of a path (M3-R49, M3-R56), in path order; None when it is one shape.
    ``opaque``: the stroke's alpha times its group alphas is 1; ``scale``: the page's on its slide (a hairline's
    width)."""
    subs = subpaths(path)
    if any(_zero_length(sub) for sub in subs):
        return None
    live = [sub for sub in subs if _draws(sub)]
    if len(live) < 2:
        return None
    reach = max(width or 0.0, HAIRLINE_PT / scale) / 2 if stroked else 0.0
    if not filled:
        if not stroked or not all(_one_segment(sub) for sub in live):
            return None
        if not opaque and not _apart(live, reach):
            return None
        return [_box(sub) for sub in live]
    if not all(is_rect(sub, stroked, dashed) for sub in live):
        return None
    if not _apart(live, reach):
        return None
    return [_box(sub) for sub in live]


def _paints_nothing(paint):
    return (paint.get("alpha") or 0.0) <= 1e-6


def _opaque(paint):
    return (paint.get("alpha") or 0.0) * paint.get("groupAlpha", 1.0) >= 1 - 1e-6


def _clip_of(paint, path, stroke):
    """Whether `paint` is a gradient or pattern painted through a clip of `path` (a stroke's clip when `stroke`)."""
    return (paint is not None and paint.get("kind") in ("shade", "pattern") and paint.get("clipPath") == path
            and bool(paint.get("clipStroke")) == stroke)


def split_args(paints):
    """For each oracle paint (mupdf_inventory ``paths=True``), the arguments of ``pieces`` but ``scale``, or None for a
    paint that is never split: not a visible ``fill`` or ``stroke``, no path, or a path also filled or stroked with a
    gradient or pattern. A fill and a stroke of the same path one after the other are decided together."""
    out = []
    for i, paint in enumerate(paints):
        kind = paint.get("kind")
        path = paint.get("path")
        before = paints[i - 1] if i > 0 else None
        after = paints[i + 1] if i + 1 < len(paints) else None
        if kind not in ("fill", "stroke") or _paints_nothing(paint) or path is None:
            out.append(None)
        elif kind == "fill":
            if _clip_of(after, path, True):  # a gradient or pattern stroke of the same path
                out.append(None)
                continue
            stroke = after if (after is not None and after.get("kind") == "stroke" and not _paints_nothing(after)
                               and after.get("path") == path) else None
            line = (stroke or {}).get("line") or {}
            out.append({"path": path, "filled": True, "stroked": stroke is not None, "width": line.get("w"),
                        "dashed": bool(line.get("dash")), "opaque": stroke is None or _opaque(stroke)})
        else:
            if _clip_of(before, path, False):  # filled with a gradient or pattern through a clip of the same path
                out.append(None)
                continue
            filled = (before is not None and before.get("kind") == "fill" and not _paints_nothing(before)
                      and before.get("path") == path)
            line = paint.get("line") or {}
            out.append({"path": path, "filled": filled, "stroked": True, "width": line.get("w"),
                        "dashed": bool(line.get("dash")), "opaque": _opaque(paint)})
    return out


def split_paints(paints, scale=1.0):
    """Each oracle paint with its ``pieces``: the boxes of the pieces the writer splits it into at the page's
    ``scale``, None for a paint it keeps whole (``split_args``)."""
    return [{**paint, "pieces": None if args is None else pieces(**args, scale=scale)}
            for paint, args in zip(paints, split_args(paints))]
