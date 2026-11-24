import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchBinaryDataFactory, useBrowserPdfjs } from '../src/engine/pdfjs-browser-bootstrap';

// pdf.js' own browser fetcher reads `document.baseURI`, which a worker does not have; this one only uses fetch.
describe('FetchBinaryDataFactory (how pdf.js fetches cMaps in the browser worker)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const factory = () => new FetchBinaryDataFactory({ cMapUrl: 'https://app.test/pdfjs/cmaps/', standardFontDataUrl: null, wasmUrl: null });

  it('fetches the file under the configured directory and returns its bytes', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetch);
    const bytes = await factory().fetch({ kind: 'cMapUrl', filename: 'KSCms-UHC-H.bcmap' });
    expect(fetch).toHaveBeenCalledWith('https://app.test/pdfjs/cmaps/KSCms-UHC-H.bcmap');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('asks for nothing it has no directory for (standard fonts, wasm), with pdf.js\' own message', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(factory().fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSans.pfb' })).rejects.toThrow(
      'Ensure that the `standardFontDataUrl` API parameter is provided.',
    );
    await expect(factory().fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' })).rejects.toThrow(/`wasmUrl` API parameter/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an HTTP error, naming the URL', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    await expect(factory().fetch({ kind: 'cMapUrl', filename: 'Nope.bcmap' })).rejects.toThrow(
      'Unable to load cMapUrl data at: https://app.test/pdfjs/cmaps/Nope.bcmap (HTTP 404)',
    );
  });
});

describe('useBrowserPdfjs', () => {
  it('needs a cMap directory URL that ends with a slash', () => {
    expect(() => useBrowserPdfjs('https://app.test/pdfjs/cmaps')).toThrow(/must end with a slash/);
  });
});
