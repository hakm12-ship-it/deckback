import { describe, expect, it } from 'vitest';
import { downloadName } from '../src/app';

/** The download's name is made in the page from the chosen file's (Review Focus 4: it never leaves the page). */
describe('downloadName', () => {
  it('is the input name without .pdf, then .pptx', () => {
    expect(downloadName('deck.pdf')).toBe('deck.pptx');
    expect(downloadName('분기 보고 (최종).pdf')).toBe('분기 보고 (최종).pptx');
    expect(downloadName('Deck.PDF')).toBe('Deck.pptx');
    expect(downloadName('a.pdf.pdf')).toBe('a.pdf.pptx');
  });

  it('adds .pptx to a name without .pdf', () => {
    expect(downloadName('slides')).toBe('slides.pptx');
    expect(downloadName('slides.v2')).toBe('slides.v2.pptx');
    expect(downloadName('deck.pdf.txt')).toBe('deck.pdf.txt.pptx');
  });

  it('keeps only the file name, should a browser give a path', () => {
    expect(downloadName(String.raw`C:\fakepath\deck.pdf`)).toBe('deck.pptx');
    expect(downloadName('/home/u/deck.pdf')).toBe('deck.pptx');
  });

  it('names a file that has no name of its own deckback.pptx', () => {
    expect(downloadName('.pdf')).toBe('deckback.pptx');
    expect(downloadName('')).toBe('deckback.pptx');
    expect(downloadName('  .pdf')).toBe('deckback.pptx');
  });
});
