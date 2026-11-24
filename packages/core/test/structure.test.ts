import { describe, expect, it } from 'vitest';
import type { StructNode } from '../src/engine/pdfjs-adapter';
import { joinStructure, mcidAncestors } from '../src/engine/structure';

const content = (id: string) => ({ type: 'content' as const, id });

describe('joinStructure on a hand-built structure tree', () => {
  it('maps each MCID to its role path from the root to the innermost structure element', () => {
    // pdf.js 6.5 labels the StructTreeRoot `Root`; that label is not part of any path.
    const tree: StructNode = {
      role: 'Root',
      children: [
        {
          role: 'Document',
          children: [
            { role: 'Textbox', children: [{ role: 'P', children: [content('p12R_mc0')] }] },
            {
              role: 'L',
              children: [
                {
                  role: 'LI',
                  children: [
                    { role: 'Lbl', children: [content('p12R_mc2')] },
                    { role: 'LBody', children: [{ role: 'P', children: [{ role: 'Span', children: [content('p12R_mc3')] }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: tree });
    expect(map).toEqual(
      new Map([
        [0, ['Document', 'Textbox', 'P']],
        [2, ['Document', 'L', 'LI', 'Lbl']],
        [3, ['Document', 'L', 'LI', 'LBody', 'P', 'Span']],
      ]),
    );
  });

  it('gives an empty map for a page without a structure tree', () => {
    expect(joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: null }).size).toBe(0);
  });

  it('leaves roleless nodes out of the path (content directly under the root gets an empty path)', () => {
    const tree: StructNode = {
      children: [
        content('p12R_mc1'),
        { children: [{ role: 'P', children: [content('p12R_mc4')] }] },
        { role: 'Figure' },
      ],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: tree });
    expect(map).toEqual(
      new Map([
        [1, []],
        [4, ['P']],
      ]),
    );
  });

  it('ignores content of other pages, objects, annotations and ids it cannot read', () => {
    const tree: StructNode = {
      children: [
        {
          role: 'Sect',
          children: [
            content('p13R_mc5'), // another page
            content('p120R_mc6'), // another page whose number starts with 12
            content('p12R2_mc7'), // same object number, other generation
            content('p12R_mcundefined'),
            content('garbage'),
            { type: 'object', id: '55R' },
            { type: 'annotation', id: 'pdfjs_internal_id_56R' },
            content('p12R_mc8'),
          ],
        },
      ],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: tree });
    expect([...map.keys()]).toEqual([8]);
  });

  it('reads the generation suffix pdf.js adds to the page reference (12R2 for generation 2)', () => {
    const tree: StructNode = {
      children: [{ role: 'P', children: [content('p12R2_mc1'), content('p12R_mc2')] }],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 2 }, structTree: tree });
    expect(map).toEqual(new Map([[1, ['P']]]));
  });

  it('keeps the first path when an MCID is listed twice', () => {
    const tree: StructNode = {
      children: [
        { role: 'P', children: [content('p12R_mc1')] },
        { role: 'Figure', children: [content('p12R_mc1')] },
      ],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: tree });
    expect(map).toEqual(new Map([[1, ['P']]]));
  });

  it('returns a path that its caller may change without touching the other MCIDs', () => {
    const tree: StructNode = {
      children: [{ role: 'Sect', children: [{ role: 'P', children: [content('p12R_mc1'), content('p12R_mc2')] }] }],
    };
    const map = joinStructure({ pageRef: { num: 12, gen: 0 }, structTree: tree });
    map.get(1)!.push('changed');
    expect(map.get(2)).toEqual(['Sect', 'P']);
  });
});

describe('mcidAncestors on a hand-built structure tree', () => {
  const page = (structTree: StructNode | null) => ({ pageRef: { num: 12, gen: 0 }, structTree });

  it('tells two sibling list items apart by node, although their role paths are equal', () => {
    const lbl1: StructNode = { role: 'Lbl', children: [content('p12R_mc1')] };
    const body1: StructNode = { role: 'LBody', children: [content('p12R_mc2')] };
    const li1: StructNode = { role: 'LI', children: [lbl1, body1] };
    const lbl2: StructNode = { role: 'Lbl', children: [content('p12R_mc3')] };
    const body2: StructNode = { role: 'LBody', children: [content('p12R_mc4')] };
    const li2: StructNode = { role: 'LI', children: [lbl2, body2] };
    const list: StructNode = { role: 'L', children: [li1, li2] };
    const doc: StructNode = { role: 'Document', children: [list] };
    const tree: StructNode = { role: 'Root', children: [doc] };

    const nodes = mcidAncestors(page(tree));
    // The nodes are the tree's own objects, outermost first; the Root is not among them.
    expect(nodes.get(1)!).toHaveLength(4);
    expect(nodes.get(1)![0]).toBe(doc);
    expect(nodes.get(1)![1]).toBe(list);
    expect(nodes.get(1)![2]).toBe(li1);
    expect(nodes.get(1)![3]).toBe(lbl1);
    expect(nodes.get(3)![2]).toBe(li2);
    expect(nodes.get(1)![2]).not.toBe(nodes.get(3)![2]);
    expect(nodes.get(1)![2]).toBe(nodes.get(2)![2]); // label and body of one item share the item
    // The role paths of the two items are equal.
    const paths = joinStructure(page(tree));
    expect(paths.get(1)).toEqual(['Document', 'L', 'LI', 'Lbl']);
    expect(paths.get(3)).toEqual(paths.get(1));
    expect(paths.get(4)).toEqual(paths.get(2));
  });

  it('gives an empty map for an untagged page, and no ancestors for content directly under the root', () => {
    expect(mcidAncestors(page(null)).size).toBe(0);
    expect(mcidAncestors(page({ role: 'Root', children: [content('p12R_mc1')] }))).toEqual(new Map([[1, []]]));
  });

  it('keeps roleless nodes as nodes, while joinStructure leaves them out of the role path', () => {
    const anonymous: StructNode = { children: [content('p12R_mc1')] };
    const p: StructNode = { role: 'P', children: [anonymous] };
    const tree: StructNode = { role: 'Root', children: [p] };
    expect(mcidAncestors(page(tree)).get(1)).toEqual([p, anonymous]);
    expect(mcidAncestors(page(tree)).get(1)![1]).toBe(anonymous);
    expect(joinStructure(page(tree)).get(1)).toEqual(['P']);
  });

  it('applies the same page and id rules as joinStructure, and the first occurrence of an MCID wins', () => {
    const first: StructNode = { role: 'P', children: [content('p12R_mc1')] };
    const second: StructNode = { role: 'Figure', children: [content('p12R_mc1'), content('p13R_mc2'), content('garbage')] };
    const nodes = mcidAncestors(page({ role: 'Root', children: [first, second] }));
    expect([...nodes.keys()]).toEqual([1]);
    expect(nodes.get(1)![0]).toBe(first);
  });

  it('returns lists that its caller may change without touching the other MCIDs', () => {
    const sect: StructNode = { role: 'Sect', children: [content('p12R_mc1'), content('p12R_mc2')] };
    const nodes = mcidAncestors(page({ role: 'Root', children: [sect] }));
    nodes.get(1)!.pop();
    expect(nodes.get(2)).toEqual([sect]);
  });
});
