// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '@deckback/core';
import { renderReport, reportView, substituteSelect } from '../src/report-panel';
import { emptyReport } from './report-fixture';

/** Names a hostile PDF could give a font. The page must show each as text and make nothing of it. */
const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "' onmouseover='alert(1)' x='",
  '</li></ul><svg onload=alert(1)>',
  'two\nlines',
  'a"b\c',
  `${'A'.repeat(10_000)}`,
  '&lt;b&gt;&amp;',
];

/** The only attributes the panel itself ever writes: a name from the PDF must not add to this list. */
const OWN_ATTRIBUTES = new Set(['class', 'data-part', 'data-family', 'open', 'id', 'for', 'value', 'lang']);
const OWN_TAGS = new Set(['details', 'summary', 'ul', 'li', 'section', 'h3', 'dl', 'div', 'dt', 'dd', 'p', 'span', 'strong', 'select', 'option', 'label']);

function report(names: string[]): Report {
  return { ...emptyReport(), fonts: names.map((name, i) => ({ key: `f${i}`, latin: name, ea: null, embedded: false, type3: false })) };
}

function panel(names: string[], onChoose: (family: string, label: string) => void = () => undefined): HTMLElement {
  const view = reportView(report(names), 'en', () => false); // every font missing: each row has a dropdown
  const el = renderReport(view, { lang: 'en', choices: new Map(), onChoose });
  document.body.replaceChildren(el);
  return el;
}

afterEach(() => document.body.replaceChildren());

describe('renderReport: a font name from the PDF only ever becomes text', () => {
  it.each(HOSTILE.map((name) => [name.length > 60 ? `${name.slice(0, 10)}... (${name.length} characters)` : name, name]))('%s', (_label, name) => {
    const el = panel([name!]);
    // the row says the name, as text
    const row = el.querySelector('li.font')!;
    expect(row.querySelector('.family')!.textContent).toBe(name);
    expect(el.querySelectorAll('li.font')).toHaveLength(1);
    // no element came of it: only the panel's own tags, none of the dangerous ones
    expect(el.querySelector('img, script, svg, iframe, object, embed, style, link, a')).toBeNull();
    for (const node of el.querySelectorAll('*')) expect(OWN_TAGS.has(node.tagName.toLowerCase()), node.tagName).toBe(true);
    // no attribute came of it: no handler, and nothing outside the panel's own
    for (const node of [el, ...el.querySelectorAll('*')]) {
      for (const attribute of node.getAttributeNames()) {
        expect(attribute.startsWith('on'), attribute).toBe(false);
        expect(OWN_ATTRIBUTES.has(attribute), attribute).toBe(true);
      }
    }
    // the name is only in a text node and in `data-family`, read back whole
    expect(row.getAttribute('data-family')).toBe(name);
  });

  it('the dropdown of such a font is found again by the lookup the page re-focuses it with (no selector, so no escaping to get wrong), and reports the name whole', () => {
    for (const name of HOSTILE) {
      const chosen: [string, string][] = [];
      const el = panel([name], (family, label) => chosen.push([family, label]));
      const select = substituteSelect(el, name);
      expect(select, name.slice(0, 20)).not.toBeNull();
      select!.value = 'Arial';
      select!.dispatchEvent(new Event('change'));
      expect(chosen).toEqual([[name, 'Arial']]);
    }
  });

  it('several hostile names together make one row each and nothing else', () => {
    const el = panel(HOSTILE);
    expect(el.querySelectorAll('li.font')).toHaveLength(HOSTILE.length);
    expect([...el.querySelectorAll('li.font .family')].map((n) => n.textContent)).toEqual(HOSTILE);
    expect(el.querySelector('img, script, svg')).toBeNull();
  });

  it('a Korean name with a different Latin name shows both as text', () => {
    const view = reportView({ ...emptyReport(), fonts: [{ key: 'f0', latin: '<b>x</b>', ea: '<i>가</i>', embedded: false, type3: false }] }, 'ko', () => null);
    const el = renderReport(view, { lang: 'ko', choices: new Map(), onChoose: () => undefined });
    expect(el.querySelector('.family')!.textContent).toBe('<i>가</i>');
    expect(el.querySelector('.other')!.textContent).toBe('<b>x</b>');
    expect(el.querySelector('b, i')).toBeNull();
  });
});

describe('renderReport: the panel itself', () => {
  it('is an open details with the stats, and says when there are no fonts', () => {
    const el = renderReport(reportView(emptyReport(), 'en', () => null), { lang: 'en', choices: new Map(), onChoose: () => undefined });
    expect(el.tagName).toBe('DETAILS');
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.querySelectorAll('[data-part="stats"] .stat')).toHaveLength(4);
    expect(el.querySelector('[data-part="fonts"]')).toBeNull();
  });

  it('shows the substitute chosen as selected', () => {
    const view = reportView(report(['Zed']), 'en', () => false);
    const el = renderReport(view, { lang: 'en', choices: new Map([['Zed', 'Arial']]), onChoose: () => undefined });
    expect(el.querySelector<HTMLSelectElement>('select')!.value).toBe('Arial');
  });
});
