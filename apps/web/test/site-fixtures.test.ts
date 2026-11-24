import { describe, expect, it } from 'vitest';
import { convert } from '@deckback/core';
import { errorKind } from '../src/protocol';
import { partsOf } from '../../../packages/core/test/helpers/pptx';
import { imageOnlyPdf, jpxPdf, type4Pdf, notPdf, passwordPdf, permissionsOnlyPdf, PRIVACY_FONTS, PRIVACY_TEXT, privacyPdf, SLOW_PAGES, slowPdf, truncatedPdf } from '../e2e/site-fixtures';

/** The website e2e's generated files (e2e/site-fixtures.ts) are what their names say, in Node, with the same core. */

/** What `convert` throws for `bytes`, as the worker would name it (`errorKind`). */
async function kindOf(bytes: Uint8Array): Promise<string> {
  const error = await convert(bytes).then(
    () => null,
    (e: unknown) => e,
  );
  return error === null ? 'converted' : errorKind(error, bytes);
}

describe('the website e2e fixtures', () => {
  it('a PDF with an open password needs it', async () => {
    expect(await kindOf(passwordPdf())).toBe('password');
  });

  it('a PDF encrypted with permissions only converts, and its report says it was encrypted', async () => {
    const { report } = await convert(permissionsOnlyPdf());
    expect(report.source.encrypted).toBe(true);
    expect(report.slides).toHaveLength(1);
    expect(report.slides[0]!.failed).toBeNull();
    expect(report.totals.rects + report.totals.freeforms).toBeGreaterThanOrEqual(1); // decrypted: the rectangle is there
    expect(report.totals.textBoxes).toBe(1);
  });

  it('a file that is not a PDF, and a truncated PDF', async () => {
    expect(await kindOf(notPdf())).toBe('not-pdf');
    expect(await kindOf(truncatedPdf())).toBe('damaged');
  });

  it('the slow deck has its pages, and each needs the raster renderer', async () => {
    const pdf = slowPdf();
    const { report } = await convert(pdf, { pages: [0, 1] });
    expect(report.source.pageCount).toBe(SLOW_PAGES);
    expect(report.slides.map((s) => s.fallbacks.filter((f) => f.raster !== undefined).length)).toEqual([1, 1]);
  });

  it('the image-only deck: page 1 is image-only, page 2 is not', async () => {
    const { report } = await convert(imageOnlyPdf());
    expect(report.slides.map((s) => s.class)).toEqual(['image-only', 'vector']);
  });
});

describe('the privacy and JPX fixtures (M6 Task 3)', () => {
  it('the privacy deck has what must never leave the page: a Korean file name, slide text and font names, in the PPTX', async () => {
    const { pptx, report } = await convert(privacyPdf());
    const text = Object.values(partsOf(pptx)).join('\n');
    for (const secret of [...PRIVACY_TEXT, ...PRIVACY_FONTS]) expect(text, secret).toContain(secret);
    expect(report.slides).toHaveLength(2);
    expect(report.slides.every((s) => s.failed === null)).toBe(true);
    expect(report.fonts.map((f) => f.latin)).toEqual(expect.arrayContaining(PRIVACY_FONTS.slice(0, 1)));
    // page 2 is the one that needs a predefined CMap (pdf.js fetches it from the site)
    expect(privacyPdf().length).toBeGreaterThan(1000);
  });

  it('the JPX deck has an image pdf.js can only decode with WebAssembly, which our build does not load: a fallback, as in the browser', async () => {
    const { report } = await convert(jpxPdf());
    expect(report.slides[0]!.fallbacks.map((f) => f.reason)).toEqual(['image-unreadable']);
  });
});

describe('the PostScript function fixture (M6 Task 3, fix round)', () => {
  it('has a gradient whose colour is a Type 4 function', async () => {
    const { report, pptx } = await convert(type4Pdf());
    expect(report.slides[0]!.failed).toBeNull();
    expect(report.totals.gradients).toBeGreaterThanOrEqual(1);
    expect(Object.values(partsOf(pptx)).join('\n')).toContain('a:gradFill');
  });
});
