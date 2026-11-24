import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { writePptx, type OxConnector, type OxFill, type OxFrame, type OxLineStyle, type OxNode, type OxPath, type OxShape, type OxStop } from '../src';
import { EDGE_SIZE, edgeShapesDeck } from './edge-decks';
import { connector, FRAME, LAYOUT_REL, LINE, PNG_KEY, REL, shape, slideParts, tree } from './helpers/slides';

function path(cmds: OxPath['cmds'], over: Partial<OxPath> = {}): OxPath {
  return { w: 1000, h: 500, fill: true, stroke: true, cmds, ...over };
}

function custom(paths: OxPath[], over: Partial<OxShape> = {}): OxShape {
  return shape({ geom: { kind: 'custom', paths }, ...over });
}

/** The `a:ln` of the one shape of a deck. */
function ln(line: OxLineStyle): string {
  const found = /<a:ln[ >].*<\/a:ln>/.exec(tree(shape({ line })));
  if (found === null) throw new Error('no a:ln');
  return found[0];
}

/** The fill element of the one shape of a deck: what lies between its geometry and its `a:ln`. */
function fill(f: OxFill): string {
  const found = /<\/a:prstGeom>(.*)<a:ln>/.exec(tree(shape({ fill: f })));
  if (found === null) throw new Error('no fill');
  return found[1]!;
}

type Grad = Extract<OxFill, { kind: 'grad' }>;

function grad(stops: OxStop[], shade: Grad['shade'] = { kind: 'lin', ang: 0, scaled: false }): Grad {
  return { kind: 'grad', stops, shade, rotWithShape: true };
}

const stop = (pos: number, rgb: string, alpha = 100000): OxStop => ({ pos, rgb, alpha });

