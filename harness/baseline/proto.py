"""Baseline converter: the M0 probe prototype, ported unchanged and kept only as the M1 baseline subject.

Vector PDF (PowerPoint-exported) -> pptx with native, individually editable shapes.

    python -m harness.baseline.proto in.pdf -o out.pptx

- each vector path -> own custGeom freeform (moveTo/lnTo/cubicBezTo/close), fill/stroke/width/alpha/dash
- axis-aligned 're' paths -> native rectangles (multi-rect paths are split, e.g. chart bars)
- single straight stroked segments -> native straight connectors (lines)
- axial shading patterns (gradients) -> rectangle with DrawingML gradFill sampled from the PDF function
- text lines -> text boxes (runs keep font/size/color/bold/italic), no autofit, no wrap, zero insets
- images -> pictures at their bbox
- z-order follows PDF paint order (seqno / bboxlog index)

Built on PyMuPDF (AGPL): harness-only, never published. See harness/baseline/README.md.
"""
import argparse, io, json, re, math, sys, time
from pathlib import Path
import pymupdf as fitz
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn
from lxml import etree

EMU = 12700  # per pt
TEXT_DY = 0.10
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

FONT_MAP = {'MalgunGothic': '맑은 고딕', 'ArialMT': 'Arial', 'Arial': 'Arial', 'Calibri': 'Calibri',
            'CalibriLight': 'Calibri Light', 'TimesNewRomanPSMT': 'Times New Roman', 'NanumGothic': '나눔고딕',
            'SegoeUI': 'Segoe UI', 'Pretendard': 'Pretendard'}

def e(v):
    return int(round(v * EMU))

def rgb_hex(c):
    if c is None:
        return None
    if len(c) == 1:
        c = (c[0],) * 3
    elif len(c) == 4:  # cmyk
        k = c[3]; c = tuple((1 - x) * (1 - k) for x in c[:3])
    return '%02X%02X%02X' % tuple(max(0, min(255, int(round(x * 255)))) for x in c)

def clr_xml(hexc, alpha=None):
    a = '' if alpha is None or alpha >= 0.999 else f'<a:alpha val="{int(round(alpha * 100000))}"/>'
    return f'<a:srgbClr val="{hexc}">{a}</a:srgbClr>'

def ln_xml(d):
    if d.get('color') is None or 'NOSTROKE' in d:
        return '<a:ln><a:noFill/></a:ln>'
    w = d.get('width') or 1.0
    so = d.get('stroke_opacity'); so = 1 if so is None else so
    dash = ''
    ds = d.get('dashes')
    if ds:
        m = re.match(r'\[\s*([^\]]*)\]', ds)
        nums = [float(x) for x in m.group(1).split()] if m else []
        if nums:
            if len(nums) == 1:
                nums = nums * 2
            parts = ''.join(f'<a:ds d="{int(nums[i] / w * 100000)}" sp="{int(nums[i + 1] / w * 100000)}"/>'
                            for i in range(0, len(nums) - 1, 2))
            dash = f'<a:custDash>{parts}</a:custDash>'
    cap = {0: 'flat', 1: 'rnd', 2: 'sq'}.get((d.get('lineCap') or (0,))[0] if isinstance(d.get('lineCap'), (tuple, list)) else (d.get('lineCap') or 0), 'flat')
    join = {0: '<a:miter lim="800000"/>', 1: '<a:round/>', 2: '<a:bevel/>'}.get(int(d.get('lineJoin') or 0), '<a:miter/>')
    return (f'<a:ln w="{e(w)}" cap="{cap}"><a:solidFill>{clr_xml(rgb_hex(d["color"]), so)}</a:solidFill>'
            f'{dash}{join}</a:ln>')

def fill_xml(d):
    if d.get('fill') is None:
        return '<a:noFill/>'
    fo = d.get('fill_opacity'); fo = 1 if fo is None else fo
    return f'<a:solidFill>{clr_xml(rgb_hex(d["fill"]), fo)}</a:solidFill>'

