import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { emojiUnit, hasPictureChar, paragraphBullet, PptxWriter, type OxFill, type OxRun, type OxTextBox } from '../src';
import { EDGE_SIZE, edgeTextDeck } from './edge-decks';
import { connector, FRAME, ids, LINE, para, PNG_KEY, relList, run, shape, slideParts, textBox, tree } from './helpers/slides';

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

/** The `a:r` elements of the one text box of a deck holding `runs`. */
function runs(...r: OxRun[]): string[] {
  return tree(textBox(r)).match(/<a:r>.*?<\/a:r>/gs) ?? [];
}

/** The `a:rPr` start tag of the one run of a deck. */
function rPr(over: Partial<OxRun>): string {
  return /<a:rPr [^>]*>/.exec(runs(run('x', over))[0]!)![0];
}

/** What a run's `a:rPr` holds. */
function rPrBody(over: Partial<OxRun>): string {
  return /<a:rPr [^>]*>(.*)<\/a:rPr>/.exec(runs(run('x', over))[0]!)![1]!;
}

describe('text boxes', () => {
  it('a text box is a p:sp with txBox="1", rect, noFill and a p:txBody of bodyPr, lstStyle and one a:p', () => {
    expect(tree(textBox([run('Hello')]))).toBe(
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="pdf:p1:z3 text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
        '<p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="635000"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
        '<p:txBody><a:bodyPr vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr>' +
        '<a:lstStyle/><a:p>' +
        '<a:r><a:rPr lang="en-US" sz="1800" b="0" i="0" spc="0" baseline="0" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr>' +
        '<a:t>Hello</a:t></a:r>' +
        '<a:endParaRPr lang="en-US" sz="1800" b="0" i="0" dirty="0"/></a:p></p:txBody></p:sp>',
    );
  });

  it('M8 round 1a: warp textPlain writes a:prstTxWarp before a:noAutofit (PowerPoint then exports invisible text as WordArt)', () => {
    const t = tree(textBox([run('x')], { warp: 'textPlain' }));
    expect(t).toContain('anchor="t"><a:prstTxWarp prst="textPlain"><a:avLst/></a:prstTxWarp><a:noAutofit/></a:bodyPr>');
    expect(tree(textBox([run('x')]))).not.toContain('prstTxWarp');
    expect(tree(textBox([run('x')], { warp: null }))).not.toContain('prstTxWarp');
  });

  it('bodyPr writes vert as given, horz or eaVert', () => {
    expect(tree(textBox([run('세로')], { vert: 'eaVert' }))).toContain(
      '<a:bodyPr vert="eaVert" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr>',
    );
  });

  it('the frame takes rot and flips like any shape', () => {
    expect(tree(textBox([run('x')], { frame: { ...FRAME, rot: -5400000, flipH: true } }))).toContain('<a:xfrm rot="16200000" flipH="1">');
    expect(() => tree(textBox([run('x')], { frame: { ...FRAME, w: -1 } }))).toThrow(RangeError);
    expect(() => tree(textBox([], { frame: { ...FRAME, h: -1 } }))).toThrow(RangeError); // refused even when it would be dropped
  });

  it('one a:p holds every run in order, and a:endParaRPr copies the last written run\'s lang, sz, b and i', () => {
    const t = tree(textBox([run('a', { sz: 1200 }), run('b', { sz: 2400 }), run('한', { sz: 3600 }), run('', { sz: 4800 })]));
    expect(t.match(/<a:p>/g)).toHaveLength(1);
    expect([...t.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])).toEqual(['a', 'b', '한']);
    expect(t).toContain('</a:r><a:endParaRPr lang="ko-KR" sz="3600" b="0" i="0" dirty="0"/></a:p>');
    // as PowerPoint writes it: the mark is in the run's weight and slant (ruling M3-R37)
    expect(tree(textBox([run('a'), run('b', { b: true, i: true })]))).toContain('</a:r><a:endParaRPr lang="en-US" sz="1800" b="1" i="1" dirty="0"/></a:p>');
  });

  it("a:endParaRPr names the last written run's typefaces: the paragraph mark's font is in PowerPoint's line height", () => {
    // Without them the mark takes the theme's font, and PowerPoint draws the line's baseline elsewhere (Task 8: up to
    // 2.1 pt higher for Gothic A1 at 36 pt in the probe), so the baseline calibration would not hold.
    const t = tree(textBox([run('a', { latin: 'Calibri' }), run('한', { latin: 'Gothic A1', ea: '고딕 A1', cs: 'Gothic A1' }), run('')]));
    expect(t).toContain(
      '</a:r><a:endParaRPr lang="ko-KR" sz="1800" b="0" i="0" dirty="0"><a:latin typeface="Gothic A1"/><a:ea typeface="고딕 A1"/><a:cs typeface="Gothic A1"/></a:endParaRPr></a:p>',
    );
    expect(tree(textBox([run('x', { ea: 'A&B' })]))).toContain('<a:endParaRPr lang="en-US" sz="1800" b="0" i="0" dirty="0"><a:ea typeface="A&amp;B"/></a:endParaRPr>');
  });

  it('an empty typeface is never written, on the run or on the mark', () => {
    const t = tree(textBox([run('x', { latin: '', ea: 'E', cs: '' })]));
    expect(t).toContain('<a:rPr lang="en-US" sz="1800" b="0" i="0" spc="0" baseline="0" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:ea typeface="E"/></a:rPr>');
    expect(t).toContain('<a:endParaRPr lang="en-US" sz="1800" b="0" i="0" dirty="0"><a:ea typeface="E"/></a:endParaRPr>');
    expect(tree(textBox([run('x', { latin: '', ea: '', cs: '' })]))).toContain('<a:endParaRPr lang="en-US" sz="1800" b="0" i="0" dirty="0"/>');
    expect(t).not.toContain('typeface=""');
  });

  it("the baseline calibration's text boxes are the writer's own, byte for byte (ruling M3-R37)", () => {
    // harness/fonts/test_baseline_calib.py checks the calibration deck against the same file
    type Case = { box: { id: number; name: string; frame: number[]; runs: Pick<OxRun, 'text' | 'sz' | 'b' | 'i' | 'latin' | 'ea' | 'cs'>[] }; xml: string };
    const { cases } = JSON.parse(readFileSync(new URL('./calibration-text-box.json', import.meta.url), 'utf8')) as { cases: Case[] };
    expect(cases.map((c) => c.box.id)).toEqual(cases.map((_, i) => i + 2)); // ids count up from 2 in z-order
    // an italic run and a box of several runs (ledger L145): drift in the mark's i or lang fails here
    expect(cases.some((c) => c.box.runs.some((r) => r.i))).toBe(true);
    expect(cases.some((c) => c.box.runs.length > 1)).toBe(true);
    const boxes = cases.map(({ box }) => {
      const [x, y, w, h] = box.frame as [number, number, number, number];
      return textBox(box.runs.map((r) => run(r.text, r)), { name: box.name, frame: { x, y, w, h, rot: 0, flipH: false, flipV: false } });
    });
    expect(tree(...boxes)).toBe(cases.map((c) => c.xml).join(''));
  });

  it('ids count up from 2 over shapes, connectors and text boxes in z-order', () => {
    expect(ids(tree(shape({ name: 's' }), textBox([run('x')], { name: 't' }), connector({ name: 'l' })))).toEqual(['2 s', '3 t', '4 l']);
  });
});