describe('shapes', () => {
  it('a rect shape is a p:sp of nvSpPr then spPr (xfrm, prstGeom, fill, ln), without p:style or p:txBody', () => {
    expect(tree(shape({ line: LINE }))).toBe(
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="pdf:p1:z7 shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
        '<p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="635000"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill>' +
        '<a:ln w="12700" cap="flat"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="solid"/>' +
        '<a:miter lim="800000"/></a:ln></p:spPr></p:sp>',
    );
    // no line: an explicit a:ln without fill (no p:style to fall back on)
    expect(tree(shape())).toContain('</a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>');
  });

  it('the name is written as given, escaped, without the characters XML refuses', () => {
    expect(tree(shape({ name: 'pdf:p12:z345:2 shape' }))).toContain('<p:cNvPr id="2" name="pdf:p12:z345:2 shape"/>');
    expect(tree(shape({ name: 'a<b>&"c\u0001\uD800' }))).toContain('name="a&lt;b&gt;&amp;&quot;c"');
  });

  it('a:xfrm writes rot, flipH and flipV in that order, each only when set; rotations wrap into 0..21599999', () => {
    const xfrm = (frame: Partial<OxFrame>) => /<a:xfrm[^>]*>/.exec(tree(shape({ frame: { ...FRAME, ...frame } })))![0];
    expect(xfrm({})).toBe('<a:xfrm>');
    expect(xfrm({ rot: 5400000, flipH: true, flipV: true })).toBe('<a:xfrm rot="5400000" flipH="1" flipV="1">');
    expect(xfrm({ flipV: true })).toBe('<a:xfrm flipV="1">');
    expect(xfrm({ rot: -5400000 })).toBe('<a:xfrm rot="16200000">');
    expect(xfrm({ rot: 21600000 })).toBe('<a:xfrm>');
    expect(xfrm({ rot: 27000000.5 })).toBe('<a:xfrm rot="5400001">');
  });

  it('custGeom has avLst, gdLst, ahLst, cxnLst, rect, then one a:path per OxPath with fill="none" and stroke="0"', () => {
    const paths = [
      path([['M', 0, 0], ['L', 1000, 0], ['C', 1000, 250, 500, 500, 0, 500], ['Z']]),
      path([['M', 0, 500], ['L', 1000, 500]], { fill: false }),
      path([['M', 10, 10], ['L', 20, 20]], { w: 0, h: 0, stroke: false }),
    ];
    expect(tree(custom(paths))).toContain(
      '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>' +
        '<a:path w="1000" h="500"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1000" y="0"/></a:lnTo>' +
        '<a:cubicBezTo><a:pt x="1000" y="250"/><a:pt x="500" y="500"/><a:pt x="0" y="500"/></a:cubicBezTo><a:close/></a:path>' +
        '<a:path w="1000" h="500" fill="none"><a:moveTo><a:pt x="0" y="500"/></a:moveTo><a:lnTo><a:pt x="1000" y="500"/></a:lnTo></a:path>' +
        '<a:path w="0" h="0" stroke="0"><a:moveTo><a:pt x="10" y="10"/></a:moveTo><a:lnTo><a:pt x="20" y="20"/></a:lnTo></a:path>' +
        '</a:pathLst></a:custGeom><a:solidFill>',
    );
  });

  it('a path with no drawing command is dropped, and a shape left with no path is not written and takes no id', () => {
    const empty = [path([]), path([['M', 5, 5]]), path([['M', 5, 5], ['Z']]), path([['Z'], ['M', 1, 1], ['M', 2, 2]])];
    const kept = path([['M', 3, 3], ['L', 3, 3]]); // one point, drawn: a zero-length segment is a drawing command
    const written = tree(custom([empty[0]!, kept, ...empty.slice(1)], { name: 'kept' }));
    expect(written.match(/<a:path /g)).toHaveLength(1);
    expect(written).toContain('<a:path w="1000" h="500"><a:moveTo><a:pt x="3" y="3"/></a:moveTo><a:lnTo><a:pt x="3" y="3"/></a:lnTo></a:path>');

    const nodes = [shape({ name: 'a' }), custom(empty, { name: 'gone', link: { kind: 'url', url: 'https://example.com/' } }), custom([], { name: 'none' }), connector({ name: 'b' })];
    const { tree: t, rels } = slideParts([{ nodes, background: null }]);
    expect([...t.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)].map((m) => [m[1], m[2]])).toEqual([
      ['2', 'a'],
      ['3', 'b'],
    ]);
    expect(rels).not.toContain('hyperlink'); // a shape not written adds no relationship
  });

  it('ids count up from 2 in z-order over shapes and connectors', () => {
    const nodes = [connector({ name: 'l1' }), shape({ name: 's1' }), connector({ name: 'l2' }), shape({ name: 's2' })];
    expect([...tree(...nodes).matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      '2 l1',
      '3 s1',
      '4 l2',
      '5 s2',
    ]);
  });

  it('a connector is a p:cxnSp with a:prstGeom line and an a:ln; its direction is the flips', () => {
    expect(tree(connector({ frame: { ...FRAME, h: 0, flipH: true } }))).toBe(
      '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="2" name="pdf:p1:z8 line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
        '<p:spPr><a:xfrm flipH="1"><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="0"/></a:xfrm>' +
        '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>' +
        '<a:ln w="12700" cap="flat"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="solid"/>' +
        '<a:miter lim="800000"/></a:ln></p:spPr></p:cxnSp>',
    );
  });

  it('a frame of width or height 0 stays 0; a negative one is refused', () => {
    expect(tree(shape({ frame: { ...FRAME, w: 0, h: 0 } }))).toContain('<a:ext cx="0" cy="0"/>');
    expect(tree(connector({ frame: { ...FRAME, w: 0 } }))).toContain('<a:ext cx="0" cy="635000"/>');
    for (const frame of [{ ...FRAME, w: -1 }, { ...FRAME, h: -12700 }]) {
      expect(() => tree(shape({ frame }))).toThrow(RangeError);
      expect(() => tree(connector({ frame }))).toThrow(RangeError);
      expect(() => tree(custom([path([])], { frame }))).toThrow(RangeError); // refused even when it would be dropped
    }
  });
});

