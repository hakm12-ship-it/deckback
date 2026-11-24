import { describe, expect, it } from 'vitest';
import { fixture } from './helpers/fixtures';

const PDF = '%PDF-';
const PNG = '\x89PNG';
const ZIP = 'PK';

const expected: [name: string, magic: string][] = [
  ['original.pdf', PDF],
  ['original.pptx', ZIP],
  ['gt_1.png', PNG],
  ['gt_2.png', PNG],
  ['gt_3.png', PNG],
  ['hard_std.pdf', PDF],
  ['hard_notags.pdf', PDF],
  ['orig_pdfa.pdf', PDF],
  ['orig_notags.pdf', PDF],
];

describe('local probe fixtures', () => {
  for (const [name, magic] of expected) {
    const bytes = fixture(name);
    it.skipIf(bytes === null)(`${name} has the expected file signature`, () => {
      const head = String.fromCharCode(...bytes!.subarray(0, magic.length));
      expect(head).toBe(magic);
    });
  }
});