describe('paragraphs (M4 Task 1)', () => {
  it('a box of several paragraphs: one a:p each, in order, each closed by the a:endParaRPr of its own last written run', () => {
    const t = tree(textBox([], { paras: [para([run('a', { sz: 1200 })]), para([run('한', { sz: 2400 }), run('b', { sz: 3600, b: true, latin: 'X' })])] }));
    expect(t.match(/<a:p>/g)).toHaveLength(2);
    expect(t).toContain('<a:t>a</a:t></a:r><a:endParaRPr lang="en-US" sz="1200" b="0" i="0" dirty="0"/></a:p><a:p><a:r>');
    expect(t).toContain('<a:t>b</a:t></a:r><a:endParaRPr lang="en-US" sz="3600" b="1" i="0" dirty="0"><a:latin typeface="X"/></a:endParaRPr></a:p></p:txBody>');
  });

  it('a:pPr only where needed: marL, then a:lnSpc (spcPts or spcPct)', () => {
    expect(tree(textBox([run('x')]))).not.toContain('<a:pPr');
    const t = tree(textBox([], { paras: [para([run('x')], { marL: 12700, lnSpc: { kind: 'pts', val: 2400 } })] }));
    expect(t).toContain('<a:p><a:pPr marL="12700"><a:lnSpc><a:spcPts val="2400"/></a:lnSpc></a:pPr><a:r>');
    expect(tree(textBox([], { paras: [para([run('x')], { lnSpc: { kind: 'pct', val: 90000 } })] }))).toContain(
      '<a:p><a:pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr><a:r>',
    );
    expect(tree(textBox([], { paras: [para([run('x')], { marL: 25400 })] }))).toContain('<a:p><a:pPr marL="25400"/><a:r>');
  });

  it('a paragraph with no written run is left out; a box with none is not written', () => {
    const t = tree(textBox([], { paras: [para([run('')]), para([run('a')]), para([run('\u0001')], { marL: 12700 })] }));
    expect(t.match(/<a:p>/g)).toHaveLength(1);
    expect(t).not.toContain('marL');
    expect(tree(textBox([], { paras: [para([run('')]), para([])] }))).toBe('');
    expect(tree(textBox([], { paras: [] }))).toBe('');
  });

  it('margin and spacing are whole numbers held to their schema ranges; NaN is refused', () => {
    const t = tree(
      textBox([], {
        paras: [para([run('x')], { marL: 6e7, lnSpc: { kind: 'pts', val: 1e9 } }), para([run('y')], { marL: -5, lnSpc: { kind: 'pct', val: 1e9 } }), para([run('z')], { marL: 12.5 })],
      }),
    );
    expect(t).toContain('<a:pPr marL="51206400"><a:lnSpc><a:spcPts val="158400"/></a:lnSpc></a:pPr>');
    expect(t).toContain('<a:p><a:pPr><a:lnSpc><a:spcPct val="13200000"/></a:lnSpc></a:pPr>'); // marL -5 is held to 0, not written
    expect(t).toContain('<a:p><a:pPr marL="13"/>');
    const bad = [{ marL: Number.NaN }, { lnSpc: { kind: 'pts' as const, val: Number.NaN } }, { lnSpc: { kind: 'pct' as const, val: Number.NaN } }];
    for (const over of bad) expect(() => tree(textBox([], { paras: [para([run('x')], over)] })), JSON.stringify(over)).toThrow(RangeError);
  });

  it('fontAlgn (ST_TextFontAlignType, M4b Task 1) is an a:pPr attribute after marL; none or null writes none; another value is refused', () => {
    expect(tree(textBox([], { paras: [para([run('x')], { fontAlgn: 'base' })] }))).toContain('<a:p><a:pPr fontAlgn="base"/><a:r>');
    expect(tree(textBox([], { paras: [para([run('x')], { marL: 12700, fontAlgn: 'base', lnSpc: { kind: 'pts', val: 2400 } })] }))).toContain(
      '<a:p><a:pPr marL="12700" fontAlgn="base"><a:lnSpc><a:spcPts val="2400"/></a:lnSpc></a:pPr><a:r>',
    );
    for (const v of ['auto', 't', 'ctr', 'b'] as const) expect(tree(textBox([], { paras: [para([run('x')], { fontAlgn: v })] }))).toContain(`<a:pPr fontAlgn="${v}"/>`);
    expect(tree(textBox([], { paras: [para([run('x')], { fontAlgn: null })] }))).not.toContain('<a:pPr');
    expect(() => tree(textBox([], { paras: [para([run('x')], { fontAlgn: 'middle' as never })] }))).toThrow(RangeError);
  });
});

