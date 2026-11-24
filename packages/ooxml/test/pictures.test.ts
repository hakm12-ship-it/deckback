import { describe, expect, it } from 'vitest';
import { FRAME, ids, picture, PNG_KEY, relList, shape, slideParts, textBox, run, tree } from './helpers/slides';

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

/** The `p:blipFill` of the one picture of a deck. */
function blipFill(over: Parameters<typeof picture>[0]): string {
  return /<p:blipFill>.*<\/p:blipFill>/.exec(tree(picture(over)))![0];
}

describe('pictures', () => {
  it('a picture is a p:pic of nvPicPr, blipFill (a:blip, a:stretch/a:fillRect) and spPr (xfrm, rect), with no line', () => {
    const { tree: t, rels } = slideParts([{ nodes: [picture()], background: null }]);
    expect(t).toBe(
      '<p:pic><p:nvPicPr><p:cNvPr id="2" name="pdf:p1:z5 picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
        '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
        '<p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="635000"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
    );
    expect(relList(rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml', `rId2 image ../media/${PNG_KEY}.png`]);
  });

  it('a picture with a line (M5 Task 5, its border) has the a:ln after its geometry in p:spPr, as a shape has', () => {
    const line = { w: 25400, fill: { kind: 'solid' as const, rgb: '7030A0', alpha: 100000 }, cap: 'flat' as const, join: 'round' as const, miterLim: 800000, dash: [400000, 300000] };
    const t = tree(picture({ line }));
    expect(/<p:spPr>.*<\/p:spPr>/.exec(t)![0]).toBe(
      '<p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
        '<a:ln w="25400" cap="flat"><a:solidFill><a:srgbClr val="7030A0"/></a:solidFill><a:custDash><a:ds d="400000" sp="300000"/></a:custDash><a:round/></a:ln></p:spPr>',
    );
    expect(tree(picture({ line: null }))).not.toContain('<a:ln');
  });

  it('a:blip holds a:alphaModFix below 100000, clamped to 0..100000', () => {
    expect(blipFill({ alpha: 50000 })).toContain('<a:blip r:embed="rId2"><a:alphaModFix amt="50000"/></a:blip><a:stretch>');
    expect(blipFill({ alpha: 0 })).toContain('<a:alphaModFix amt="0"/>');
    expect(blipFill({ alpha: -7 })).toContain('<a:alphaModFix amt="0"/>');
    expect(blipFill({ alpha: 100000 })).toContain('<a:blip r:embed="rId2"/>');
    expect(blipFill({ alpha: 150000 })).toContain('<a:blip r:embed="rId2"/>');
    expect(() => tree(picture({ alpha: Number.NaN }))).toThrow(RangeError);
  });

  it('a:srcRect, when set, lies between a:blip and a:stretch, its zero sides left out and each side an ST_Percentage', () => {
    expect(blipFill({ srcRect: [10000, -5000, 0, 2000] })).toBe(
      '<p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" t="-5000" b="2000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>',
    );
    expect(blipFill({ srcRect: [0, 0, 0, 0], alpha: 40000 })).toBe(
      '<p:blipFill><a:blip r:embed="rId2"><a:alphaModFix amt="40000"/></a:blip><a:srcRect/><a:stretch><a:fillRect/></a:stretch></p:blipFill>',
    );
    expect(blipFill({ srcRect: [3e9, -3e9, 12.5, -12.5] })).toContain(`<a:srcRect l="${INT_MAX}" t="${INT_MIN}" r="13" b="-13"/>`);
    expect(blipFill({ srcRect: null })).not.toContain('srcRect');
    expect(() => tree(picture({ srcRect: [Number.NaN, 0, 0, 0] }))).toThrow(RangeError);
  });

  it('the frame takes every flip and rotation', () => {
    const xfrm = (frame: Partial<typeof FRAME>) => /<a:xfrm[^>]*>/.exec(tree(picture({ frame: { ...FRAME, ...frame } })))![0];
    expect(xfrm({ flipH: true })).toBe('<a:xfrm flipH="1">');
    expect(xfrm({ flipV: true })).toBe('<a:xfrm flipV="1">');
    expect(xfrm({ rot: 2700000, flipH: true, flipV: true })).toBe('<a:xfrm rot="2700000" flipH="1" flipV="1">');
    expect(xfrm({ rot: -5400000 })).toBe('<a:xfrm rot="16200000">');
    expect(() => tree(picture({ frame: { ...FRAME, w: -1 } }))).toThrow(RangeError);
  });

  it('pictures of one media share its relationship; a key the writer was not given is refused', () => {
    const { tree: t, rels } = slideParts([{ nodes: [picture({ name: 'a' }), shape({ name: 's' }), picture({ name: 'b' })], background: null }]);
    expect(t.match(/r:embed="rId2"/g)).toHaveLength(2);
    expect(relList(rels)).toHaveLength(2);
    expect(ids(t)).toEqual(['2 a', '3 s', '4 b']);
    expect(() => tree(picture({ media: 'f'.repeat(64) }))).toThrow(/media key/);
  });

  it('ids count up over shapes, text boxes and pictures in z-order', () => {
    expect(ids(tree(picture({ name: 'p' }), textBox([run('x')], { name: 't' }), shape({ name: 's' })))).toEqual(['2 p', '3 t', '4 s']);
  });
});