class Builder:
    def __init__(self, slide):
        self.slide = slide
        self.tree = slide.shapes._spTree
        self.n = 0
        self.stats = {'freeform': 0, 'rect': 0, 'line': 0, 'gradient': 0, 'textbox': 0, 'picture': 0}

    def _id(self):
        return self.slide.shapes._next_shape_id

    def add_sp(self, name, x, y, w, h, geom, fill, ln):
        sid = self._id()
        xml = (f'<p:sp xmlns:p="{P}" xmlns:a="{A}"><p:nvSpPr><p:cNvPr id="{sid}" name="{name} {sid}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
               f'<p:spPr><a:xfrm><a:off x="{e(x)}" y="{e(y)}"/><a:ext cx="{max(1, e(w))}" cy="{max(1, e(h))}"/></a:xfrm>'
               f'{geom}{fill}{ln}</p:spPr></p:sp>')
        self.tree.append(etree.fromstring(xml))

    def rect(self, r, d):
        self.add_sp('Rectangle', r.x0, r.y0, r.width, r.height, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
                    fill_xml(d), ln_xml(d))
        self.stats['rect'] += 1

    def line(self, p1, p2, d):
        x0, y0, x1, y1 = p1.x, p1.y, p2.x, p2.y
        flipH = x1 < x0; flipV = y1 < y0
        sid = self._id()
        fl = (' flipH="1"' if flipH else '') + (' flipV="1"' if flipV else '')
        xml = (f'<p:cxnSp xmlns:p="{P}" xmlns:a="{A}"><p:nvCxnSpPr><p:cNvPr id="{sid}" name="Line {sid}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
               f'<p:spPr><a:xfrm{fl}><a:off x="{e(min(x0, x1))}" y="{e(min(y0, y1))}"/><a:ext cx="{e(abs(x1 - x0))}" cy="{e(abs(y1 - y0))}"/></a:xfrm>'
               f'<a:prstGeom prst="line"><a:avLst/></a:prstGeom>{ln_xml(d)}</p:spPr></p:cxnSp>')
        self.tree.append(etree.fromstring(xml))
        self.stats['line'] += 1

    def freeform(self, d, subpaths):
        r = d['rect']
        ox, oy = r.x0, r.y0
        W, H = max(r.width, 0.01), max(r.height, 0.01)
        def pt(p):
            return f'<a:pt x="{e(p.x - ox)}" y="{e(p.y - oy)}"/>'
        body = []
        for sp in subpaths:
            cur = None
            for it in sp:
                k = it[0]
                if k == 'l':
                    if cur is None or abs(cur.x - it[1].x) > 0.01 or abs(cur.y - it[1].y) > 0.01:
                        body.append(f'<a:moveTo>{pt(it[1])}</a:moveTo>')
                    body.append(f'<a:lnTo>{pt(it[2])}</a:lnTo>'); cur = it[2]
                elif k == 'c':
                    if cur is None or abs(cur.x - it[1].x) > 0.01 or abs(cur.y - it[1].y) > 0.01:
                        body.append(f'<a:moveTo>{pt(it[1])}</a:moveTo>')
                    body.append(f'<a:cubicBezTo>{pt(it[2])}{pt(it[3])}{pt(it[4])}</a:cubicBezTo>'); cur = it[4]
                elif k == 're':
                    q = it[1]
                    body.append(f'<a:moveTo>{pt(fitz.Point(q.x0, q.y0))}</a:moveTo><a:lnTo>{pt(fitz.Point(q.x1, q.y0))}</a:lnTo>'
                                f'<a:lnTo>{pt(fitz.Point(q.x1, q.y1))}</a:lnTo><a:lnTo>{pt(fitz.Point(q.x0, q.y1))}</a:lnTo><a:close/>'); cur = None
                elif k == 'qu':
                    q = it[1]
                    body.append(f'<a:moveTo>{pt(q.ul)}</a:moveTo><a:lnTo>{pt(q.ur)}</a:lnTo><a:lnTo>{pt(q.lr)}</a:lnTo>'
                                f'<a:lnTo>{pt(q.ll)}</a:lnTo><a:close/>'); cur = None
            if d.get('fill') is not None or d.get('closePath'):
                if body and not body[-1].endswith('<a:close/>'):
                    body.append('<a:close/>')
        geom = (f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
                f'<a:pathLst><a:path w="{max(1, e(W))}" h="{max(1, e(H))}">{"".join(body)}</a:path></a:pathLst></a:custGeom>')
        self.add_sp('Freeform', ox, oy, W, H, geom, fill_xml(d), ln_xml(d))
        self.stats['freeform'] += 1

    def gradient(self, bbox, stops, ang_deg):
        gs = ''.join(f'<a:gs pos="{int(round(p * 100000))}">{clr_xml(c)}</a:gs>' for p, c in stops)
        fill = f'<a:gradFill rotWithShape="1"><a:gsLst>{gs}</a:gsLst><a:lin ang="{int(round(ang_deg % 360 * 60000))}" scaled="0"/></a:gradFill>'
        self.add_sp('Gradient', bbox.x0, bbox.y0, bbox.width, bbox.height,
                    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', fill, '<a:ln><a:noFill/></a:ln>')
        self.stats['gradient'] += 1

    def textline(self, line):
        spans = [s for s in line['spans'] if s['text']]
        if not spans:
            return
        bb = fitz.Rect(line['bbox'])
        # PDF line bbox top (font ascender) sits ~0.1em above where PowerPoint puts the line top for
        # Malgun Gothic (calibrated by row-profile correlation against ground truth); font-specific in general
        dy = TEXT_DY * max(s['size'] for s in spans)
        tb = self.slide.shapes.add_textbox(Emu(e(bb.x0)), Emu(e(bb.y0 + dy)), Emu(e(bb.width * 1.08 + 2)), Emu(e(bb.height)))
        tf = tb.text_frame
        tf.word_wrap = False; tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        p = tf.paragraphs[0]
        for s in spans:
            r = p.add_run(); r.text = s['text']
            f = r.font
            raw = s['font'].split('+')[-1]
            bold = bool(s['flags'] & 16) or 'Bold' in raw
            ital = bool(s['flags'] & 2) or 'Italic' in raw or 'Oblique' in raw
            base = re.sub(r'[-,]?(Bold|Italic|Oblique|Regular|BoldItalic|Semibold|Light)$', '', raw)
            base = re.sub(r'[-,]?(Bold|Italic)$', '', base)
            name = FONT_MAP.get(base, base)
            f.size = Pt(round(s['size'] * 2) / 2); f.bold = bold; f.italic = ital
            f.color.rgb = RGBColor.from_string('%06X' % s['color'])
            rPr = r._r.get_or_add_rPr()
            for tag in ('a:latin', 'a:ea', 'a:cs'):
                el = rPr.find(qn(tag))
                if el is None:
                    el = etree.SubElement(rPr, qn(tag))
                el.set('typeface', name)
        self.stats['textbox'] += 1

    def picture(self, doc, xref, bbox):
        img = doc.extract_image(xref)
        data = img['image']
        if img.get('smask'):
            # M1-R59, the only change since freezing (README.md); it acts only where the frozen line raised. PyMuPDF
            # 2.1 loads an image whose mask has /Matte with an all-opaque alpha of its own: drop it. MuPDF combines
            # only same-size pixmaps: scale the smaller of image and mask to the other's size. Then combine as before.
            base, mask = fitz.Pixmap(doc, xref), fitz.Pixmap(doc, img['smask'])
            if base.alpha:
                base = fitz.Pixmap(base, 0)
            if (base.width, base.height) != (mask.width, mask.height):
                if base.width * base.height < mask.width * mask.height:
                    base = fitz.Pixmap(base, mask.width, mask.height, None)
                else:
                    mask = fitz.Pixmap(mask, base.width, base.height, None)
            pm = fitz.Pixmap(base, mask)
            data = pm.tobytes('png')
        self.slide.shapes.add_picture(io.BytesIO(data), Emu(e(bbox.x0)), Emu(e(bbox.y0)), Emu(e(bbox.width)), Emu(e(bbox.height)))
        self.stats['picture'] += 1


def eval_function(doc, fx, t):
    o = doc.xref_object(fx)
    ft = int(re.search(r'/FunctionType (\d)', o).group(1))
    if ft == 2:
        c0 = [float(x) for x in re.search(r'/C0 \[([^\]]*)\]', o).group(1).split()] if '/C0' in o else [0]
        c1 = [float(x) for x in re.search(r'/C1 \[([^\]]*)\]', o).group(1).split()] if '/C1' in o else [1]
        n = float(re.search(r'/N ([\d.]+)', o).group(1))
        return [a + (t ** n) * (b - a) for a, b in zip(c0, c1)]
    if ft == 0:
        size = int(re.search(r'/Size \[\s*(\d+)', o).group(1))
        bps = int(re.search(r'/BitsPerSample (\d+)', o).group(1))
        rng = [float(x) for x in re.search(r'/Range \[([^\]]*)\]', o).group(1).split()]
        ncomp = len(rng) // 2
        data = doc.xref_stream(fx)
        idx = min(size - 1, max(0, int(round(t * (size - 1)))))
        if bps == 8:
            vals = data[idx * ncomp: idx * ncomp + ncomp]
            return [v / 255 for v in vals]
    if ft == 3:
        fns = [int(x) for x in re.findall(r'(\d+) 0 R', re.search(r'/Functions \[([^\]]*)\]', o).group(1))]
        bounds = [float(x) for x in re.search(r'/Bounds \[([^\]]*)\]', o).group(1).split()] if '/Bounds' in o else []
        edges = [0] + bounds + [1]
        for i, fxi in enumerate(fns):
            if t <= edges[i + 1] or i == len(fns) - 1:
                lt = (t - edges[i]) / max(1e-9, edges[i + 1] - edges[i])
                return eval_function(doc, fxi, max(0, min(1, lt)))
    return [0.5, 0.5, 0.5]


def gradients_for_page(doc, page):
    """Return list of (stops_fn, coords_in_page_space) for axial shading patterns on the page."""
    out = []
    res = doc.xref_get_key(page.xref, 'Resources/Pattern')
    if res[0] != 'dict':
        return out
    H = page.rect.height
    for name, x in re.findall(r'/(\w+)\s+(\d+) 0 R', res[1]):
        o = doc.xref_object(int(x))
        if '/ShadingType 2' not in o:
            continue
        coords = [float(v) for v in re.search(r'/Coords \[([^\]]*)\]', o).group(1).split()]
        fx = int(re.search(r'/Function (\d+) 0 R', o).group(1))
        m = re.search(r'/Matrix \[([^\]]*)\]', o)
        mat = fitz.Matrix(*[float(v) for v in m.group(1).split()]) if m else fitz.Matrix(1, 0, 0, 1, 0, 0)
        p0 = fitz.Point(coords[0], coords[1]) * mat; p1 = fitz.Point(coords[2], coords[3]) * mat
        p0 = fitz.Point(p0.x, H - p0.y); p1 = fitz.Point(p1.x, H - p1.y)  # PDF user space -> top-left page space
        out.append((fx, p0, p1))
    return out


def _convert(pdf, outp):
    """The prototype's own entry point: returns one stats dict per slide."""
    doc = fitz.open(str(pdf))
    prs = Presentation()
    r0 = doc[0].rect
    prs.slide_width = Emu(e(r0.width)); prs.slide_height = Emu(e(r0.height))
    blank = prs.slide_layouts[6]
    allstats = []
    for page in doc:
        slide = prs.slides.add_slide(blank)
        B = Builder(slide)
        ops = []  # (seqno, kind, payload)
        log = page.get_bboxlog()
        for d in page.get_drawings():
            ops.append((d['seqno'], 'draw', d))
        # images: match bboxlog fill-image entries in order with image infos
        infos = page.get_image_info(xrefs=True)
        img_seq = [i for i, (t, b) in enumerate(log) if t == 'fill-image']
        shade_seq = [i for i, (t, b) in enumerate(log) if t == 'fill-shade']
        real = [ii for ii in infos if ii['xref'] > 0]
        shades = [ii for ii in infos if ii['xref'] == 0]   # PyMuPDF reports shading fills as xref-0 "images"
        for ii, sq in zip(real, img_seq):
            ops.append((sq, 'img', ii))
        grads = gradients_for_page(doc, page)
        for k, (ii, sq) in enumerate(zip(shades, shade_seq)):
            ops.append((sq, 'shade', (ii, grads[k] if k < len(grads) else None)))
        # text lines with z from texttrace seqno
        tt = page.get_texttrace()
        td = page.get_text('dict')
        for b in td['blocks']:
            if b['type'] != 0:
                continue
            for l in b['lines']:
                lb = fitz.Rect(l['bbox'])
                seqs = [s['seqno'] for s in tt if fitz.Rect(s['bbox']).intersects(lb) and abs(s['bbox'][1] - lb.y0) < 6]
                ops.append((min(seqs) if seqs else 10 ** 6, 'text', l))
        ops.sort(key=lambda o: o[0])
        for sq, kind, pl in ops:
            if kind == 'draw':
                d = pl; it = d['items']
                if sq == 0 and len(it) == 1 and it[0][0] == 're' and fitz.Rect(it[0][1]).contains(page.rect * 0.999):
                    slide.background.fill.solid(); slide.background.fill.fore_color.rgb = RGBColor.from_string(rgb_hex(d['fill'] or (1, 1, 1)))
                    continue
                if d.get('fill') is None and (d.get('stroke_opacity') == 0 or d.get('color') is None):
                    continue  # invisible
                if all(x[0] == 're' for x in it):
                    for x in it:
                        B.rect(fitz.Rect(x[1]), d)
                    continue
                # split into subpaths (disconnected runs)
                subs = []; cur = None
                for x in it:
                    start = x[1] if x[0] in ('l', 'c') else None
                    if start is None or cur is None or abs(cur.x - start.x) > 0.01 or abs(cur.y - start.y) > 0.01:
                        subs.append([])
                    subs[-1].append(x)
                    cur = x[-1] if x[0] in ('l', 'c') else None
                if d.get('fill') is None and all(len(s) == 1 and s[0][0] == 'l' for s in subs):
                    for s in subs:
                        B.line(s[0][1], s[0][2], d)
                    continue
                B.freeform(d, subs)
            elif kind == 'img':
                B.picture(doc, pl['xref'], fitz.Rect(pl['bbox']))
            elif kind == 'shade':
                ii, g = pl; bb = fitz.Rect(ii['bbox'])
                if g is None:
                    continue
                fx, p0, p1 = g
                dx, dy = p1.x - p0.x, p1.y - p0.y; L2 = dx * dx + dy * dy or 1
                corners = [bb.tl, bb.tr, bb.bl, bb.br]
                ts = [((c.x - p0.x) * dx + (c.y - p0.y) * dy) / L2 for c in corners]
                tmin, tmax = min(ts), max(ts)
                stops = []
                for k in range(6):
                    t = tmin + (tmax - tmin) * k / 5
                    stops.append((k / 5, rgb_hex(eval_function(doc, fx, max(0, min(1, t))))))
                ang = math.degrees(math.atan2(dy, dx))
                B.gradient(bb, stops, ang)
            elif kind == 'text':
                B.textline(pl)
        allstats.append(B.stats)
    prs.save(str(outp))
    return allstats

def convert(pdf: Path, out: Path) -> dict:
    """Convert ``pdf`` to ``out`` (.pptx). Returns {pages, shapes, textBoxes, pictures, seconds}.

    ``shapes`` counts every shape written on the slides (freeforms, rectangles, lines, gradient rectangles, text
    boxes and pictures); the slide background fill is not a shape.
    """
    t0 = time.perf_counter()
    stats = _convert(Path(pdf), Path(out))
    return {
        'pages': len(stats),
        'shapes': sum(sum(s.values()) for s in stats),
        'textBoxes': sum(s['textbox'] for s in stats),
        'pictures': sum(s['picture'] for s in stats),
        'seconds': round(time.perf_counter() - t0, 3),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python -m harness.baseline.proto',
                                 description='Baseline PDF -> PPTX converter (M0 probe prototype).')
    ap.add_argument('pdf', type=Path, help='input PDF')
    ap.add_argument('-o', '--out', type=Path, required=True, help='output .pptx')
    args = ap.parse_args(argv)
    result = convert(args.pdf, args.out)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
