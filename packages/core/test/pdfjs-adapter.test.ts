import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeDocument,
  loadPage,
  openDocument,
  openFailure,
  parsePdfjsRef,
  pdfjsVersion,
  releasePage,
  setPdfjsEnvironment,
  type PdfjsLib,
} from '../src/engine/pdfjs-adapter';
import { assertSameOps, OPS } from '../src/engine/pdfjs-ops';
import { syntheticPdf } from './helpers/synthetic';

describe('parsePdfjsRef', () => {
  it('reads pdf.js reference strings', () => {
    expect(parsePdfjsRef('9R')).toEqual({ num: 9, gen: 0 });
    expect(parsePdfjsRef('120R')).toEqual({ num: 120, gen: 0 });
    expect(parsePdfjsRef('31R2')).toEqual({ num: 31, gen: 2 });
  });

  it('passes a parsed { num, gen } through', () => {
    expect(parsePdfjsRef({ num: 3, gen: 0 })).toEqual({ num: 3, gen: 0 });
  });

  it('gives null for anything else', () => {
    const bad = ['', '0R', '9', 'R9', '9R0', '9r', '9R1x', ' 9R', null, undefined, 9, {}, { num: 1 }, { num: 1.5, gen: 0 }];
    for (const value of bad) expect(parsePdfjsRef(value)).toBeNull();
  });
});

describe('assertSameOps', () => {
  it('accepts the table itself', () => {
    expect(() => assertSameOps({ ...OPS })).not.toThrow();
  });

  it('names a moved, a missing and an extra operator', () => {
    const { save: _save, ...withoutSave } = OPS;
    expect(() => assertSameOps({ ...withoutSave, restore: 99, brandNew: 100 })).toThrow(
      /out of step.*(save|restore|brandNew)/,
    );
    let message = '';
    try {
      assertSameOps({ ...withoutSave, restore: 99, brandNew: 100 });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ['save', 'restore', 'brandNew']) expect(message).toContain(name);
  });
});

// Before the stand-ins below replace the environment: the real Node build.
describe('isOcVisible', () => {
  it('says what pdf.js shows of a synthetic page: one hidden and one visible group, and membership over them', async () => {
    // /OCon is shown and /OCoff hidden; /MDany shows what either shows, /MDoff what /OCoff shows (helpers/synthetic.ts).
    const doc = await openDocument(syntheticPdf('/OC /OCon BDC EMC /OC /OCoff BDC EMC /OC /MDany BDC EMC /OC /MDoff BDC EMC'));
    try {
      const page = await loadPage(doc, 0);
      const { fnArray, argsArray } = page.ops;
      const props = fnArray.flatMap((fn, i) => (fn === OPS.beginMarkedContentProps ? [(argsArray[i] as unknown[])[1]] : []));
      expect(props.map((p) => page.isOcVisible(p))).toEqual([true, false, true, false]);
      expect(page.isOcVisible(null)).toBe(true); // marked content without properties is shown, as pdf.js draws it
      await releasePage(page);
    } finally {
      await closeDocument(doc);
    }
  });

  it('shows a group the configuration does not list', async () => {
    const doc = await openDocument(syntheticPdf('/OC << /Type /OCG /Name (Unlisted) >> BDC EMC'));
    try {
      const page = await loadPage(doc, 0);
      const i = page.ops.fnArray.indexOf(OPS.beginMarkedContentProps);
      expect(page.isOcVisible((page.ops.argsArray[i] as unknown[])[1])).toBe(true);
      await releasePage(page);
    } finally {
      await closeDocument(doc);
    }
  });
});

describe('pdfjsVersion', () => {
  it('is the version of the pdf.js build the adapter drives, the pinned pdfjs-dist 6.5.438', async () => {
    expect(await pdfjsVersion()).toBe('6.5.438');
  });

  it('asks the environment, not a constant', async () => {
    const lib = { OPS, version: '0.0.1-stand-in' } as unknown as PdfjsLib;
    setPdfjsEnvironment(async () => ({ lib, cMapUrl: 'somewhere/cmaps/' }));
    expect(await pdfjsVersion()).toBe('0.0.1-stand-in');
  });
});

