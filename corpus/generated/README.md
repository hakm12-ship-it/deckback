# corpus/generated: the public test corpus

A small set of decks and PowerPoint-exported PDFs that is committed to the repository so that anyone (and CI) can
run the converter and the fidelity harness without owning any private deck. Everything here is generated; do not edit
it by hand. `manifest.json` lists every file except this README and itself, with its SHA-256, size and PDF page
count, the font families the PDFs embed (`fonts`) and the smoke slides that were left out to stay within the size
limits (`dropped`).

| file | what it is |
|---|---|
| `probe.pptx` | the three-slide probe deck (shapes and lines, a table with a picture, a chart), authored with python-pptx |
| `probe_std.pdf`, `probe_notags.pdf` | PowerPoint's standard (tagged) PDF export of it, and the same without the structure tree |
| `probe_gt/slide1.png` .. `slide3.png` | PowerPoint's own render of each probe slide, 1920 x 1080 truecolour: the ground truth |
| `probe_gt/map.json` | which std PDF page each slide became |
| `atlas-smoke.pptx` | the `smoke: true` slides of the feature atlas (`harness/atlas/sections/`), authored with python-pptx |
| `atlas-smoke_std.pdf`, `atlas-smoke_notags.pdf` | the PowerPoint exports of it |
| `probe.manifest.json`, `atlas-smoke.manifest.json` | the slide manifests of the two decks (slide id, features, flags) |
| `fallback/*.pdf` | the raster fallback fixtures (M5): synthetic one-page PDFs, each one element DrawingML cannot say (a Multiply blend under text, a luminosity soft mask over an image, a Type 4 mesh, a function-based shading); written byte for byte by `harness/atlas/fallback_pdfs.py`, no PowerPoint involved, no font embedded |
| `probe.export.json`, `atlas-smoke.export.json` | the export stamps (ruling M1-R77): the SHA-256 of the deck and manifest each PDF was exported from, and of each PDF; the fidelity run measures a PDF only when its stamp matches |

Slides keep the ids they have in the full atlas (`atlas/shapes/09`); the id is also printed on the slide (bottom left)
and is therefore in the text layer of its PDF page. `n` in a manifest is the position inside that deck. Some pages
cannot be recovered from their text layer on purpose: text rotated at an angle that is not a multiple of 90 degrees is
exported as outlines, a few effect slides are partly bitmaps, and `atlas/fonts/01` is set in an OpenType-CFF font
that PowerPoint draws as a bitmap (`knownBitmapText: true` in its manifest entry).

## Regenerate

Needs Windows, desktop PowerPoint and the OFL fonts of `harness/fonts/fonts.lock.json`
(`harness/fonts/install-fonts.ps1`, no administrator rights needed):

```
harness/.venv/Scripts/python -m harness.atlas.publish
harness/.venv/Scripts/python -m pytest harness/atlas/test_corpus.py
git add corpus/generated
node scripts/check-no-binaries.mjs --all
```

`check-no-binaries --all` checks the files git holds (the index), never the working tree: stage the published files
first, or it checks the previously committed ones again.

The fallback fixtures alone need neither: `harness/.venv/Scripts/python -m harness.atlas.fallback_pdfs` writes them and
refreshes `manifest.json` (and `publish` stages the same bytes).

`publish` builds the decks, has PowerPoint export them through `harness/ppt/DeckbackCom.psm1`, checks the staged files
with `harness/atlas/corpuscheck.py` (fonts, author metadata, ground truth) and only then replaces the files here (this
README is kept). The `.pptx` files are reproducible byte for byte; PowerPoint writes a creation time and document ids
into every PDF, so a deck whose rebuilt `.pptx` equals the committed one is neither exported nor rewritten (its PDFs and
PNGs stay as committed); `publish --force` exports everything again.

## Licenses

- **Deck content** (the text, shapes, tables, charts and pictures that the harness authors, and the slide and ground
  truth images made from them) is dedicated to the public domain under
  [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- **Embedded fonts.** The PDFs embed subsets of the seven static TrueType font families of the lock, every
  TrueType file of it, and nothing else: **Gothic A1** (Regular and Bold), **Pretendard** (Regular and Bold),
  **Pretendard Light**, **Pretendard Black**, **Gowun Batang** (Regular and Bold), **NanumGothic** (Regular and Bold)
  and **NanumGothicExtraBold**. All are licensed under the [SIL Open Font License 1.1](https://openfontlicense.org)
  (OFL-1.1); the sources, pinned commits and checksums are in `harness/fonts/fonts.lock.json`. `atlas-smoke.pptx` also
  names **Source Sans 3** (OFL-1.1, OpenType-CFF) on the one slide `atlas/fonts/01`; PowerPoint does not embed that
  font and draws the text as a bitmap, so no PDF holds its program. No Microsoft font, no variable font and no font
  binary is in this directory; `harness/atlas/test_corpus.py` checks every embedded font program of every PDF against
  the lock and that all of the lock's TrueType files are embedded.
- **Metadata.** The PDFs name `deckback harness` as author and PowerPoint as creator and producer; the decks and their
  embedded workbooks name `deckback harness` or nobody. The tests check this, so an Office account name cannot slip in.
