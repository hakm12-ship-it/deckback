import { describe, expect, it } from 'vitest';
import { dropInvisible, OFF_PAGE_CAP_NOTE, OFF_PAGE_MAX } from '../../src/passes/invisible';
import { fallback, hotspot, lineStyle, picture, rectPath, shape, slideOf, snapshot, solid, textline } from '../helpers/passes';

/** `invisible` drops what paints nothing on the page; the page is 300 x 200 pt. */
describe('invisible', () => {
  it('drops a shape with no fill and no line, or only alpha 0 ones', () => {
    const kept = shape({ op: 9 });
    const input = slideOf([
      shape({ op: 1, fill: null, line: null }),
      shape({ op: 2, fill: solid([1, 2, 3], 0), line: null }),
      shape({ op: 3, fill: null, line: lineStyle({ paint: solid([0, 0, 0], 0) }) }),
      shape({ op: 4, fill: { kind: 'shading', shading: 'mesh', alpha: 0, mesh: null }, line: lineStyle({ paint: solid([0, 0, 0], 0) }) }),
      shape({ op: 5, groups: [{ alpha: 0, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null }] }),
      kept,
    ]);
    const before = snapshot(input);
    expect(dropInvisible(input).elements).toEqual([kept]);
    expect(input).toEqual(before);
  });

  it('keeps a shape when either its fill or its line shows', () => {
    const lineOnly = shape({ op: 1, fill: solid([1, 2, 3], 0), line: lineStyle() });
    const fillOnly = shape({ op: 2, line: lineStyle({ paint: solid([0, 0, 0], 0) }) });
    expect(dropInvisible(slideOf([lineOnly, fillOnly])).elements).toEqual([lineOnly, fillOnly]);
  });

  it('drops an element whose clip box has no area', () => {
    const out = dropInvisible(
      slideOf([shape({ op: 1, clipBox: [10, 10, 10, 90] }), textline({ op: 2, clipBox: [0, 50, 300, 50] }), shape({ op: 3 })]),
    );
    expect(out.elements.map((e) => e.id)).toEqual(['p1:z3']);
  });

  it('M8 round 1a: keeps a shape, picture or text line wholly outside the page, where it is; drops a link and a fallback there', () => {
    // PowerPoint keeps a shape past the slide's edge and exports it so, clipped to the page: nothing of it shows on the
    // page, nor on the slide, where it stays past the edge. Its clip box is the page's and its clips' (none of it).
    const off: [number, number, number, number] = [0, 0, 0, 0];
    const out = dropInvisible(
      slideOf([
        shape({ op: 1, geom: rectPath(310, 10, 20, 20), clipBox: off }),
        shape({ op: 2, geom: rectPath(-50, -50, 40, 40) }),
        // PowerPoint clips a picture wholly past the edge to a box of 0.0001 pt at the page's corner
        picture([0, 210, 100, 260], { op: 3, clipBox: [0, 0, 0.0001, 0.0001] }),
        textline({ op: 4, bboxPt: [-80, 30, -2, 43], clipBox: off }),
        fallback('unsupported-op', { op: 5, bbox: [400, 0, 450, 50] }),
        hotspot(0, [0, -30, 50, -1], { url: 'https://a.example/', dest: null }),
        shape({ op: 6, geom: rectPath(290, 190, 20, 20) }),
        // a line just past the edge whose width reaches onto the page
        shape({ op: 7, geom: [['M', 0, -1], ['L', 100, -1]], fill: null, line: lineStyle({ w: 4 }) }),
        // the box is on the page, the clip it is drawn in is not: hidden on the page, it stays dropped
        shape({ op: 8, clipBox: [301, 0, 400, 200] }),
        // an sh (no path) has no box of its own but its clip's, here none
        shape({ op: 9, geom: null, bbox: [310, 0, 320, 10], clipBox: off }),
        // partly on the page, its part on the page hidden by its clip: dropped, as before
        shape({ op: 10, geom: rectPath(-20, 10, 40, 20), clipBox: [100, 0, 300, 200] }),
      ]),
    );
    expect(out.elements.map((e) => e.id)).toEqual(['p1:z1', 'p1:z2', 'p1:z3', 'p1:z4', 'p1:z6', 'p1:z7']);
  });

  it('M8 M10: at most OFF_PAGE_MAX elements wholly outside the page stay (the first in z-order), with a note; on-page ones are never capped', () => {
    const off: [number, number, number, number] = [0, 0, 0, 0];
    const many = Array.from({ length: OFF_PAGE_MAX + 10 }, (_, i) => shape({ op: i + 1, geom: rectPath(310, 10, 5, 5), clipBox: off }));
    const onPage = shape({ op: OFF_PAGE_MAX + 11 });
    const out = dropInvisible(slideOf([...many, onPage]));
    expect(out.elements).toHaveLength(OFF_PAGE_MAX + 1);
    expect(out.elements[OFF_PAGE_MAX - 1]!.id).toBe(`p1:z${OFF_PAGE_MAX}`);
    expect(out.elements.at(-1)!.id).toBe(`p1:z${OFF_PAGE_MAX + 11}`);
    expect(out.notes.map((n) => n.detail)).toContain(OFF_PAGE_CAP_NOTE);
    expect(dropInvisible(slideOf(many.slice(0, OFF_PAGE_MAX))).notes).toEqual([]);
  });

  it('M8 round 1a: off the page but on the slide (a page of another size, centred): dropped, as it would show there', () => {
    // a 300 x 200 page on a slide that shows 50 pt more of its frame above and below it
    const view: [number, number, number, number] = [0, -50, 300, 250];
    const out = dropInvisible(
      slideOf([
        shape({ op: 1, geom: rectPath(10, -40, 20, 20) }), // in the band above the page: it would show on the slide
        shape({ op: 2, geom: rectPath(10, -90, 20, 20) }), // past the slide too: kept
        shape({ op: 3, geom: rectPath(10, 10, 20, 20) }),
      ]),
      view,
    );
    expect(out.elements.map((e) => e.id)).toEqual(['p1:z2', 'p1:z3']);
  });

  it('M8 round 1a: keeps text that paints nothing whatever its clip: filled at alpha 0 (its groups too), stroked at alpha 0', () => {
    // PowerPoint exports WordArt and a link's text as such text (ca 0): S2 and S7 count it, and it stays editable
    const hidden: [number, number, number, number] = [0, 0, 0, 0];
    const clear = textline({ op: 1, clipBox: hidden });
    clear.runs[0]!.alpha = 0;
    const inGroup = textline({ op: 2, clipBox: hidden, groups: [{ alpha: 0, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null }] });
    const stroked = textline({ op: 3, clipBox: hidden });
    stroked.runs[0] = { ...stroked.runs[0]!, fillMode: 'stroke', stroke: { rgb: [0, 0, 0], alpha: 0, wPt: 1 } };
    const shown = textline({ op: 4, clipBox: hidden }); // it paints: its clip hides it, dropped
    expect(dropInvisible(slideOf([clear, inGroup, stroked, shown])).elements.map((e) => e.id)).toEqual(['p1:z1', 'p1:z2', 'p1:z3']);
  });

  it('keeps invisible text (noFill), which stays editable', () => {
    const ghost = textline({ op: 1 });
    ghost.runs[0]!.fillMode = 'noFill';
    ghost.runs[0]!.fill = null;
    ghost.runs[0]!.rgb = null;
    const clippedAway = { ...ghost, id: 'p1:z2', clipBox: [0, 0, 0, 0] as [number, number, number, number] };
    expect(dropInvisible(slideOf([ghost, clippedAway])).elements).toEqual([ghost, clippedAway]);
  });
});