describe('fills', () => {
  it('solid: srgbClr in upper case, with a:alpha only below 100000', () => {
    expect(fill({ kind: 'solid', rgb: 'a1b2c3', alpha: 100000 })).toBe('<a:solidFill><a:srgbClr val="A1B2C3"/></a:solidFill>');
    expect(fill({ kind: 'solid', rgb: 'A1B2C3', alpha: 50000 })).toBe(
      '<a:solidFill><a:srgbClr val="A1B2C3"><a:alpha val="50000"/></a:srgbClr></a:solidFill>',
    );
    expect(fill({ kind: 'solid', rgb: '000000', alpha: 0 })).toBe('<a:solidFill><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:solidFill>');
    for (const rgb of ['', '12345', '1234567', '#123456', 'GGGGGG']) {
      expect(() => fill({ kind: 'solid', rgb, alpha: 100000 }), rgb).toThrow(/RRGGBB/);
    }
  });

  it('none: a:noFill', () => {
    expect(fill({ kind: 'none' })).toBe('<a:noFill/>');
  });

  it('grad: gradFill rotWithShape, gsLst in pos order, then a:lin ang scaled', () => {
    expect(fill(grad([stop(0, 'FF0000'), stop(100000, '0000FF', 25000)], { kind: 'lin', ang: 2700000, scaled: true }))).toBe(
      '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
        '<a:gs pos="100000"><a:srgbClr val="0000FF"><a:alpha val="25000"/></a:srgbClr></a:gs></a:gsLst>' +
        '<a:lin ang="2700000" scaled="1"/></a:gradFill>',
    );
    const unrotated: OxFill = { ...grad([stop(0, '000000'), stop(100000, 'FFFFFF')]), rotWithShape: false };
    expect(fill(unrotated)).toMatch(/^<a:gradFill rotWithShape="0">.*<a:lin ang="0" scaled="0"\/><\/a:gradFill>$/);
  });

  it('grad: a:path path="circle" with a:fillToRect, its zero sides left out', () => {
    expect(fill(grad([stop(0, 'FFFFFF'), stop(100000, '000000')], { kind: 'circle', fillToRect: [50000, 50000, 50000, 50000] }))).toContain(
      '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>',
    );
    expect(fill(grad([stop(0, 'FFFFFF'), stop(100000, '000000')], { kind: 'circle', fillToRect: [0, 100000, 0, -20000] }))).toContain(
      '<a:path path="circle"><a:fillToRect t="100000" b="-20000"/></a:path>',
    );
  });

  it('grad: a circle path with a tile rect writes a:tileRect after a:path, its zero sides left out (M5 Task 3)', () => {
    const shade: Grad['shade'] = { kind: 'circle', fillToRect: [50000, 50000, 50000, 50000], tileRect: [-25000, 0, 12500, -60000] };
    expect(fill(grad([stop(0, 'FFFFFF'), stop(100000, '000000')], shade))).toContain(
      '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>' +
        '<a:tileRect l="-25000" r="12500" b="-60000"/></a:gradFill>',
    );
    // none without one: the gradient fills the shape's box, as before
    expect(fill(grad([stop(0, 'FFFFFF'), stop(100000, '000000')], { kind: 'circle', fillToRect: [0, 0, 0, 0] }))).not.toContain('tileRect');
  });

  it('grad: stops are sorted by pos, equal positions in input order', () => {
    const stops = [stop(100000, '000005'), stop(50000, '000003'), stop(0, '000001'), stop(50000, '000004'), stop(0, '000002')];
    const written = [...fill(grad(stops)).matchAll(/<a:gs pos="(\d+)"><a:srgbClr val="(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(written).toEqual(['0 000001', '0 000002', '50000 000003', '50000 000004', '100000 000005']);
  });

  it('grad: one stop is written twice, at 0 and at 100000; none is refused', () => {
    expect(fill(grad([stop(30000, '123456', 40000)]))).toBe(
      '<a:gradFill rotWithShape="1"><a:gsLst>' +
        '<a:gs pos="0"><a:srgbClr val="123456"><a:alpha val="40000"/></a:srgbClr></a:gs>' +
        '<a:gs pos="100000"><a:srgbClr val="123456"><a:alpha val="40000"/></a:srgbClr></a:gs>' +
        '</a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>',
    );
    expect(() => fill(grad([]))).toThrow(RangeError);
  });

  it('blip: a:blipFill with a:blip r:embed (a:alphaModFix below 100000), then a:stretch/a:fillRect or a:tile', () => {
    const blip = (alpha: number, mode: Extract<OxFill, { kind: 'blip' }>['mode']): OxFill => ({ kind: 'blip', media: PNG_KEY, alpha, mode });
    expect(fill(blip(100000, { kind: 'stretch', fillRect: [0, 0, 0, 0] }))).toBe(
      '<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
    );
    expect(fill(blip(50000, { kind: 'stretch', fillRect: [10000, -5000, 0, 2000] }))).toBe(
      '<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"><a:alphaModFix amt="50000"/></a:blip>' +
        '<a:stretch><a:fillRect l="10000" t="-5000" b="2000"/></a:stretch></a:blipFill>',
    );
    expect(fill(blip(0, { kind: 'tile', tx: 12700, ty: -25400, sx: 50000, sy: 200000 }))).toBe(
      '<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"><a:alphaModFix amt="0"/></a:blip>' +
        '<a:tile tx="12700" ty="-25400" sx="50000" sy="200000" flip="none" algn="tl"/></a:blipFill>',
    );
  });

  it('patt: a:pattFill prst with a:fgClr and a:bgClr, alpha below opaque (M5-R10); an unknown preset is refused', () => {
    expect(fill({ kind: 'patt', prst: 'narHorz', fg: { rgb: '1f3864', alpha: 100000 }, bg: { rgb: 'FFF2CC', alpha: 40000 } })).toBe(
      '<a:pattFill prst="narHorz"><a:fgClr><a:srgbClr val="1F3864"/></a:fgClr>' +
        '<a:bgClr><a:srgbClr val="FFF2CC"><a:alpha val="40000"/></a:srgbClr></a:bgClr></a:pattFill>',
    );
    expect(() => fill({ kind: 'patt', prst: 'stripes' as never, fg: { rgb: '000000', alpha: 100000 }, bg: { rgb: 'FFFFFF', alpha: 100000 } })).toThrow(/preset pattern/);
    // a line may take one (EG_LineFillProperties)
    const ln = tree(shape({ line: { w: 12700, fill: { kind: 'patt', prst: 'pct50', fg: { rgb: '000000', alpha: 100000 }, bg: { rgb: 'FFFFFF', alpha: 100000 } }, cap: 'flat', join: 'miter', miterLim: 800000, dash: null } }));
    expect(ln).toContain('<a:ln w="12700" cap="flat"><a:pattFill prst="pct50">');
  });

  it('blip: the picture is a relationship of the slide to its media part, one per key', () => {
    const blip: OxFill = { kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
    const { tree: t, rels } = slideParts([{ nodes: [shape({ fill: blip }), shape({ fill: blip })], background: null }]);
    expect(t.match(/r:embed="rId2"/g)).toHaveLength(2);
    expect(rels).toContain(`${LAYOUT_REL}<Relationship Id="rId2" Type="${REL}image" Target="../media/${PNG_KEY}.png"/></Relationships>`);
    // a key the writer was not given is refused
    const unknown: OxFill = { ...blip, media: 'f'.repeat(64) };
    expect(() => tree(shape({ fill: unknown }))).toThrow(/media key/);
  });
});

describe('lines', () => {
  it('a:ln w cap, then the fill, then prstDash or custDash, then the join, for every cap and join', () => {
    for (const cap of ['flat', 'rnd', 'sq'] as const) {
      expect(ln({ ...LINE, cap, join: 'round' })).toBe(
        `<a:ln w="12700" cap="${cap}"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`,
      );
    }
    expect(ln({ ...LINE, join: 'bevel', dash: [300000, 100000, 0, 100000] })).toBe(
      '<a:ln w="12700" cap="flat"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>' +
        '<a:custDash><a:ds d="300000" sp="100000"/><a:ds d="1" sp="100000"/></a:custDash><a:bevel/></a:ln>',
    );
    expect(ln({ ...LINE, join: 'miter', miterLim: 400000 })).toContain('<a:prstDash val="solid"/><a:miter lim="400000"/></a:ln>');
  });

  it('a:ln takes a none, solid or gradient fill, and refuses a picture (EG_LineFillProperties has none)', () => {
    expect(ln({ ...LINE, fill: { kind: 'none' } })).toBe('<a:ln w="12700" cap="flat"><a:noFill/><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>');
    expect(ln({ ...LINE, fill: grad([stop(0, 'FF0000'), stop(100000, '00FF00')]) })).toMatch(
      /^<a:ln w="12700" cap="flat"><a:gradFill rotWithShape="1">.*<\/a:gradFill><a:prstDash val="solid"\/><a:miter lim="800000"\/><\/a:ln>$/,
    );
    const picture: OxFill = { kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
    expect(() => ln({ ...LINE, fill: picture })).toThrow(/picture/);
  });

  it('a dash of all zeros, or of none, is written solid; an odd one is repeated to pairs; a 0 among others is 1', () => {
    for (const dash of [[0, 0], [0, 0, 0, 0], [], [0], [-5, 0]]) {
      expect(ln({ ...LINE, dash }), String(dash)).toContain('<a:prstDash val="solid"/>');
    }
    expect(ln({ ...LINE, dash: [300000, 100000, 50000] })).toContain(
      '<a:custDash><a:ds d="300000" sp="100000"/><a:ds d="50000" sp="300000"/><a:ds d="100000" sp="50000"/></a:custDash>',
    );
    // the validator wants d and sp at least 1: a dot (d 0) and no gap (sp 0) become the shortest there is
    expect(ln({ ...LINE, dash: [0, 200000] })).toContain('<a:custDash><a:ds d="1" sp="200000"/></a:custDash>');
    expect(ln({ ...LINE, dash: [300000, 0, 0, 100000] })).toContain('<a:custDash><a:ds d="300000" sp="1"/><a:ds d="1" sp="100000"/></a:custDash>');
  });
});

describe('every number is clamped to its ST type range', () => {
  const MAX_COORD = 27273042316900;
  const MIN_COORD = -27273042329600;
  const MAX_SIZE = 2147483647; // ST_PositiveCoordinate in the validator's schema
  const INT_MAX = 2147483647;
  const INT_MIN = -2147483648;
  const stretch = (fillRect: [number, number, number, number]): OxFill => ({ kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect } });
  const tile = (tx: number, sx: number): OxFill => ({ kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'tile', tx, ty: tx, sx, sy: sx } });

  const cases: [string, OxNode, string][] = [
    ['ST_Coordinate a:off, high', shape({ frame: { ...FRAME, x: 3e13, y: Infinity } }), `<a:off x="${MAX_COORD}" y="${MAX_COORD}"/>`],
    ['ST_Coordinate a:off, low', shape({ frame: { ...FRAME, x: -3e13, y: -Infinity } }), `<a:off x="${MIN_COORD}" y="${MIN_COORD}"/>`],
    ['ST_PositiveCoordinate a:ext', shape({ frame: { ...FRAME, w: 3e13, h: Infinity } }), `<a:ext cx="${MAX_SIZE}" cy="${MAX_SIZE}"/>`],
    ['ST_PositiveCoordinate a:ext, at its maximum', shape({ frame: { ...FRAME, w: MAX_SIZE, h: MAX_SIZE + 1 } }), `<a:ext cx="${MAX_SIZE}" cy="${MAX_SIZE}"/>`],
    ['half away from zero', shape({ frame: { ...FRAME, x: 12.5, y: -12.5, w: 0.4, h: 2.5 } }), '<a:off x="13" y="-13"/><a:ext cx="0" cy="3"/>'],
    ['ST_PositiveCoordinate a:path w h', custom([path([['M', 0, 0], ['L', 1, 1]], { w: -5, h: 3e13 })]), `<a:path w="0" h="${MAX_SIZE}">`],
    ['a:pt, in the 32-bit range of its path', custom([path([['M', -3e13, 3e13], ['L', 1.5, -1.5]])]), `<a:pt x="${INT_MIN}" y="${INT_MAX}"/></a:moveTo><a:lnTo><a:pt x="2" y="-2"/>`],
    ['ST_PositiveFixedPercentage alpha', shape({ fill: { kind: 'solid', rgb: '000000', alpha: 150000 } }), '<a:srgbClr val="000000"/></a:solidFill>'],
    ['ST_PositiveFixedPercentage alpha, low', shape({ fill: { kind: 'solid', rgb: '000000', alpha: -1 } }), '<a:alpha val="0"/>'],
    ['ST_PositiveFixedPercentage gs pos', shape({ fill: grad([stop(120000, '000002'), stop(-5, '000001')]) }), '<a:gs pos="0"><a:srgbClr val="000001"/></a:gs><a:gs pos="100000"><a:srgbClr val="000002"/>'],
    ['ST_PositiveFixedAngle a:lin ang', shape({ fill: grad([stop(0, '000000'), stop(100000, 'FFFFFF')], { kind: 'lin', ang: -5400000, scaled: false }) }), '<a:lin ang="16200000" scaled="0"/>'],
    ['ST_PositiveFixedAngle a full turn', shape({ fill: grad([stop(0, '000000'), stop(100000, 'FFFFFF')], { kind: 'lin', ang: 21600000, scaled: false }) }), '<a:lin ang="0" scaled="0"/>'],
    ['ST_Percentage a:fillToRect', shape({ fill: grad([stop(0, '000000'), stop(100000, 'FFFFFF')], { kind: 'circle', fillToRect: [3e9, -3e9, 1, 1] }) }), `<a:fillToRect l="${INT_MAX}" t="${INT_MIN}" r="1" b="1"/>`],
    ['ST_Percentage a:tileRect', shape({ fill: grad([stop(0, '000000'), stop(100000, 'FFFFFF')], { kind: 'circle', fillToRect: [0, 0, 0, 0], tileRect: [-3e9, 3e9, 0.5, -0.5] }) }), `<a:tileRect l="${INT_MIN}" t="${INT_MAX}" r="1" b="-1"/>`],
    ['ST_Percentage a:fillRect', shape({ fill: stretch([-3e9, 3e9, 0, 0]) }), `<a:fillRect l="${INT_MIN}" t="${INT_MAX}"/>`],
    ['ST_Coordinate and ST_Percentage a:tile', shape({ fill: tile(3e13, 3e9) }), `<a:tile tx="${MAX_COORD}" ty="${MAX_COORD}" sx="${INT_MAX}" sy="${INT_MAX}" flip="none" algn="tl"/>`],
    ['ST_PositiveFixedPercentage a:alphaModFix', shape({ fill: { kind: 'blip', media: PNG_KEY, alpha: -7, mode: { kind: 'tile', tx: 0, ty: 0, sx: 100000, sy: 100000 } } }), '<a:alphaModFix amt="0"/>'],
    ['alphaModFix left out above 100000', shape({ fill: { kind: 'blip', media: PNG_KEY, alpha: 100001, mode: { kind: 'tile', tx: 0, ty: 0, sx: 100000, sy: 100000 } } }), `<a:blip r:embed="rId2"/>`],
    ['ST_LineWidth', connector({ line: { ...LINE, w: 30000000 } }), '<a:ln w="20116800" cap="flat">'],
    ['ST_LineWidth, low', connector({ line: { ...LINE, w: -5 } }), '<a:ln w="0" cap="flat">'],
    ['ST_PositivePercentage a:miter lim', connector({ line: { ...LINE, miterLim: -1 } }), '<a:miter lim="0"/>'],
    ['ST_PositivePercentage a:miter lim, high', connector({ line: { ...LINE, miterLim: 3e9 } }), `<a:miter lim="${INT_MAX}"/>`],
    ['ST_PositivePercentage a:ds, at least 1', connector({ line: { ...LINE, dash: [-5, 3e9] } }), `<a:custDash><a:ds d="1" sp="${INT_MAX}"/></a:custDash>`],
  ];

  it.each(cases)('%s', (_name, node, expected) => {
    expect(tree(node)).toContain(expected);
  });

  it('NaN is refused wherever a number is written', () => {
    const nan = Number.NaN;
    const refused: OxNode[] = [
      shape({ frame: { ...FRAME, x: nan } }),
      shape({ frame: { ...FRAME, w: nan } }),
      shape({ frame: { ...FRAME, rot: nan } }),
      shape({ frame: { ...FRAME, rot: Infinity } }),
      custom([path([['M', nan, 0], ['L', 1, 1]])]),
      custom([path([['M', 0, 0], ['L', 1, 1]], { w: nan })]),
      shape({ fill: { kind: 'solid', rgb: '000000', alpha: nan } }),
      shape({ fill: grad([stop(nan, '000000'), stop(0, '000000')]) }),
      shape({ fill: grad([stop(0, '000000'), stop(1, '000000')], { kind: 'lin', ang: nan, scaled: false }) }),
      connector({ line: { ...LINE, w: nan } }),
      connector({ line: { ...LINE, miterLim: nan } }),
      connector({ line: { ...LINE, dash: [nan, 1] } }),
    ];
    for (const node of refused) expect(() => tree(node)).toThrow(RangeError);
  });
});

describe('edgeShapesDeck', () => {
  const { slides, media } = edgeShapesDeck();
  const nodes = slides.flatMap((s) => s.nodes);
  const shapes = nodes.filter((n): n is OxShape => n.kind === 'shape');
  const lines = [...shapes.flatMap((s) => (s.line ? [s.line] : [])), ...nodes.filter((n): n is OxConnector => n.kind === 'line').map((c) => c.line)];
  const fills = shapes.map((s) => s.fill);
  const grads = [...fills, ...lines.map((l) => l.fill)].filter((f): f is Extract<OxFill, { kind: 'grad' }> => f.kind === 'grad');
  const paths = shapes.flatMap((s) => (s.geom.kind === 'custom' ? s.geom.paths : []));
  const draws = (p: OxPath) => p.cmds.some((c) => c[0] === 'L' || c[0] === 'C');
  const frames = nodes.map((n) => n.frame);
  const urls = nodes.flatMap((n) => (n.link?.kind === 'url' ? [n.link.url] : []));

  it('covers every case of the writer: geometries, caps, joins, dashes, fills, frames, paths, stops, clamps and links', () => {
    const covered: Record<string, boolean> = {
      'rect': shapes.some((s) => s.geom.kind === 'rect'),
      'custGeom': shapes.some((s) => s.geom.kind === 'custom'),
      'connector': nodes.some((n) => n.kind === 'line'),
      'cap flat, rnd, sq': ['flat', 'rnd', 'sq'].every((cap) => lines.some((l) => l.cap === cap)),
      'join round, bevel, miter': ['round', 'bevel', 'miter'].every((join) => lines.some((l) => l.join === join)),
      'dash solid': lines.some((l) => l.dash === null),
      'dash custom': lines.some((l) => l.dash !== null && l.dash.length % 2 === 0 && l.dash.some((v) => v > 0)),
      'dash all zeros': lines.some((l) => l.dash !== null && l.dash.length > 0 && l.dash.every((v) => v === 0)),
      'dash empty': lines.some((l) => l.dash !== null && l.dash.length === 0),
      'dash odd': lines.some((l) => l.dash !== null && l.dash.length % 2 === 1),
      'dash with a 0 among others': lines.some((l) => l.dash !== null && l.dash.some((v) => v <= 0) && l.dash.some((v) => v > 0)),
      'fill none, solid, lin, circle, stretch, tile': ['none', 'solid', 'lin', 'circle', 'stretch', 'tile'].every((k) =>
        fills.some((f) => f.kind === k || (f.kind === 'grad' && f.shade.kind === k) || (f.kind === 'blip' && f.mode.kind === k)),
      ),
      'line fill none, solid, grad': ['none', 'solid', 'grad'].every((k) => lines.some((l) => l.fill.kind === k)),
      'alpha 0': fills.some((f) => (f.kind === 'solid' || f.kind === 'blip') && f.alpha === 0),
      'picture alpha below 100000': fills.some((f) => f.kind === 'blip' && f.alpha > 0 && f.alpha < 100000),
      'frame w 0': frames.some((f) => f.w === 0 && f.h > 0),
      'frame h 0': frames.some((f) => f.h === 0 && f.w > 0),
      'frame w and h 0': frames.some((f) => f.w === 0 && f.h === 0),
      'rot': frames.some((f) => f.rot > 0 && f.rot < 21600000),
      'rot outside 0..21599999': frames.some((f) => f.rot < 0 || f.rot >= 21600000),
      'flipH': frames.some((f) => f.flipH && !f.flipV),
      'flipV': frames.some((f) => f.flipV && !f.flipH),
      'flipH and flipV': frames.some((f) => f.flipH && f.flipV),
      'path dropped': shapes.some((s) => s.geom.kind === 'custom' && s.geom.paths.some(draws) && !s.geom.paths.every(draws)),
      'shape left with no path': shapes.some((s) => s.geom.kind === 'custom' && !s.geom.paths.some(draws)),
      'one-point geometry': paths.some((p) => p.cmds.length === 2 && p.cmds[1]![0] === 'L' && p.cmds[0]!.slice(1).join() === p.cmds[1]!.slice(1).join()),
      'path fill none': paths.some((p) => !p.fill),
      'path stroke 0': paths.some((p) => !p.stroke),
      'cubic': paths.some((p) => p.cmds.some((c) => c[0] === 'C')),
      'gradient one stop': grads.some((g) => g.stops.length === 1),
      'gradient repeated positions': grads.some((g) => new Set(g.stops.map((s) => s.pos)).size < g.stops.length),
      'gradient stops out of order': grads.some((g) => g.stops.some((s, i) => i > 0 && s.pos < g.stops[i - 1]!.pos)),
      'clamp a:pt': paths.some((p) => p.cmds.some((c) => c.slice(1).some((v) => typeof v === 'number' && Math.abs(v) > 2147483647))),
      'clamp ST_PositiveCoordinate': paths.some((p) => p.w > 2147483647),
      'clamp ST_PositiveFixedPercentage': grads.some((g) => g.stops.some((s) => s.pos < 0 || s.pos > 100000)),
      'clamp ST_LineWidth': lines.some((l) => l.w > 20116800),
      'clamp ST_PositivePercentage': lines.some((l) => l.miterLim < 0 || (l.dash ?? []).some((v) => v < 0)),
      'url with a space': urls.some((u) => u.includes(' ')),
      'url with non-ASCII': urls.some((u) => /[^\x00-\x7f]/.test(u)),
      'slide link': nodes.some((n) => n.link?.kind === 'slide'),
    };
    expect(Object.entries(covered).filter(([, yes]) => !yes).map(([name]) => name)).toEqual([]);
  });

  it('writes, its picture a real PNG named by its SHA-256, and drops only the shapes left with no path', () => {
    expect([...media.keys()]).toHaveLength(1);
    for (const [key, { bytes, mime }] of media) {
      expect(mime).toBe('image/png');
      expect(key).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const files = unzipSync(writePptx(EDGE_SIZE, slides, media));
    let written = 0; // the nodes, not the group shape (id 1) every tree starts with
    for (let n = 1; n <= slides.length; n++) written += (strFromU8(files[`ppt/slides/slide${n}.xml`]!).match(/<p:cNvPr id="(?!1")\d+"/g) ?? []).length;
    const empty = shapes.filter((s) => s.geom.kind === 'custom' && !s.geom.paths.some(draws)).length;
    expect(written).toBe(nodes.length - empty);
  });
});
