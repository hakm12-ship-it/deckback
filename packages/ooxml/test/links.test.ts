import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PptxWriter, writePptx, type DroppedLinks, type OxFill, type OxLink, type OxNode, type OxSlide } from '../src';
import { URL_MAX } from '../src/links';
import { PackageZip } from '../src/zip';
import {
  connector,
  ids,
  LAYOUT_REL,
  MEDIA,
  picture,
  PNG_BYTES,
  PNG_KEY,
  REL,
  relList,
  run,
  shape,
  SIZE,
  slideParts,
  slidePartsOf,
  textBox,
  tree,
} from './helpers/slides';

const url = (u: string): OxLink => ({ kind: 'url', url: u });
const toSlide = (slide: number): OxLink => ({ kind: 'slide', slide });
const BLIP: OxFill = { kind: 'blip', media: PNG_KEY, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
const NONE: DroppedLinks = { url: 0, scheme: 0, slide: 0 };

/** A writer of `slides.length` slides with MEDIA added, fed `slides`, finished: its package and the links it dropped. */
function write(slides: OxSlide[]): { pptx: Uint8Array; dropped: DroppedLinks } {
  const writer = new PptxWriter(SIZE, slides.length);
  writer.addMedia(PNG_KEY, PNG_BYTES, 'image/png');
  for (const slide of slides) writer.addSlide(slide);
  const pptx = writer.finish();
  return { pptx, dropped: writer.droppedLinks };
}

/** The names of the zip entries of a package, in their order. */
function entryNames(pptx: Uint8Array): string[] {
  return Object.keys(unzipSync(pptx));
}

/** The hyperlink targets of a one-slide deck holding one shape per URL, and the links it dropped. */
function urlTargets(urls: string[]): { targets: string[]; linked: string[]; dropped: DroppedLinks } {
  const { pptx, dropped } = write([{ nodes: urls.map((u, i) => shape({ name: `s${i}`, link: url(u) })), background: null }]);
  const { tree: t, rels } = slidePartsOf(pptx);
  const linked = [...t.matchAll(/<p:cNvPr id="\d+" name="(s\d+)"><a:hlinkClick /g)].map((m) => m[1]!);
  const targets = relList(rels).filter((r) => r.includes(' hyperlink ')).map((r) => r.split(' ')[2]!);
  return { targets, linked, dropped };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('links', () => {
  it('a URL is an external hyperlink relationship, percent-encoded where a URI may not hold the character', () => {
    const urlParts = (u: string) => slideParts([{ nodes: [shape({ link: url(u) })], background: null }]);
    const { tree: t, rels } = urlParts('https://example.com/a b/경로?q=1&r=%41%zz"<\\>^`{|}');
    expect(t).toContain('<p:cNvPr id="2" name="pdf:p1:z7 shape"><a:hlinkClick r:id="rId2"/></p:cNvPr>');
    expect(rels).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `${LAYOUT_REL}<Relationship Id="rId2" Type="${REL}hyperlink" ` +
        'Target="https://example.com/a%20b/%EA%B2%BD%EB%A1%9C?q=1&amp;r=%41%25zz%22%3C%5C%3E%5E%60%7B%7C%7D" TargetMode="External"/>' +
        '</Relationships>',
    );
    // astral characters and C0 controls are encoded too; a lone surrogate, which has no UTF-8, is dropped
    expect(urlParts('https://example.com/한국/\u{1F600}\uD800\u0001\uDE00').rels).toContain(
      'Target="https://example.com/%ED%95%9C%EA%B5%AD/%F0%9F%98%80%01" TargetMode="External"',
    );
    // what a URI may hold stays as it is
    const plain = "https://user@example.com:8080/a-b._~/c;d=e,f?g=h+i&j=k!$'()*#l[m]";
    expect(urlParts(plain).rels).toContain(`Target="${plain.replaceAll('&', '&amp;').replaceAll("'", '&apos;')}"`);
  });

  it('the target is the URL the parser read: C0 controls and spaces at either end trimmed, tab, LF and CR removed', () => {
    const { targets } = urlTargets([' \u0001https://example.com/a b\t\n', 'ht\ttps://exa\nmple.com/p\rq', '\u0000 mailto:a@example.com ']);
    // so the target always starts with the scheme that was checked, never a relative reference such as "%20https:..."
    expect(targets).toEqual(['https://example.com/a%20b', 'https://example.com/pq', 'mailto:a@example.com']);
  });

  it('a URL that new URL() rejects is dropped and counted: the node is written without a:hlinkClick', () => {
    const rejected = ['', 'not a url', 'example.com/page', '//example.com/', 'https://exa mple.com/', 'http://[::1/', 'https://example.com:99999/', 'https://'];
    for (const u of rejected) expect(() => new URL(u), u).toThrow(); // the premise
    const nodes: OxNode[] = rejected.map((u, i) => shape({ name: `s${i}`, link: url(u) }));
    nodes.push(shape({ name: 'kept', link: url('https://example.com/') }));
    const { pptx, dropped } = write([{ nodes, background: null }]);
    const { tree: t, rels } = slidePartsOf(pptx);
    expect(ids(t)).toEqual([...rejected.map((_, i) => `${i + 2} s${i}`), `${rejected.length + 2} kept`]);
    expect(t.match(/<a:hlinkClick /g)).toHaveLength(1);
    expect(t).toContain('<p:cNvPr id="2" name="s0"/>');
    expect(relList(rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml', 'rId2 hyperlink https://example.com/']);
    expect(dropped).toEqual({ ...NONE, url: rejected.length });
  });

  it('a URL whose scheme is not http, https, ftp, mailto or tel is dropped and counted as scheme (ruling M3-R14)', () => {
    const refused = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<b>x</b>',
      'file://server/share/x.exe',
      'about:blank',
      'ws://example.com/',
      'blob:https://example.com/x',
    ];
    for (const u of refused) expect(new URL(u).protocol, u).not.toMatch(/^(https?|ftp|mailto|tel):$/); // parses: a scheme drop
    const allowed = ['http://example.com/', 'HTTPS://EXAMPLE.COM/', 'ftp://example.com/f', 'mailto:a@example.com', 'tel:+82-2-123-4567'];
    const { targets, linked, dropped } = urlTargets([...refused, ...allowed]);
    expect(linked).toEqual(allowed.map((_, i) => `s${refused.length + i}`));
    expect(targets).toEqual(allowed);
    expect(dropped).toEqual({ ...NONE, scheme: refused.length });
  });

  it('a URL whose host is not ASCII, or holds a %, is dropped and counted as url: .NET cannot read it (ruling M3-R61)', () => {
    // as pdf.js gives a link (its href), the host is punycode, and the link is written
    const { targets, linked, dropped } = urlTargets([
      'https://한국.example/',
      'https://user@한국.example:8080/p',
      'https:\\한국.example/', // a backslash, or no slash at all, as the URL parser reads them
      'https:한국.example/',
      'https://%ED%95%9C.example/',
      'https://xn--3e0b707e.example/경로',
      'mailto:한국@example.com',
    ]);
    expect(targets).toEqual(['https://xn--3e0b707e.example/%EA%B2%BD%EB%A1%9C', 'mailto:%ED%95%9C%EA%B5%AD@example.com']);
    expect(linked).toEqual(['s5', 's6']);
    expect(dropped).toEqual({ ...NONE, url: 5 });
  });

  it('a URL longer than URL_MAX (2,048) as written is dropped and counted as url (ruling M3-R61)', () => {
    expect(URL_MAX).toBe(2_048);
    const base = 'https://example.com/';
    const atMax = base + 'a'.repeat(URL_MAX - base.length);
    const overMax = `${atMax}b`;
    // as written: a character that is percent-encoded counts as its escape (경 is %EA%B2%BD, 9 characters)
    const encoded = base + '경'.repeat(Math.ceil((URL_MAX - base.length + 1) / 9));
    expect(encoded.length).toBeLessThan(URL_MAX);
    const huge = base + 'x'.repeat(70_000); // past what System.Uri reads (final review F3)
    const { targets, linked, dropped } = urlTargets([atMax, overMax, encoded, huge, 'https://example.com/ok']);
    expect(targets).toEqual([atMax, 'https://example.com/ok']);
    expect(targets[0]).toHaveLength(URL_MAX);
    expect(linked).toEqual(['s0', 's4']); // the others are written without a:hlinkClick
    expect(dropped).toEqual({ ...NONE, url: 3 });
  });

  it('a slide link is a slide relationship with action hlinksldjump', () => {
    const nodes = [shape({ link: toSlide(2) })];
    const { tree: t, rels } = slideParts([{ nodes, background: null }, { nodes: [], background: null }]);
    expect(t).toContain('<p:cNvPr id="2" name="pdf:p1:z7 shape"><a:hlinkClick r:id="rId2" action="ppaction://hlinksldjump"/></p:cNvPr>');
    expect(rels).toContain(`${LAYOUT_REL}<Relationship Id="rId2" Type="${REL}slide" Target="slide2.xml"/></Relationships>`);
  });

  it('relationships are numbered from rId2 in z-order of first use, one per target', () => {
    const nodes: OxNode[] = [
      shape({ link: url('https://example.com/b'), fill: BLIP }),
      connector({ link: toSlide(1) }),
      shape({ link: url('https://example.com/b') }),
      shape({ link: url('https://example.com/a') }),
    ];
    const { tree: t, rels } = slideParts([{ nodes, background: null }]);
    expect([...t.matchAll(/r:(?:id|embed)="(rId\d+)"/g)].map((m) => m[1])).toEqual(['rId2', 'rId3', 'rId4', 'rId2', 'rId5']);
    expect(relList(rels)).toEqual([
      'rId1 slideLayout ../slideLayouts/slideLayout1.xml',
      'rId2 hyperlink https://example.com/b',
      `rId3 image ../media/${PNG_KEY}.png`,
      'rId4 slide slide1.xml',
      'rId5 hyperlink https://example.com/a',
    ]);
  });

  it('text boxes and pictures take a link on cNvPr, before the relationships of their runs and picture', () => {
    const nodes: OxNode[] = [
      textBox([run('a', { fill: BLIP })], { link: url('https://example.com/t') }),
      picture({ link: toSlide(1) }),
    ];
    const { tree: t, rels } = slideParts([{ nodes, background: null }]);
    expect(t).toContain('<p:cNvPr id="2" name="pdf:p1:z3 text"><a:hlinkClick r:id="rId2"/></p:cNvPr><p:cNvSpPr txBox="1"/>');
    expect(t).toContain('<p:cNvPr id="3" name="pdf:p1:z5 picture"><a:hlinkClick r:id="rId4" action="ppaction://hlinksldjump"/></p:cNvPr>');
    expect(relList(rels)).toEqual([
      'rId1 slideLayout ../slideLayouts/slideLayout1.xml',
      'rId2 hyperlink https://example.com/t',
      `rId3 image ../media/${PNG_KEY}.png`,
      'rId4 slide slide1.xml',
    ]);
    // a run without a link of its own holds none
    expect(/<a:rPr[^>]*>.*?<\/a:rPr>/.exec(t)![0]).not.toContain('hlinkClick');
  });

  it("a run's link (M5 Task 5, ruling M3-R1): a:uFill with no fill after its fill, a:hlinkClick in its own colour after its typefaces", () => {
    const linked = run('ab', { link: url('https://example.com/r'), latin: 'Arial' });
    const nodes: OxNode[] = [textBox([run('x '), linked, { ...linked, text: 'c' }], { link: toSlide(1) })];
    const { tree: t, rels } = slideParts([{ nodes, background: null }]);
    const rprs = [...t.matchAll(/<a:rPr[^>]*>.*?<\/a:rPr>/g)].map((m) => m[0]);
    expect(rprs[0]).not.toContain('hlinkClick');
    // PowerPoint underlines a linked run and draws it in the theme's hyperlink colour: the underline is given no fill and
    // the Office 2019 extension keeps the run's own colour (measured, atlas text/14)
    expect(rprs[1]).toMatch(
      /<a:solidFill>.*<\/a:solidFill><a:uFill><a:noFill\/><\/a:uFill><a:latin typeface="Arial"\/>.*<a:hlinkClick r:id="rId3"><a:extLst><a:ext uri="\{A12FA001-AC4F-418D-AE19-62706E023703\}"><ahyp:hlinkClr xmlns:ahyp="http:\/\/schemas.microsoft.com\/office\/drawing\/2018\/hyperlinkcolor" val="tx"\/><\/a:ext><\/a:extLst><\/a:hlinkClick><\/a:rPr>$/,
    );
    expect(rprs[2]).toContain('<a:hlinkClick r:id="rId3">');
    // the box's own link first, then the runs' in document order; one relationship for one target
    expect(relList(rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml', 'rId2 slide slide1.xml', 'rId3 hyperlink https://example.com/r']);
    // a slide link on a run jumps
    const toTwo = slideParts([{ nodes: [textBox([run('j', { link: toSlide(1) })])], background: null }]);
    expect(toTwo.tree).toContain('<a:hlinkClick r:id="rId2" action="ppaction://hlinksldjump"><a:extLst>');
  });

  it("a run's link that is dropped leaves the run written without a:hlinkClick or a:uFill, and is counted", () => {
    const { pptx, dropped } = write([{ nodes: [textBox([run('j', { link: url('javascript:alert(1)') })])], background: null }]);
    const t = strFromU8(unzipSync(pptx)['ppt/slides/slide1.xml']!);
    expect(t).toContain('<a:t>j</a:t>');
    expect(t).not.toContain('hlinkClick');
    expect(t).not.toContain('uFill');
    expect(dropped).toEqual({ ...NONE, scheme: 1 });
  });

  it('a slide link before slide 1, or not a whole number, is refused', () => {
    for (const slide of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tree(shape({ link: toSlide(slide) })), String(slide)).toThrow(RangeError);
    }
  });

  it('a link past the slide count is dropped and counted when its slide is added; later relationships close up', () => {
    const nodes: OxNode[] = [
      shape({ name: 'to 99', link: toSlide(99) }),
      shape({ name: 'to 3', link: toSlide(3) }),
      shape({ name: 'to 4', link: toSlide(4) }), // past the last of 3 too
      shape({ name: 'url', link: url('https://example.com/') }),
      shape({ name: 'to 99 again', link: toSlide(99) }),
    ];
    const writer = new PptxWriter(SIZE, 3);
    writer.addSlide({ nodes: [], background: null });
    writer.addSlide({ nodes, background: null });
    expect(writer.droppedLinks).toEqual({ ...NONE, slide: 3 }); // at once: before slide 3 is added and before finish
    writer.addSlide({ nodes: [], background: null });
    const { tree: t, rels } = slidePartsOf(writer.finish(), 2);
    expect(ids(t)).toEqual(['2 to 99', '3 to 3', '4 to 4', '5 url', '6 to 99 again']); // every node is written
    expect(t).toContain('<p:cNvPr id="2" name="to 99"/>');
    expect(t).toContain('<p:cNvPr id="3" name="to 3"><a:hlinkClick r:id="rId2" action="ppaction://hlinksldjump"/></p:cNvPr>');
    expect(t).toContain('<p:cNvPr id="4" name="to 4"/>');
    expect(t).toContain('<p:cNvPr id="5" name="url"><a:hlinkClick r:id="rId3"/></p:cNvPr>');
    expect(relList(rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml', 'rId2 slide slide3.xml', 'rId3 hyperlink https://example.com/']);
    expect(writer.droppedLinks).toEqual({ ...NONE, slide: 3 });
  });

  it('every slide linking to the last one writes each slide at once (ruling M3-R15)', () => {
    const added = vi.spyOn(PackageZip.prototype, 'add');
    const reserved = vi.spyOn(PackageZip.prototype, 'reserve');
    const cloned = vi.spyOn(globalThis, 'structuredClone');
    const count = 6;
    const slides: OxSlide[] = Array.from({ length: count }, (_, i) => ({
      nodes: [shape({ link: toSlide(count) }), textBox([run('next')], { link: toSlide(Math.min(i + 2, count)) })],
      background: null,
    }));
    const writer = new PptxWriter(SIZE, count);
    writer.addMedia(PNG_KEY, PNG_BYTES, 'image/png'); // as writePptx(SIZE, slides, MEDIA) does, compared below
    slides.forEach((slide, i) => {
      writer.addSlide(slide);
      // the slide and its relationships are in the zip when addSlide returns: the writer keeps nothing of the slide
      expect(added.mock.calls.slice(-2).map(([name]) => name)).toEqual([`ppt/slides/slide${i + 1}.xml`, `ppt/slides/_rels/slide${i + 1}.xml.rels`]);
    });
    const pptx = writer.finish();
    expect(cloned).not.toHaveBeenCalled();
    // add() reserves its entry and writes it at once; the only entries reserved and written later are the presentation's
    const later = reserved.mock.calls.map(([name]) => name);
    for (const [name] of added.mock.calls) later.splice(later.indexOf(name), 1);
    expect(later).toEqual(['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);

    expect(writer.droppedLinks).toEqual(NONE);
    expect(entryNames(pptx).filter((name) => name.startsWith('ppt/slides/'))).toEqual(
      Array.from({ length: count }, (_, i) => [`ppt/slides/slide${i + 1}.xml`, `ppt/slides/_rels/slide${i + 1}.xml.rels`]).flat(),
    );
    expect(relList(slidePartsOf(pptx, 1).rels)).toEqual(['rId1 slideLayout ../slideLayouts/slideLayout1.xml', `rId2 slide slide${count}.xml`, 'rId3 slide slide2.xml']);
    expect(Buffer.from(writePptx(SIZE, slides, MEDIA)).equals(Buffer.from(pptx))).toBe(true);
  });

  it('droppedLinks counts each dropped link when its slide is added, by kind; a refused slide counts nothing', () => {
    const writer = new PptxWriter(SIZE, 2);
    expect(writer.droppedLinks).toEqual(NONE);
    writer.addSlide({ nodes: [shape({ link: url('bad') }), shape({ link: url('bad') }), shape({ link: toSlide(5) }), shape({ link: url('javascript:void(0)') })], background: null });
    expect(writer.droppedLinks).toEqual({ url: 2, scheme: 1, slide: 1 });
    // refused (a picture the writer was not given): nothing of it is counted
    expect(() => writer.addSlide({ nodes: [shape({ link: url('bad') }), picture()], background: null })).toThrow(/media key/);
    expect(writer.droppedLinks).toEqual({ url: 2, scheme: 1, slide: 1 });
    writer.addMedia(PNG_KEY, PNG_BYTES, 'image/png');
    writer.addSlide({ nodes: [textBox([run('x')], { link: url('also bad') }), picture({ link: toSlide(3) })], background: null });
    const snapshot = writer.droppedLinks;
    writer.finish();
    expect(writer.droppedLinks).toEqual({ url: 3, scheme: 1, slide: 2 });
    (snapshot as { url: number }).url = 99;
    expect(writer.droppedLinks.url).toBe(3); // a copy, not a live view
  });
});

describe('the package with dropped links', () => {
  it('lists every slide, and no relationship to a slide it does not have', () => {
    const { pptx } = write([{ nodes: [shape({ link: toSlide(99) })], background: null }, { nodes: [picture({ link: toSlide(2) })], background: null }]);
    const files = unzipSync(pptx);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.rels')) expect(strFromU8(bytes), name).not.toMatch(/slide(?:[3-9]|\d\d+)\.xml/);
    }
  });
});