describe('runs', () => {
  it('a run is a:r with a:rPr lang sz b i spc baseline dirty="0", then a:ln, the fill, a:latin, a:ea and a:cs', () => {
    const full = run('Text', { sz: 2400, b: true, i: true, spc: -150, baseline: 30000, line: LINE, latin: 'Calibri', ea: 'Malgun Gothic', cs: 'Arial' });
    expect(runs(full)).toEqual([
      '<a:r><a:rPr lang="en-US" sz="2400" b="1" i="1" spc="-150" baseline="30000" dirty="0">' +
        '<a:ln w="12700" cap="flat"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
        '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>' +
        '<a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface="Arial"/></a:rPr><a:t>Text</a:t></a:r>',
    ]);
    // no line: no a:ln (text has no outline by default); a typeface left null leaves its element out
    expect(rPrBody({ ea: 'Batang' })).toBe('<a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:ea typeface="Batang"/>');
  });

  it('lang is ko-KR when the text has Hangul (syllables, jamo, compatibility and halfwidth jamo), else en-US', () => {
    for (const text of ['한글', 'Korean 텍스트 mixed', 'ᄀ', 'ᅡ', 'ㄱ', 'ꥠ', 'ힰ', 'ﾡ', 'a\u0001한']) {
      expect(rPr({ text }), text).toContain('lang="ko-KR"');
    }
    for (const text of ['Latin', '日本語', 'かな', '中文', 'é', '\u{1F600}', '①']) {
      expect(rPr({ text }), text).toContain('lang="en-US"');
    }
  });

  it('the fill is any of none, solid, gradient and picture; a:ln takes no picture', () => {
    expect(rPrBody({ fill: { kind: 'none' } })).toBe('<a:noFill/>');
    const grad: OxFill = { kind: 'grad', stops: [{ pos: 0, rgb: 'FF0000', alpha: 100000 }, { pos: 100000, rgb: '0000FF', alpha: 100000 }], shade: { kind: 'lin', ang: 0, scaled: false }, rotWithShape: true };
    expect(rPrBody({ fill: grad })).toMatch(/^<a:gradFill rotWithShape="1">.*<\/a:gradFill>$/);
    const blip: OxFill = { kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
    const { tree: t, rels } = slideParts([{ nodes: [textBox([run('x', { fill: blip })])], background: null }]);
    expect(t).toContain('<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>');
    expect(relList(rels)).toContain(`rId2 image ../media/${PNG_KEY}.png`);
    expect(() => runs(run('x', { line: { ...LINE, fill: blip } }))).toThrow(/picture/);
    // an outline without fill: the text drawn as its outline only
    expect(rPrBody({ fill: { kind: 'none' }, line: LINE })).toMatch(/^<a:ln w="12700" cap="flat">.*<\/a:ln><a:noFill\/>$/);
  });

  it('the text drops the characters XML refuses, keeps tab, writes LF and CR as a space, and escapes the rest', () => {
    expect(runs(run('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\uFFFEg\uFFFFh\uD800i\uDFFFj'))[0]).toContain('<a:t>abcdefghij</a:t>');
    expect(runs(run('<a & "b" \'c\'>'))[0]).toContain('<a:t>&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;</a:t>');
    // PowerPoint breaks the line at LF and at CR (which XML reads as LF), and a run is one line: each is a space
    expect(runs(run('a\tb\nc\rd\r\ne'))[0]).toContain('<a:t>a\tb c d  e</a:t>');
    expect(runs(run('\n'))[0]).toContain('<a:t> </a:t>'); // a space is text: the run is written
    expect(runs(run('\u{1F600}\uD83D'))[0]).toContain('<a:t>\u{1F600}</a:t>'); // a pair stays; the lone half goes
  });

  it('typefaces are written as given, escaped, without the characters XML refuses; an empty one is not written', () => {
    expect(rPrBody({ latin: 'A&B <"x">', ea: 'Ma\u0001lgun\uD800', cs: '' })).toBe(
      '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>' + '<a:latin typeface="A&amp;B &lt;&quot;x&quot;&gt;"/><a:ea typeface="Malgun"/>',
    );
    expect(rPrBody({ latin: '\u0001', ea: null, cs: null })).toBe('<a:solidFill><a:srgbClr val="000000"/></a:solidFill>');
  });

  it("a symbol font's run (M8 round 1a) names its font in a:sym after a:cs, as PowerPoint writes a Wingdings character", () => {
    const body = rPrBody({ text: '\uf0d8', latin: 'Wingdings', ea: 'Wingdings', cs: 'Wingdings', sym: 'Wingdings' });
    expect(body).toBe(
      '<a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Wingdings"/><a:ea typeface="Wingdings"/>' +
        '<a:cs typeface="Wingdings"/><a:sym typeface="Wingdings" pitchFamily="2" charset="2"/>',
    );
    expect(runs(run('\uf0d8', { sym: 'Wingdings' }))[0]).toContain('<a:t>\uf0d8</a:t>');
    // none, null or empty: no a:sym
    for (const sym of [undefined, null, '', '\u0001']) expect(rPrBody({ latin: 'Arial', ...(sym === undefined ? {} : { sym }) })).not.toContain('a:sym');
  });

  it('an empty run is not written, nor one left empty by the characters XML refuses', () => {
    expect(runs(run(''), run('a'), run('\u0001\uD800'), run('b'), run(''))).toEqual([
      expect.stringContaining('<a:t>a</a:t>'),
      expect.stringContaining('<a:t>b</a:t>'),
    ]);
    expect(runs(run(' '))).toHaveLength(1); // a space is text
  });

  it('a box with no run left is not written: it takes no id and adds no relationship', () => {
    const blip: OxFill = { kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
    const nodes = [
      shape({ name: 'a' }),
      textBox([], { name: 'no runs' }),
      textBox([run('', { fill: blip }), run('\u0002')], { name: 'empty runs', link: { kind: 'url', url: 'https://example.com/' } }),
      textBox([run('x')], { name: 'b' }),
    ];
    const { tree: t, rels } = slideParts([{ nodes, background: null }]);
    expect(ids(t)).toEqual(['2 a', '3 b']);
    expect(relList(rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml']);
  });

  it('a 10,000-character run is written whole', () => {
    const text = 'abcdefghij'.repeat(1000);
    expect(runs(run(text))[0]).toContain(`<a:t>${text}</a:t>`);
  });

  it('writes no run-level a:hlinkClick (ruling M3-R1): a box\'s link is on its cNvPr', () => {
    const t = tree(textBox([run('a'), run('b')], { link: { kind: 'slide', slide: 1 } }));
    expect(t.match(/<a:hlinkClick /g)).toHaveLength(1);
    expect(t).toContain('<p:cNvPr id="2" name="pdf:p1:z3 text"><a:hlinkClick r:id="rId2" action="ppaction://hlinksldjump"/></p:cNvPr>');
  });
});

describe("a list label PowerPoint exports as a picture in a run (M5 Task 5, ruling M5-R15)", () => {
  const SOLID: OxFill = { kind: 'solid', rgb: '262626', alpha: 100000 };
  const face = { latin: 'Pretendard', ea: 'Pretendard', cs: 'Pretendard' };
  /** The one a:p of a box of `runs`, a list label's paragraph (`label`) unless said, its marL as given. */
  const paragraph = (r: OxRun[], marL = 0, label = true): string =>
    /<a:p>.*<\/a:p>/s.exec(tree(textBox([], { paras: [para(r, { marL, label })] })))![0];

  it("a labelled paragraph that is only such a character is its bullet (a:buChar), in the run's colour, size and font, and a space", () => {
    expect(paragraph([run('\u25b6', { sz: 1200, fill: SOLID, ...face })])).toBe(
      '<a:p><a:pPr><a:buClr><a:srgbClr val="262626"/></a:buClr><a:buSzPts val="1200"/><a:buFont typeface="Pretendard"/>' +
        '<a:buChar char="\u25b6"/></a:pPr>' +
        '<a:r><a:rPr lang="en-US" sz="1200" b="0" i="0" spc="0" baseline="0" dirty="0"><a:solidFill><a:srgbClr val="262626"/></a:solidFill>' +
        '<a:latin typeface="Pretendard"/><a:ea typeface="Pretendard"/><a:cs typeface="Pretendard"/></a:rPr><a:t> </a:t></a:r>' +
        '<a:endParaRPr lang="en-US" sz="1200" b="0" i="0" dirty="0"><a:latin typeface="Pretendard"/><a:ea typeface="Pretendard"/><a:cs typeface="Pretendard"/></a:endParaRPr></a:p>',
    );
  });

  it('first in a longer run, the rest of the run follows the bullet; its margin, line spacing and the other runs stay', () => {
    const p = paragraph([run('\u25b6 \uae00\uba38\ub9ac', { sz: 2400, fill: SOLID, ...face }), run(' item', { sz: 2004, fill: SOLID, ...face })], 25400);
    expect(p).toMatch(/^<a:p><a:pPr marL="25400"><a:buClr><a:srgbClr val="262626"\/><\/a:buClr><a:buSzPts val="2400"\/><a:buFont typeface="Pretendard"\/><a:buChar char="\u25b6"\/><\/a:pPr>/);
    expect([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])).toEqual([' \uae00\uba38\ub9ac', ' item']);
    // its alpha goes with its colour
    expect(paragraph([run('\u25b6', { fill: { kind: 'solid', rgb: 'FF0000', alpha: 40000 }, ...face })])).toContain('<a:buClr><a:srgbClr val="FF0000"><a:alpha val="40000"/></a:srgbClr></a:buClr>');
    // a supplementary-plane emoji (a surrogate pair) is one character
    expect(paragraph([run('\ud83d\ude00 x', { fill: SOLID, ...face })])).toContain('<a:buChar char="\ud83d\ude00"/>');
  });

  it("a paragraph that is no list label keeps the character in a:t (content: '\u2714 Yes', ruling M5-R15)", () => {
    const p = paragraph([run('\u2714 Yes', { fill: SOLID, ...face })], 0, false);
    expect(p).not.toContain('buChar');
    expect(p).toContain('<a:t>\u2714 Yes</a:t>');
    expect(paragraphBullet(para([run('\u2714 Yes', { fill: SOLID, ...face })]))).toBeNull();
    expect(paragraphBullet(para([run('\u25b6', { fill: SOLID, ...face })], { label: true }))).toBe('\u25b6');
  });

  it('an emoji sequence is one unit, never split: a flag, ZWJ, a skin tone, VS15 or VS16, a keycap, a tag sequence', () => {
    const sequences = {
      flag: '\ud83c\uddf0\ud83c\uddf7', // two regional indicators
      zwj: '\u2764\u200d\ud83d\udd25',
      skin: '\ud83d\udc4d\ud83c\udffd',
      vs16: '\u25b6\ufe0f',
      vs15: '\u25b6\ufe0e',
      keycap: '\u25b6\u20e3',
      tags: '\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc65\udb40\udc6e\udb40\udc67\udb40\udc7f',
    };
    for (const [kind, text] of Object.entries(sequences)) {
      const p = paragraph([run(text, { fill: SOLID, ...face })]);
      expect(p, kind).not.toContain('buChar');
      expect(p, kind).toContain(`<a:t>${text}</a:t>`);
      expect(emojiUnit(text), kind).toBeNull();
    }
    expect(emojiUnit('\ud83c\uddf0 x')).toBe('\ud83c\uddf0'); // one regional indicator alone is a character of its own
    expect(emojiUnit('\u25b6 x')).toBe('\u25b6');
    expect(emojiUnit('\u25a0 x')).toBeNull(); // not drawn as a picture
  });

  it('a run that is not plain keeps the character: another character, spacing, rise, no solid fill, an outline, a link, no typeface, bold or italic', () => {
    const plain = (text: string, over: Partial<OxRun> = {}) => paragraph([run(text, { fill: SOLID, ...face, ...over })]);
    for (const text of ['\u25a0', '\u2022', '\u00a9', 'A\u25b6']) expect(plain(text)).not.toContain('buChar');
    expect(plain('\u25b6', { spc: 100 })).not.toContain('buChar'); // a bullet has no spacing
    expect(plain('\u25b6', { baseline: 30000 })).not.toContain('buChar');
    expect(plain('\u25b6', { fill: { kind: 'none' } })).not.toContain('buChar');
    expect(plain('\u25b6', { line: LINE })).not.toContain('buChar');
    expect(plain('\u25b6', { link: { kind: 'url', url: 'https://example.com/' } })).not.toContain('buChar');
    expect(plain('\u25b6', { latin: null, ea: null, cs: null })).not.toContain('buChar');
    expect(plain('\u25b6', { b: true })).not.toContain('buChar'); // a bullet takes no bold or italic of its own
    expect(plain('\u25b6', { i: true })).not.toContain('buChar');
  });

  it('hasPictureChar: whether text holds a character PowerPoint exports as a picture in a run', () => {
    expect(hasPictureChar('Level \u25b6 4')).toBe(true);
    expect(hasPictureChar('\u25a0 \u2022 \u00a9 abc \uac00')).toBe(false);
  });
});

describe('run numbers are clamped to their ST type range', () => {
  const cases: [string, Partial<OxRun>, string][] = [
    ['ST_TextFontSize sz, low', { sz: 50 }, 'sz="100"'],
    ['ST_TextFontSize sz, high', { sz: 500000 }, 'sz="400000"'],
    ['ST_TextFontSize sz, half away from zero', { sz: 1150.5 }, 'sz="1151"'],
    ['ST_TextPoint spc, low', { spc: -500000 }, 'spc="-400000"'],
    ['ST_TextPoint spc, high', { spc: 500000 }, 'spc="400000"'],
    ['ST_TextPoint spc, half away from zero', { spc: -12.5 }, 'spc="-13"'],
    ['ST_Percentage baseline, low', { baseline: -3e9 }, `baseline="${INT_MIN}"`],
    ['ST_Percentage baseline, high', { baseline: 3e9 }, `baseline="${INT_MAX}"`],
  ];

  it.each(cases)('%s', (_name, over, expected) => {
    expect(rPr(over)).toContain(expected);
  });

  it('the end paragraph mark takes the clamped size', () => {
    expect(tree(textBox([run('x', { sz: 0 })]))).toContain('<a:endParaRPr lang="en-US" sz="100" b="0" i="0" dirty="0"/>');
  });

  it('NaN is refused', () => {
    for (const over of [{ sz: Number.NaN }, { spc: Number.NaN }, { baseline: Number.NaN }]) {
      expect(() => rPr(over), JSON.stringify(over)).toThrow(RangeError);
    }
  });
});

describe('edgeTextDeck', () => {
  const { slides, media } = edgeTextDeck();
  const nodes = slides.flatMap((s) => s.nodes);
  const boxes = nodes.filter((n): n is OxTextBox => n.kind === 'text');
  const allRuns = boxes.flatMap((b) => b.paras.flatMap((p) => p.runs));
  const allParas = boxes.flatMap((b) => b.paras);
  const writesNothing = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/g, '') === '';
  const pictures = nodes.filter((n) => n.kind === 'picture');
  const links = nodes.flatMap((n) => (n.link ? [n.link] : []));
  const urls = links.flatMap((l) => (l.kind === 'url' ? [l.url] : []));
  const protocolOf = (u: string) => {
    try {
      return new URL(u).protocol;
    } catch {
      return null;
    }
  };
  const rejected = (u: string) => protocolOf(u) === null;
  const refusedScheme = (u: string) => !rejected(u) && !['http:', 'https:', 'ftp:', 'mailto:', 'tel:'].includes(protocolOf(u)!);

  it('covers the cases of the brief and the normalisation rules of text, pictures and links', () => {
    const covered: Record<string, boolean> = {
      'control characters XML refuses': allRuns.some((r) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(r.text)),
      'tab, LF and CR': allRuns.some((r) => r.text.includes('\t') && r.text.includes('\n') && r.text.includes('\r')),
      'a lone surrogate': allRuns.some((r) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.text)),
      'Korean with Latin in one run': allRuns.some((r) => /[가-힣]/.test(r.text) && /[A-Za-z]/.test(r.text)),
      'spc at its low extreme': allRuns.some((r) => r.spc <= -400000),
      'spc at its high extreme': allRuns.some((r) => r.spc >= 400000),
      'baseline at its low extreme': allRuns.some((r) => r.baseline <= INT_MIN),
      'baseline at its high extreme': allRuns.some((r) => r.baseline >= INT_MAX),
      'sz at both extremes': allRuns.some((r) => r.sz <= 100) && allRuns.some((r) => r.sz >= 400000),
      'vert eaVert': boxes.some((b) => b.vert === 'eaVert'),
      'a 10,000-character run': allRuns.some((r) => r.text.length >= 10000),
      'bold, italic, both': allRuns.some((r) => r.b && !r.i) && allRuns.some((r) => r.i && !r.b) && allRuns.some((r) => r.b && r.i),
      'run fill none, solid, grad, blip': ['none', 'solid', 'grad', 'blip'].every((k) => allRuns.some((r) => r.fill.kind === k)),
      'run outline': allRuns.some((r) => r.line !== null),
      'typefaces latin, ea, cs': allRuns.some((r) => r.latin !== null && r.ea !== null && r.cs !== null),
      'an empty run': allRuns.some((r) => r.text === ''),
      'a run only of refused characters': allRuns.some((r) => r.text !== '' && r.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g, '') === ''),
      'a box with no runs': boxes.some((b) => b.paras.every((p) => p.runs.length === 0)),
      'a box of several paragraphs': boxes.some((b) => b.paras.length > 1),
      'a paragraph margin, exact and percent spacing':
        allParas.some((p) => p.marL > 0) && allParas.some((p) => p.lnSpc?.kind === 'pts') && allParas.some((p) => p.lnSpc?.kind === 'pct'),
      'margin and spacing past their ranges':
        allParas.some((p) => p.marL > 51206400) &&
        allParas.some((p) => p.lnSpc?.kind === 'pts' && p.lnSpc.val > 158400) &&
        allParas.some((p) => p.lnSpc?.kind === 'pct' && p.lnSpc.val > 13200000),
      'a paragraph of nothing written': allParas.some((p) => p.runs.length > 0 && p.runs.every((r) => writesNothing(r.text))),
      'a paragraph aligned on the baseline (fontAlgn)': allParas.some((p) => p.fontAlgn === 'base' && p.marL > 0),
      'a URL with spaces and Hangul': urls.some((u) => u.includes(' ') && /[가-힣]/.test(u)),
      'a URL new URL() rejects': urls.some(rejected),
      'a javascript: URL (a scheme outside the allowlist)': urls.some((u) => refusedScheme(u) && protocolOf(u) === 'javascript:'),
      'a link to slide 99 of 3': slides.length === 3 && links.some((l) => l.kind === 'slide' && l.slide === 99),
      'a link to a later slide': slides.some((s, i) => s.nodes.some((n) => n.link?.kind === 'slide' && n.link.slide > i + 1 && n.link.slide <= slides.length)),
      'a picture with srcRect': pictures.some((p) => p.kind === 'picture' && p.srcRect !== null && p.srcRect.some((v) => v !== 0)),
      'a picture with a negative srcRect side': pictures.some((p) => p.kind === 'picture' && p.srcRect !== null && p.srcRect.some((v) => v < 0)),
      'a picture flipH, flipV, both': [[true, false], [false, true], [true, true]].every(([h, v]) => pictures.some((p) => p.frame.flipH === h && p.frame.flipV === v)),
      'a picture turned 90, 180, 270 and 45 degrees': [5400000, 10800000, 16200000, 2700000].every((rot) => pictures.some((p) => ((p.frame.rot % 21600000) + 21600000) % 21600000 === rot)),
      'a picture rotation outside 0..21599999': pictures.some((p) => p.frame.rot < 0 || p.frame.rot >= 21600000),
      'a picture alpha below 100000 and 0': pictures.some((p) => p.kind === 'picture' && p.alpha > 0 && p.alpha < 100000) && pictures.some((p) => p.kind === 'picture' && p.alpha === 0),
      'a picture with a link': pictures.some((p) => p.link !== null),
    };
    expect(Object.entries(covered).filter(([, yes]) => !yes).map(([name]) => name)).toEqual([]);
  });

  it('writes, drops the link to slide 99, the rejected URL and the javascript: URL, and leaves out only the empty boxes', () => {
    const writer = new PptxWriter(EDGE_SIZE, slides.length);
    for (const [key, { bytes, mime }] of media) writer.addMedia(key, bytes, mime);
    for (const slide of slides) writer.addSlide(slide);
    const files = unzipSync(writer.finish());
    expect(writer.droppedLinks).toEqual({
      url: urls.filter(rejected).length,
      scheme: urls.filter(refusedScheme).length,
      slide: links.filter((l) => l.kind === 'slide' && l.slide > slides.length).length,
    });
    expect(Object.values(writer.droppedLinks).every((n) => n > 0)).toBe(true);
    let written = 0;
    for (let n = 1; n <= slides.length; n++) written += (strFromU8(files[`ppt/slides/slide${n}.xml`]!).match(/<p:cNvPr id="(?!1")\d+"/g) ?? []).length;
    const empty = boxes.filter((b) => b.paras.every((p) => p.runs.every((r) => writesNothing(r.text)))).length;
    expect(written).toBe(nodes.length - empty);
  });
});

describe('kern (ruling M4-R3, which supersedes M3-R7)', () => {
  it('a run without kern (absent or null) writes none: the template\'s kern="1200" stays', () => {
    expect(rPr({})).not.toContain('kern');
    expect(rPr({ kern: null })).not.toContain('kern');
  });

  it('kern 0 (no pair kerning in the PDF) is written after b and i, before spc', () => {
    expect(rPr({ kern: 0 })).toContain('<a:rPr lang="en-US" sz="1800" b="0" i="0" kern="0" spc="0" baseline="0" dirty="0">');
  });

  it('kern is clamped to ST_TextNonNegativePoint (0 to 400000), rounded half away from zero; NaN is refused', () => {
    expect(rPr({ kern: 1200 })).toContain(' kern="1200" ');
    expect(rPr({ kern: -5 })).toContain(' kern="0" ');
    expect(rPr({ kern: 500000 })).toContain(' kern="400000" ');
    expect(rPr({ kern: 1150.5 })).toContain(' kern="1151" ');
    expect(() => rPr({ kern: Number.NaN })).toThrow(RangeError);
  });

  it('the paragraph mark writes no kern', () => {
    expect(tree(textBox([run('x', { kern: 0 })]))).toContain('<a:endParaRPr lang="en-US" sz="1800" b="0" i="0" dirty="0"/>');
  });
});
