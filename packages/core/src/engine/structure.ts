import type { PageData, StructNode } from './pdfjs-adapter';

type TaggedPage = Pick<PageData, 'pageRef' | 'structTree'>;

/**
 * Joins the page's structure tree to the walker's marked-content ids (spike M0-4): for each MCID the tree names,
 * the structure elements above its content, outermost first, as the tree's own `StructNode` objects. Two list items
 * with the same roles are two different nodes, so this is what tells them (or two `Textbox`es, or two `P`s) apart.
 *
 * pdf.js (6.5.438) names the content of a page `p<page ref>_mc<MCID>`, where the page ref is its own string form:
 * `12R` for object 12, generation 0, and `12R2` for generation 2. So `p12R_mc3` is MCID 3 of the page whose object is
 * `12 0 R`. Content of other pages (pdf.js already filters, but the check is cheap), object and annotation children,
 * and ids that do not read like this (damaged tags) are skipped. The tree's top node is not a structure element but
 * the StructTreeRoot, which pdf.js labels `Root`; it is never in a list, so content directly under it gets `[]`.
 *
 * An untagged page (`structTree` null) gives an empty map. Nodes without a role (damaged tags) are kept as nodes.
 * An MCID listed twice keeps its first occurrence in document order. That also settles a collision pdf.js cannot
 * help with: content of a form XObject stream (an MCR with `/Stm`) has its own MCID numbering, but pdf.js emits the same
 * `p<page ref>_mc<MCID>` and drops the stream reference, so such an MCID is indistinguishable from a page MCID.
 * This module cannot tell them apart; the first one in the tree wins.
 */
export function mcidAncestors(page: TaggedPage): Map<number, StructNode[]> {
  const map = new Map<number, StructNode[]>();
  if (page.structTree === null) return map;
  const { num, gen } = page.pageRef;
  const prefix = `p${num}R${gen === 0 ? '' : gen}_mc`;

  const visit = (node: StructNode, above: readonly StructNode[]): void => {
    for (const child of node.children ?? []) {
      if ('type' in child) {
        if (child.type !== 'content' || !child.id.startsWith(prefix)) continue;
        const digits = child.id.slice(prefix.length);
        if (!/^\d+$/.test(digits)) continue;
        const mcid = Number(digits);
        if (Number.isSafeInteger(mcid) && !map.has(mcid)) map.set(mcid, [...above]);
      } else {
        visit(child, [...above, child]);
      }
    }
  };
  visit(page.structTree, []);
  return map;
}

/**
 * For each MCID, the roles of its structure elements from the outermost to the innermost, e.g.
 * `['Document', 'L', 'LI', 'LBody', 'P', 'Span']`: `mcidAncestors` with each node reduced to its role.
 * Nodes without a role are left out. The paths start below the `Root` that pdf.js puts on the tree (see
 * `mcidAncestors`, which also lists what is skipped). A role path does not say which `LI` it belongs to; use
 * `mcidAncestors` to group by element. An untagged page gives an empty map.
 */
export function joinStructure(page: TaggedPage): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  for (const [mcid, nodes] of mcidAncestors(page)) {
    paths.set(mcid, nodes.flatMap((node) => (node.role === undefined ? [] : [node.role])));
  }
  return paths;
}