// The adapter against a stand-in for pdf.js: what it asks of the library and how it waits for objects.
describe('adapter wiring (stand-in pdf.js)', () => {
  type Callback = (data: unknown) => void;

  /** A page-object store whose entries arrive 5 ms after they are first waited for, like pdf.js images do. */
  function lateStore(entries: Record<string, unknown>) {
    const arrived = new Set<string>();
    return {
      has: (id: string) => arrived.has(id),
      get(id: string, callback?: Callback) {
        if (callback === undefined) {
          if (!arrived.has(id)) throw new Error(`Requesting object that isn't resolved yet ${id}.`);
          return entries[id];
        }
        setTimeout(() => {
          arrived.add(id);
          callback(entries[id]);
        }, 5);
        return null;
      },
    };
  }

  const seen = {
    options: undefined as Record<string, unknown> | undefined,
    listParams: undefined as unknown,
    ocParams: [] as unknown[],
    cleanups: 0,
    destroys: 0,
  };
  const page = {
    ref: { num: 5, gen: 0 },
    view: [0, 0, 200, 100],
    rotate: 90,
    objs: lateStore({ img_p0_1: { width: 2, height: 3, ref: '7R' } }),
    commonObjs: lateStore({ g_d0_f1: { loadedName: 'g_d0_f1' }, g_d0_img_p0_2: { width: 4 } }),
    getOperatorList: async (params: unknown) => {
      seen.listParams = params;
      return {
        fnArray: [OPS.dependency, OPS.paintImageXObject],
        argsArray: [['img_p0_1', 'g_d0_f1', 'g_d0_img_p0_2'], ['img_p0_1', 2, 3]],
      };
    },
    getStructTree: async () => null,
    cleanup: () => {
      seen.cleanups++;
      return true;
    },
  };
  const proxy = {
    numPages: 2,
    getPage: async (n: number) => (n === 1 ? page : { ...page, ref: null }),
    getOptionalContentConfig: async (params: unknown) => {
      seen.ocParams.push(params);
      return { isVisible: (group: unknown) => group !== 'hidden' };
    },
  };
  const lib = {
    OPS,
    AnnotationMode: { DISABLE: 0 },
    getDocument: (options: Record<string, unknown>) => {
      seen.options = options;
      return {
        promise: Promise.resolve(proxy),
        destroy: async () => {
          seen.destroys++;
        },
      };
    },
  } as unknown as PdfjsLib;

  beforeAll(() => setPdfjsEnvironment(async () => ({ lib, cMapUrl: 'somewhere/cmaps/' })));

  it('calls getDocument with the fixed options and the environment cMapUrl', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const doc = await openDocument(bytes);
    expect(doc.numPages).toBe(2);
    expect(seen.options).toEqual({
      data: bytes,
      fontExtraProperties: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
      cMapUrl: 'somewhere/cmaps/',
      cMapPacked: true,
    });
    expect(seen.options!.data).not.toBe(bytes); // pdf.js may detach what it is given; the caller keeps its bytes
  });

  it('turns annotations off, waits for every dependency object, then serves them synchronously', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    const data = await loadPage(doc, 0);
    expect(seen.listParams).toEqual({ annotationMode: 0 });
    expect(data).toMatchObject({ index: 0, pageRef: { num: 5, gen: 0 }, view: [0, 0, 200, 100], rotate: 90, structTree: null });
    expect(data.obj('img_p0_1')).toEqual({ width: 2, height: 3, ref: '7R' }); // page objs
    expect(data.obj('g_d0_img_p0_2')).toEqual({ width: 4 }); // shared objs
    expect(data.font('g_d0_f1').loadedName).toBe('g_d0_f1');
  });

  it('asks pdf.js once per document for what it shows on screen, and answers isOcVisible from that', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    const before = seen.ocParams.length;
    const first = await loadPage(doc, 0);
    await releasePage(first);
    const again = await loadPage(doc, 0);
    expect(seen.ocParams.slice(before)).toEqual([{ intent: 'display' }]);
    expect([again.isOcVisible('hidden'), again.isOcVisible('shown'), again.isOcVisible(null)]).toEqual([false, true, true]);
    await releasePage(again);
  });

  it('calls page.cleanup() on release', async () => {
    const data = await loadPage(await openDocument(new Uint8Array([1])), 0);
    const before = seen.cleanups;
    await releasePage(data);
    expect(seen.cleanups).toBe(before + 1);
  });

  it('rejects a page index outside the document and a page without a ref', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    await expect(loadPage(doc, 2)).rejects.toThrow(RangeError);
    await expect(loadPage(doc, -1)).rejects.toThrow(RangeError);
    await expect(loadPage(doc, 1)).rejects.toThrow(/no object reference/);
  });

  // Two loads of one page index would share one pdf.js page: releasing either clears the objects the other may
  // still be waiting for, and that wait has no timeout. So a second live load is refused at once.
  it('refuses a second live load of the same page until the first is released', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    const first = loadPage(doc, 0);
    await expect(loadPage(doc, 0)).rejects.toThrow(/page 0 is already loaded/);
    const page = await first;
    await expect(loadPage(doc, 0)).rejects.toThrow(/page 0 is already loaded/);
    await releasePage(page);
    await releasePage(page); // a second release is a no-op
    const again = await loadPage(doc, 0);
    expect(again.index).toBe(0);
    await releasePage(again);
  });

  it('frees the page index when a load fails', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    await expect(loadPage(doc, 1)).rejects.toThrow(/no object reference/);
    await expect(loadPage(doc, 1)).rejects.toThrow(/no object reference/);
  });

  it('closeDocument destroys the pdf.js loading task, after which the document loads no pages', async () => {
    const doc = await openDocument(new Uint8Array([1]));
    const before = seen.destroys;
    await closeDocument(doc);
    expect(seen.destroys).toBe(before + 1);
    await expect(loadPage(doc, 0)).rejects.toThrow(/closed/);
    await closeDocument(doc); // closing twice is a no-op
    expect(seen.destroys).toBe(before + 1);
  });

  it("passes the environment's BinaryDataFactory to getDocument, and nothing else besides the fixed options", async () => {
    class Factory {
      async fetch(): Promise<Uint8Array> {
        return new Uint8Array();
      }
    }
    setPdfjsEnvironment(async () => ({ lib, cMapUrl: 'https://example.test/cmaps/', BinaryDataFactory: Factory }));
    try {
      await openDocument(new Uint8Array([1]));
      expect(Object.keys(seen.options!).sort()).toEqual([
        'BinaryDataFactory',
        'cMapPacked',
        'cMapUrl',
        'data',
        'disableFontFace',
        'fontExtraProperties',
        'isImageDecoderSupported',
        'isOffscreenCanvasSupported',
        'stopAtErrors',
        'useSystemFonts',
        'verbosity',
      ]);
      expect(seen.options!.BinaryDataFactory).toBe(Factory);
    } finally {
      setPdfjsEnvironment(async () => ({ lib, cMapUrl: 'somewhere/cmaps/' }));
    }
  });

  it('destroys the loading task when pdf.js cannot open a file, rethrows its error, and openFailure says when the file is to blame', async () => {
    const failing = (name: string) =>
      ({
        ...lib,
        getDocument: () => ({
          promise: Promise.reject(Object.assign(new Error('cannot open'), { name })),
          destroy: async () => {
            seen.destroys++;
          },
        }),
      }) as unknown as PdfjsLib;
    try {
      for (const [name, kind] of [
        ['InvalidPDFException', 'not-pdf'],
        ['PasswordException', 'password'],
        ['UnknownErrorException', null],
      ] as const) {
        setPdfjsEnvironment(async () => ({ lib: failing(name), cMapUrl: 'somewhere/cmaps/' }));
        const before = seen.destroys;
        const error: unknown = await openDocument(new Uint8Array([1])).catch((e: unknown) => e);
        expect(error).toMatchObject({ name, message: 'cannot open' });
        expect(seen.destroys).toBe(before + 1);
        expect(openFailure(error)).toBe(kind);
      }
    } finally {
      setPdfjsEnvironment(async () => ({ lib, cMapUrl: 'somewhere/cmaps/' }));
    }
    expect([openFailure(null), openFailure('InvalidPDFException'), openFailure(new TypeError('x'))]).toEqual([null, null, null]);
  });
});
