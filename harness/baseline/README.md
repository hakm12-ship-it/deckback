# harness/baseline

The **M0 probe prototype** (a vector-PDF to editable-PPTX converter written during the M0 research probe), ported
here **unchanged** (but for one compatibility fix for soft-masked images, below) and kept only as the **baseline
subject**: M1's fidelity harness measures it once, to record the starting numbers that the real converter has to
beat.

* It is research code. It is not a product, not a starting point for one, and is not maintained.
* It is built on **PyMuPDF, which is AGPL-licensed**. That taints this directory: it is **harness-only and never
  published**. Nothing under `packages/` or `apps/` may import it, and it must not be shipped in any release.

## Use

```powershell
harness/.venv/Scripts/python -m harness.baseline.proto <in.pdf> -o <out.pptx>
```

```python
from pathlib import Path
from harness.baseline.proto import convert

convert(Path("in.pdf"), Path("out.pptx"))
# {"pages": 3, "shapes": 109, "textBoxes": 42, "pictures": 1, "seconds": 0.06}
```

`shapes` counts every shape written on the slides (freeforms, rectangles, lines, gradient rectangles, text boxes and
pictures); the slide background fill is not a shape. Generated `.pptx` files are never committed.

## What changed in the port

Only the plumbing: the module is importable, `convert(pdf, out)` takes `Path`s and returns the summary dict above
(the prototype returned one stats dict per slide; that is still available as `proto._convert`), the CLI takes `-o`,
and no path is hard-coded. The conversion logic is unchanged: on the same PDF the slide XML
and media parts of the output are identical to the original script's (for a PDF the original could convert at all;
see the next section).

## The only change since freezing: soft-masked images (ruling M1-R59)

`Builder.picture` combines every image that has a soft mask (`/SMask`) with that mask:
`Pixmap(Pixmap(doc, xref), Pixmap(doc, smask))`. With the PyMuPDF of `harness/requirements.lock.txt` (2.1), an image
whose mask carries `/Matte`, as PowerPoint exports them, is loaded with an alpha channel of its own. That alpha is
all opaque (the mask is not in it: every such image in the atlas, atlas-smoke and the private decks was checked), and
MuPDF refuses to combine a pixmap that has alpha with a mask: `color pixmap must not have an alpha channel`. The
prototype then stopped on the whole deck: the atlas, atlas-smoke and some private decks could not be converted at
all, so the M1 baseline had no numbers for them.

The same line also raised on a second kind of image: `color and mask pixmaps must be the same size`. PowerPoint
exports text in a CFF font (atlas/fonts/01, the last page of the atlas and atlas-smoke; `knownBitmapText`) as a
2 x 2 px colour image whose soft mask holds the glyphs at full size. MuPDF combines only pixmaps of the same size,
under any version, so this one is a limit of the prototype rather than of the library; it stopped the whole atlas
just the same.

The fix, one block in `Builder.picture`, acts only where that line raised; whatever the frozen line could convert is
converted exactly as before:

* an image loaded with an alpha of its own has that (opaque) alpha dropped (`Pixmap(base, 0)`);
* when the image and its mask differ in size, the smaller of the two is scaled to the other's size;
* then the image is combined with its mask as before, so every picture's alpha is its soft mask.

`test_proto.py::test_probe_output_is_byte_identical_to_the_frozen_port` compares every zip part of the probe's output
with the parts written before the fix. `test_soft_masked_image_page_converts` converts atlas-smoke pages 12 and 38,
which raised before, and checks that each picture's alpha is exactly its soft mask. Using the loaded pixmap as it is
would also have stopped the first error, but it would paint every soft-masked image as an opaque box (the images on
atlas-smoke page 12 are black, so each would become a black rectangle), and it would not have stopped the second. No
other line has changed since the port, and none may.

## Font-specific parts (frozen on purpose)

The prototype was calibrated against **Malgun Gothic**, the Windows font the M0 probe deck used. These parts are
font-specific and are **kept as they are**, because this is a frozen baseline; do not "fix" them here.

* `TEXT_DY = 0.10`: the text box is moved down by 0.10 em of the largest span size. The PDF line box starts at the
  font ascender, which for Malgun Gothic sits about 0.1 em above where PowerPoint puts the line top (found by
  row-profile correlation against ground truth). Other fonts have other ascenders.
* `FONT_MAP`: maps the PDF font name to a PowerPoint typeface name (`MalgunGothic` to the Korean name of Malgun
  Gothic, `NanumGothic`, `Pretendard`, `ArialMT`, and so on). A name that is not in the map is written as the PDF
  font name with its spaces removed, so a PDF font called "Gothic A1" is written as the typeface `GothicA1`, which
  is not an installed font name.
* The text box width is `line width * 1.08 + 2` pt: a safety margin that assumes Malgun Gothic's advance widths.

The committed probe (`corpus/generated/probe_std.pdf`) uses the OFL fonts Gothic A1, Pretendard and Gowun Batang, so
the numbers measured on it include the effect of these Malgun-specific choices.
