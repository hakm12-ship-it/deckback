import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, sceneHash } from '../../src/scene/canonical';
import { extractScene, SceneInputError } from '../../src/scene/extract';
import type { SceneBundle, SceneDeck, SceneSlide } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import { runPython } from '../helpers/oracle';

/**
 * `extractScene` on the committed smoke deck: as PowerPoint wrote it, and encrypted by PyMuPDF with an owner password only
 * (Review Focus 2), which pdf.js opens and the raw reader cannot read (ruling M2-R6). The encrypted copies are made at test
 * time in a temporary directory and never committed. Runs in CI (ruling M1-R76). No Scene JSON is printed.
 */

const SMOKE = `${repoRoot}corpus/generated/atlas-smoke_std.pdf`;
/** The pictures/* slides (atlas-smoke.manifest.json, n 32 to 34, 0-based here), with plain JPEGs, and a text slide. */
const PAGES = [0, 31, 32, 33];

const scratch = mkdtempSync(join(tmpdir(), 'deckback-extract-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * `pdf` saved by PyMuPDF with AES-256 encryption, the owner password `owner` and the user password `user` (empty: anyone may
 * open it, as with an owner password only). Test passwords, not secrets.
 */
function encrypted(pdf: string, user: string): Uint8Array {
  const out = join(scratch, `encrypted-${user === '' ? 'owner' : 'user'}.pdf`);
  const code =
    'import sys, pymupdf\n' +
    'doc = pymupdf.open(sys.argv[1])\n' +
    'doc.save(sys.argv[2], encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="deckback-owner", user_pw=sys.argv[3])\n';
  runPython(['-I', '-c', code, pdf, out, user]);
  return new Uint8Array(readFileSync(out));
}

/**
 * A slide without what the raw reader adds to it, wherever it is (in a tile cell or a soft mask too): a picture's media,
 * which passes through as a JPEG only from a readable file, and a run's style, which comes from the font program.
 */
function withoutRawFacts(slide: SceneSlide): unknown {
  return JSON.parse(canonicalJson(slide), (key, value: unknown) => (key === 'mediaHash' || key === 'bold' || key === 'italic' ? null : value));
}

const kinds = (scene: SceneDeck): string[] => scene.slides.flatMap((s) => s.elements.map((e) => e.kind));

describe('extractScene on an encrypted PDF', () => {
  it('an owner-password PDF gives a scene flagged encrypted', async () => {
    const plain = await extractScene(new Uint8Array(readFileSync(SMOKE)), { pages: PAGES });
    const locked = await extractScene(encrypted(SMOKE, ''), { pages: PAGES });
    expect(plain.scene.source.encrypted).toBe(false);
    expect(locked.scene.source).toEqual({ ...plain.scene.source, encrypted: true });

    // Shapes and text come through pdf.js as they are: every element, in its place, but for what the raw reader adds.
    expect(kinds(locked.scene)).toEqual(kinds(plain.scene));
    expect(kinds(plain.scene)).toEqual(expect.arrayContaining(['shape', 'textline', 'picture']));
    for (const [i, slide] of locked.scene.slides.entries()) {
      expect(withoutRawFacts(slide)).toEqual(withoutRawFacts(plain.scene.slides[i]!));
      expect(slide.notes).toEqual([]);
    }

    // JPEGs pass through only from a readable file; encrypted, every picture is a PNG of pdf.js' pixels.
    const plainMedia = Object.values(plain.scene.media);
    const lockedMedia = Object.values(locked.scene.media);
    expect(plainMedia.filter((m) => m.passthrough).length).toBeGreaterThan(0);
    expect(lockedMedia.length).toBeGreaterThanOrEqual(plainMedia.filter((m) => !m.passthrough).length);
    expect(lockedMedia.every((m) => m.mime === 'image/png' && !m.passthrough)).toBe(true);
    expect([...locked.media.values()].every((bytes) => bytes[0] === 0x89 && bytes[1] === 0x50)).toBe(true); // \x89PNG

    // Font names fall back to pdf.js: the family from the name, no program names, style or metrics; the keys are the same.
    expect(Object.keys(locked.scene.fonts)).toEqual(Object.keys(plain.scene.fonts));
    for (const [key, font] of Object.entries(locked.scene.fonts)) {
      const known = plain.scene.fonts[key]!;
      expect(font.baseFont).toBe(known.baseFont);
      expect(known.metrics).not.toBeNull();
      expect(font).toMatchObject({ eaName: null, bold: false, italic: false, embedded: true, fsType: null, metrics: null, isVariable: false });
      expect(font.latinName!.length).toBeGreaterThan(0);
      expect(known.baseFont.replace(/^[A-Z]{6}\+/, '').startsWith(font.latinName!)).toBe(true); // the name, its style cut off
    }
  }, 60_000);

  it('a PDF that needs a password to open throws SceneInputError password', async () => {
    const error: unknown = await extractScene(encrypted(SMOKE, 'deckback-user')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SceneInputError);
    expect(error).toMatchObject({ kind: 'password' });
  }, 60_000);
});

describe('extractScene is deterministic', () => {
  /** The hash of the Scene and the SHA-256 of every media file, in order. */
  async function fingerprint(bundle: SceneBundle): Promise<{ hash: string; media: string[] }> {
    const media: string[] = [];
    for (const bytes of bundle.media.values()) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
      media.push(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''));
    }
    return { hash: await sceneHash(bundle.scene), media };
  }

  it('extractScene twice gives the same hash', async () => {
    const bytes = new Uint8Array(readFileSync(SMOKE));
    const first = await extractScene(bytes);
    const second = await extractScene(bytes);
    expect(first.scene.slides).toHaveLength(38);
    expect(first.scene.slides.every((s) => s.failed === null && s.notes.length === 0)).toBe(true);
    const [a, b] = [await fingerprint(first), await fingerprint(second)];
    expect(b).toEqual(a);
    expect(a.media).toEqual(Object.keys(first.scene.media)); // each file is stored under the SHA-256 of its bytes
    expect(canonicalJson(second.scene)).toBe(canonicalJson(first.scene));
    // The caller's bytes are left as they were.
    expect(bytes).toEqual(new Uint8Array(readFileSync(SMOKE)));
  }, 60_000); // two runs of 38 pages: about 3 s here, more than 5 s on the CI runner
});
