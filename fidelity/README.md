# fidelity: committed measurements

The fidelity harness (`harness/fidelity/run.py`) converts the test decks with a converter, renders every slide with
PowerPoint and MuPDF, and checks each slide against spec section 5: the pixel gates V1 (same renderer) and V2 (cross
renderer) and the structural checks S1-S7. A local run needs Windows and the desktop PowerPoint; GitHub's runners have
neither, so the results of local runs are committed here.

| path | what it is |
|---|---|
| `results/<YYYY-MM-DD>-<converter>.json` | the results of a full local run, named by its date and converter |
| `baselines/proto-m1.json` | the M1 baseline: the experimental M0 converter (`harness/baseline/proto.py`) over the public corpus, the full atlas, the page-size decks and the author's private decks |
| `results/<YYYY-MM-DD>-oracle-sweep.json` | the walker and the Scene against the PyMuPDF oracle on every page of the PDF sets: the full atlas (in all export variants, with its COM-authored supplement `atlas-com` and the page-size decks), the Windows-font atlas and other producers' PDFs; written here only with `DECKBACK_SWEEP_RECORD=1` (see [The oracle ratchet and the atlas sweep](#the-oracle-ratchet-and-the-atlas-sweep)) |
| `known/oracle-known.json` | the committed corpus pages the walker is known not to match the oracle on, each with its reason |

The run results and the baseline follow `harness/fidelity/results.schema.json` (`$id` `deckback.fidelity/1`); the
oracle sweep has its own `"schema"`, `deckback.oracle-sweep/1` (the committed 2026-11-05 file), `/2` (M2 Task 1:
every PDF names its set, and the summary has `bySet`) or `/3` (since M2 Task 12: every page has the Scene's result
`scene`, and the summary counts it and lists the sets it skipped), and the known list none (ruling M1-R65). The
privacy checks below apply to every one of these files, and `harness/fidelity/test_run.py` accepts all three sweep
schemas (ruling M2-R2).

## Run

```
npm run fidelity -- --decks public,atlas,private
harness\.venv\Scripts\python -m harness.fidelity.run --converter proto [--decks public,atlas,private]
    [--variants std,notags] [--out <json>] [--no-s7] [--limit-slides N] [--ids <id>,...] [--off-bar-structural]
```

* M8: `--decks real` measures tier B (`corpus/manifest.jsonl`, the PDFs in the git-ignored `corpus/public-real/`),
  named by tier-B id. `--off-bar-structural` (ruling M8-R1) measures a real deck off the bar (origin other than
  `powerpoint-windows`) with conversion and S1-S6 only: no render (reason `off-bar`), V1 null, V2 not measured
  (counted n/a), S7 n/a. `--ids` measures only the decks with those ids, as a fix round re-measures what it touched.
* M8 tier C: `--decks tier-c` measures the author's own real decks in `corpus/private/tier-c/*.pdf` (git-ignored; the
  `private` set leaves that folder out). They are private in every way: the deck is its 12-hex id (the first 12 hex digits
  of the file's SHA-256), the variant is `pdf`, and no name, path or text reaches a result. The `origin` comes from the
  PDF's Producer/Creator (`census.classify_origin`) and `bar` is always false: a tier-C deck is measured fully (V2 against
  MuPDF, S1-S7; V1 only if `<stem>.pptx` sits next to it) and reported as `summary.tierC` (`decks`, `slides`, `pass`,
  `fail`, `positions`, `origins`, `reportedOnly`), never counted in `summary.bar`. The privacy test accepts a tier-c record
  only by its 12-hex id.
* M8-R12, the position-verified pass (`run.positions_verified`): a slide whose only failing gates are V1 and/or V2 (as its
  font exception reads them) passes with `passReason: "positions"` when S1-S7 pass, every glyph of every text line in
  PowerPoint's round-trip export of our PPTX (S7's export) is within 0.25 pt along and 0.1 pt across of the input PDF's
  glyph origin (`slides[].positions`, from `roundtrip.page_drift`: per text line, in `text_line_boxes` order, the largest
  along/across drift in pt, numbers only, plus the count of glyphs in no line), and the failing gate's own measures over
  the pixels outside the text-line regions (`v1.outside`, `v2.outside`; the residual, and the unexplained pixels as a fraction
  of the whole image, against the gate's own limits) pass. The raw V1/V2 stay as measured; `summary.bar.positions` counts these
  passes inside `summary.bar.pass`. A V1 judged by V2 (noise-exempt) is read through V2's outside pixels. A results file
  without `positions` or `outside` (r2 and older) cannot be position-verified; `triage.py fonts` and `rescore.py` apply the
  rule again from what a file stores.
* M8 font exceptions (`slides[].fontException`, counted in `summary.bar.fontException`): `mupdf-substitution` (M8-R3: the
  page has a font with no font program, so V2 is left out), `missing-font` (spec 5.5: S1-S7 only) and `font-version`
  (M8-R9: this PC has a font the page embeds, installed or as an Office cloud font, in another version: the string in
  nameID 5 or the head `fontRevision` differs **and** the advance widths of the glyphs the PDF uses differ, so PowerPoint
  lays the text out with the PC's version while the PDF used the embedded one; Office's patch bumps with the same advances,
  Arial 7.05 -> 7.06 and Calibri 6.26 -> 6.27, do not count: by the version strings alone they would flag 601 of r1's 1,781
  bar slides; a font whose advances cannot be compared is not flagged on its version string and is counted as `version-unverifiable` by `triage.py fonts`; V1, the source deck re-laid on this PC, is left out and V2 and S1-S7 judge the slide). The reader is
  `harness/fonts/fontversion.py` (names and versions only; `python -m harness.fonts.fontversion page <pdf> <index>` shows a
  page's fonts against the PC's). The precedence is `missing-font`, `mupdf-substitution`, `font-version`. The judgement
  depends on the fonts of the measuring PC (as the cloud font snapshot of M8-R2 does): `triage.py fonts` applies it again
  from the PDFs and the PC, `--no-font-version` leaves it out (the rules of r1).
* M8-R8, the off-bar structural net (no PowerPoint, no render):

  ```
  harness\.venv\Scripts\python -m harness.fidelity.offbar_net run --baseline <results or report.json> --cli <deckback.mjs>
      [--ids <id>,...] [--shard K/N] [--work <dir>] [--out <report.json>] [--no-validator]
  harness\.venv\Scripts\python -m harness.fidelity.offbar_net compare <baseline> <report>
  ```

  It converts every tier-B deck off the bar again, checks every page with S1-S6, validates every output with the Open XML
  validator, and compares with the baseline (a results file of an `--off-bar-structural` run, r0's for the first one, or a
  report of this tool): a deck is worse when it stops converting, fails an S gate on a page that passed it, loses slides, or
  has validator errors it did not have. Exit code 1 when a deck is worse. Exit code 4 when the net is incomplete (a baseline deck was not measured, the validator did not run for a converted deck, or `--no-validator`): it never prints "0 worse" then. A deck re-measured after a facts failure or a converter crash (exit 3, once) is listed as `flaky` with its first failure, never as "the same". Run it after every converter change; point `--cli`
  at a bundle built from the commit under test (a clean checkout), not at a working tree that is changing.
  A whole run takes hours (the S gates of a large deck are slow): `--shard K/N` runs every N-th deck from the K-th, N
  processes side by side with their own `--work` and `--out`, and `combine <report>... --out <report.json>` joins them.

* The `fidelity` script in `package.json` is `harness\\.venv\\Scripts\\python -m harness.fidelity.run --converter
  proto`, with backslashes (ruling M1-R60): npm runs scripts with `cmd.exe` on Windows, which cannot run the
  forward-slash path `harness/.venv/Scripts/python`. The run needs Windows and PowerPoint anyway.
* `npm run fidelity:deckback -- --decks public --no-s7` builds the CLI (`npm run build:cli`, `packages/cli/dist/deckback.mjs`)
  and runs the same harness with `--converter deckback`, which converts with `node packages/cli/dist/deckback.mjs <pdf> -o
  <pptx>`. A bundle that is not built is a failed convert step (exit code 3, reason `converter-missing`), not a crash. The
  CLI's stdout line carries `pages`, `shapes`, `textBoxes`, `pictures` as the baseline does, and the report's
  `freeforms`, `rects`, `lines`, `gradients`, `hotspots` and `fallbacks`; all land in `decks[].convert`.
* `public`: `corpus/generated/<name>_<variant>.pdf` (probe, atlas-smoke). `atlas`: `out/atlas/<name>_<variant>.pdf`
  for the full atlas (`atlas`) and the four page-size decks (`sizes-43`, `sizes-a4l`, `sizes-a4p`, `sizes-custom`;
  minor m20), built with `harness.atlas.build` and exported with `harness.atlas.export` (`harness/README.md`, "Feature
  atlas"). `private`: every PDF under `corpus/private/` (git-ignored). The default is `public,atlas` with the variants
  `std,notags`.
* A public PDF is measured only when it is the export of the deck and manifest next to it: `harness.atlas.export`
  writes an export stamp `<name>.export.json` (the SHA-256 of the deck, of its manifest and of each PDF) next to the
  PDFs, and a PDF its stamp does not record as such (the deck or manifest rebuilt since, no stamp) is not measured:
  its input step is `stale-export` (ruling M1-R77). After rebuilding the atlas, export it again.
* Each export variant is paired with the source deck in its own frame (ruling M1-R72): the `hidden` variant has a
  page for every slide, hidden ones included; the others have the visible slides. `msprint` prints the slides onto A4
  paper, a page frame other than the slide's, so it gets no V1 and no noise floor (`reasons.groundTruth`
  `page-frame-differs`); so does any variant whose page size differs from the slide's.
* Every image of a page is compared at the size of MuPDF's render of that page at 2 px/pt (1920 x 1080 for a 16:9
  page; MuPDF rounds the scaled page outwards, so an A5 page is 840 x 1191 px). PowerPoint is asked to render the
  output and the ground truth at exactly that size; an image of any other size is a size-mismatch error, never
  resized (rulings M1-R54, M1-R61).
* PowerPoint is driven only through `harness/ppt/render.ps1` and `harness/atlas/export.ps1` (S7), one deck at a time.
  A PowerPoint that is already open (the author's) is never closed, and no process is ever stopped. A deck that
  hangs on a repair prompt or another dialog is recorded with exit code 2 and the run goes on to the next deck. That
  dialog may still hold PowerPoint, so after the first PowerPoint timeout of a run every later PowerPoint step (the
  render, the ground truth unless it is cached, S7) is not attempted: it is recorded as `skipped-after-stuck` (render
  and ground truth: exit code null; S7: n/a), not as a failure of those decks, while their conversion and S1-S6 are
  still measured; a progress line points to the manual cleanup in `harness/README.md` (ruling M1-R74). PowerPoint
  refusing the calls because it is busy (a dialog open in it) is recorded as `powerpoint-busy`: the render exit 3
  with that reason, S7 n/a.
* Outputs: the results JSON (default `out/fidelity/results.json`), `out/fidelity/dashboard.html` (one table per deck
  x variant, ✓ / ✗ / n-a per gate and slide, heatmap links), and under `out/fidelity/<id>/<variant>/` the converter's
  `out.pptx`, PowerPoint's `render/slide<N>.png` and the heatmaps of the failing visual gates. The ground-truth renders
  of the source decks are cached in `out/fidelity/gt/<id>/<width>x<height>/`. With these PNGs and the input PDFs, V1,
  V2 and the noise floor can be recomputed without PowerPoint (`harness/fidelity/metrics.py`, `render_pdf.py`). `out/`
  is git-ignored; only the JSON is copied here.

## Reading a results file

* `decks[]`: one record per deck x variant: `id`, `public`, `set`, `variant`, `pages`, `exitCodes` and `reasons` of
  reading the input PDF (`input`), the converter, PowerPoint's render of its output and the ground-truth render (0
  ok, 2 timeout, 3 error, null not run), the converter's counts (`convert`), and `slides[]`. An input PDF that cannot
  be read or is encrypted is `input` 3 (reason `unreadable` or `encrypted`) with an `error` and no slides; so is a
  public PDF that is not the export its stamp records (reason `stale-export`).
* `slides[]`: `index` (0-based page), `label` (the manifest's slide id for public decks), `v1` (null without a source
  PPTX), `v2`, `noise`, `s` (S1-S7, each `{status, detail}`), `known`, `pass`, `heatmaps`. A visual gate that could not
  be computed (no render, an image whose size is not the page's MuPDF size) is `{"pass": false, "error": ...}`.
* `v1` (ruling M4-R11, the author's choice, since M4 Task 7): V1's `pass` is judged per text line. Each line of the
  input PDF's text (a MuPDF rawdict line of visible characters, `pdf_facts.text_line_boxes`, widened by 2 px) may move
  by at most 1 px in x and in y in the render, one shift for the whole line, the best of the nine; a pixel inside two
  line regions is judged once, in the region it lies deepest in; a pixel outside every line is judged unshifted
  (`metrics.line_residual`). The result is `residual3Lines`, never more than the raw `residual3`, which stays recorded
  with `passRaw`; `lines` and `shiftedLines` count the lines and those that moved. PowerPoint's render rounds a line
  to its pixels by its text box, which the PDF does not record, so a line its own export puts within 0.1 pt of the
  source's can render 1 px off (M4 Task 6). Results written before Task 7 have the raw fields only. `parity.py`
  still reads the raw `residual3`.
* `pass` is strict: V2 passed, V1 passed or is null, and every one of S1-S7 is `pass`. An `n/a` check is never a
  pass, so a converter that does not support a check (for example S4's provenance names) cannot pass any slide. `n/a`
  is only for what the converter or the input cannot support; a check that is satisfied because there is nothing to
  compare passes (ruling M1-R70): S2 with no text on either side, S4 with no shapes, S6 with no typeface.
* S6 checks that every typeface is the real family name: no typeface is a BaseFont-style name (`MalgunGothic`), and,
  through S2's alignment, each character's typeface (`a:ea` for East Asian text, `a:cs` for complex scripts,
  `a:latin` otherwise) is a family name (nameID 1) of the embedded PDF font that drew it (ruling M1-R71), in any
  language: "Malgun Gothic" or "맑은 고딕" (ruling M3-R44; spec §7, PowerPoint writes the Korean name in `a:ea`). A
  character whose PDF font has no family name is skipped and counted; when the texts differ, S6 is `n/a`.
* S2 counts a PDF glyph of alpha 0 (invisible, as PowerPoint exports WordArt's text over its outlines) as matching a
  run written `a:noFill`; a glyph's colour is compared only where the glyph is visible (ruling M3-R46).
* S3 subtracts every PDF paint that paints nothing, as it subtracts clip-only paths: a path's fill or stroke of
  alpha 0, exactly 0 (rulings M3-R45, M3-R47). deckback writes such a paint as `a:noFill`, which no slide paint
  counts; a paint of the same path that does paint stays. The detail and the count `invisible paints` say how many
  drawings that left out.
* S4 leaves a link hotspot out of the order: a shape named exactly `pdf:p<page>:a<i> link` (deckback's transparent
  rectangle for a PDF link) is an annotation, not a paint, and sits above every paint; its detail and count `links` say
  how many were left out (ruling M3-R18). Its page number must be the page's, as a paint's must. Any other name
  without the provenance `pdf:p<page>:z<op> ` still makes S4 `n/a`.
* `noise` is the renderer noise floor (rulings M1-R33, M1-R57): V2's metrics between MuPDF's render of the input PDF
  and PowerPoint's render of the source deck, so no converter is involved. It is never gated;
  `summary.noiseFloor` gives median / p95 / max per deck x variant and how many slides exceed the V2 limits on
  renderer noise alone.
* `known` lists the known-unrecoverable classes of spec 5.2 that the deck manifest names for the slide (ruling
  M1-R56): `bitmapText`, `textAsOutlines`, `bitmapEffect`, `colourEmoji`. They are recorded, never excused: `pass`
  ignores them, and `summary.known` counts the slides that have one. `textAsOutlines` covers every manifest feature
  under which PowerPoint's export draws the text as outlines: text rotated at an angle that is not a multiple of 90
  degrees, text in a rotated shape or group, outline-only, unfilled or gradient-filled text, and WordArt warps other
  than `textNoShape` / `textPlain` (calibrated against the visible text layer of the full atlas export). A class only
  a measurement shows is given by slide id from `harness/atlas/known.py`, with its evidence: `lossyPictureExport`
  (ruling M5-R13: PowerPoint's PDF export re-encodes the slide's pictures lossily; atlas pictures/03, 06 and 11).
* `summary`: slide totals, `byGate` (pass / fail / n/a per gate), failed steps per step (`exitCodes`: input,
  convert, render, ground truth), `privateUnreadable`, `known`, `noiseFloor`, `averages`: the mean raw_px32 and
  px32_shift1 of V1 and V2 per deck x variant and over the run (spec 5: averages are reported, never gated), and
  `powerpoint`: the step that first timed out (`stuckAt`: deck, variant, step; null if none), how many later
  PowerPoint steps were skipped because of it (`skippedAfterStuck`) and how many PowerPoint refused as busy (`busy`).
  The run exits with 1 when any step failed, any PowerPoint step was skipped or refused, or any private PDF could not
  be read; a run whose every PDF was an unreadable private one still writes its results (with no decks).

## Privacy

Results name public decks only (`corpus/generated/*`, and `out/atlas/atlas_*` and `out/atlas/sizes-*_*`). A private
deck appears as the first 12 hex digits of the SHA-256 of its PDF bytes (in its record, the noise floor and its
heatmap paths), never with its file name or path, and with no labels. A private PDF that cannot be read at all (held
open by another program, denied, a cloud placeholder) has no id: it is only counted in `summary.privateUnreadable`,
and the run goes on with the other decks (ruling M1-R62). No raw message, stderr or exception text of any tool is
copied into a results file, the dashboard or the console; details are capped at 300 characters. A private deck's
S1-S7 details are a fixed template, the status and the check's counts only (for example `fail; typefaces 2;
mismatches 5; details withheld (private deck)`), because the full details would name fonts, typefaces and shapes of
the private PDF (ruling M1-R75); MuPDF's own messages, which quote font names of a damaged file, are switched off for
the run. The converter's stdout is read through a pipe, never written to disk, and a private deck's failed conversion
has its work directory removed (unless the converter is still running after its time limit and may write into it).
`harness/fidelity/test_run.py` checks every committed file here for drive paths, user directories, the user name and
private file names, stems and directory names (also glued to what comes before them), and that every private deck's
details are the fixed template; no committed file is exempt. The run log `out/fidelity/run.log` keeps the tools' raw
text for public decks only and stays local.

## The M1 baseline (`baselines/proto-m1.json`)

The experimental converter is frozen as it was ported (`harness/baseline/README.md`), with one compatibility fix
(ruling M1-R59, as amended): it stopped on whole decks at the one line that combines an image with its soft mask (an
SMask), for two reasons. With the PyMuPDF of `harness/requirements.lock.txt` an image whose mask carries `/Matte`
loads with an (opaque) alpha of its own, which MuPDF refuses to combine with a mask; and PowerPoint's bitmap text
(atlas/fonts/01) is a 2 x 2 px image whose mask is larger, which MuPDF refuses under any version ("color and mask
pixmaps must be the same size"). So the first baseline run had no converter numbers for the atlas, atlas-smoke and two
private decks. The fix drops the opaque alpha and scales the smaller of image and mask to the other's size, and acts
only where that line raised; everything the frozen code could convert is converted exactly as before
(`harness/baseline/README.md` has the details). The baseline was then measured again with that code.

The baseline is the run of 2026-11-05 with the final M1 code (`npm run fidelity -- --decks public,atlas,private`, S7
included; 1300 s, PowerPoint 16.0.17932.20976, PyMuPDF 2.1 / MuPDF 1.28.6); `results/2026-11-05-proto.json` is the
same file. 19 deck x variants (std and notags of the probe, atlas-smoke, the full atlas and the four page-size decks,
and 5 private PDFs), 461 slides, every step ok (input, convert, render, ground truth; no PowerPoint step timed out,
was skipped or was refused as busy), V1 / V2 / S1-S7 computed for every slide (V1 is n/a on the 26 slides of private
decks without a source PPTX). No slide passes, as expected of this converter: it writes no provenance names (S4 n/a on
every slide); its typefaces are PostScript-style names (`GothicA1` for the family `Gothic A1`), so S6 fails wherever
it compares (n/a on the 13 private slides whose texts S2 finds different); and S7, the PowerPoint round trip, fails on
every deck (mostly glyph baselines more than 0.5 pt off). 56 slides carry a known-unrecoverable class (34
`textAsOutlines`, 22 `bitmapEffect`, 4 `bitmapText`). Pass rates are recorded, not gated.

| gate | pass | fail | n/a |
|---|---|---|---|
| V1 | 3 | 432 | 26 |
| V2 | 13 | 448 | 0 |
| S1 | 433 | 28 | 0 |
| S2 | 360 | 101 | 0 |
| S3 | 330 | 131 | 0 |
| S4 | 0 | 0 | 461 |
| S5 | 461 | 0 | 0 |
| S6 | 0 | 448 | 13 |
| S7 | 0 | 461 | 0 |

On the 11 deck x variants of the first baseline run (the same day, before the final fix wave; without the page-size
decks) every gate count is the same as then except S6 (then 25 pass, 404 fail): S6 now also checks, character by
character, that the typeface is the family of the PDF font that drew it (ruling M1-R71), which the private decks'
conversions no longer pass. `textAsOutlines` now covers every manifest feature PowerPoint exports as outlines (6
slides then, 34 now; minors m2, m9), so 56 slides carry a known class instead of 32. The four page-size decks add 32
slides (S2 and S3 fail on 16 of them; none has a known class).

The averages (spec 5: reported, never gated; `summary.averages`) of raw_px32 / px32_shift1 over the run: V1 6.05 % /
5.07 % (435 slides), V2 6.12 % / 4.61 % (461 slides); per deck (std and notags give the same numbers): the full atlas
V1 7.10 % / 6.10 %, V2 7.24 % / 5.58 %; atlas-smoke V1 4.28 % / 3.13 %, V2 4.22 % / 2.74 %; probe V1 1.95 % /
1.34 %, V2 2.42 % / 1.44 %; the page-size decks V1 0.60-1.45 % / 0.31-0.76 %, V2 0.80-1.80 % / 0.33-0.80 %.

The renderer noise floor (MuPDF vs PowerPoint on the source deck, no converter involved; never gated) exceeds the V2
limits on 42 of the 159 atlas pages and 11 of the 38 atlas-smoke pages (p95 px32_shift1 about 1.5 %, max 6.45 %, max
residual5 73721 px): evidence for recalibrating V2 (ruling M1-R33). Plan 3 moved that recalibration to plan 4 (M3),
since it needs the render of the converter's own PPTX (`docs/decisions/0004-m2-walker-scene-gate.md`). The probe, the
page-size decks (px32_shift1 at most 0.51 %, residual5 at most 43 px) and the private deck with a source PPTX stay
within V2 on renderer noise.

## The oracle ratchet and the atlas sweep

The walker (`packages/core/src/extract/walker.ts`) and the Scene it builds (`extractScene`,
`packages/core/src/scene/extract.ts`) are checked against the PyMuPDF oracle (`harness/oracle/mupdf_inventory.py`)
under the inventory contract `docs/decisions/0002-inventory-contract.md` (0.05 pt). Both commands run the oracle once
per PDF (per ratchet) with the harness Python: `DECKBACK_PY`, else
`harness/.venv/Scripts/python` on Windows and `harness/.venv/bin/python` elsewhere.

* `npm run test:corpus` (CI): every page of every PDF in `corpus/generated/` against the oracle. A page listed in
  `known/oracle-known.json` as `"<file>#<page>": {"reason": ..., "kind": ...}` (page 1-based; `kind`
  `unsupported-op` when the walker refuses an operator, `diff` when its inventory differs) must still fail that way;
  every other page must match. A listed page that matches now fails with "remove from oracle-known.json", so the list
  only shrinks. Every page is compared by value: a page with a paint pair the comparison could only check by kind and
  position (`approx`, 0002 §12) fails, since the committed corpus has none. The verdict is `ratchetVerdict` in
  `packages/core/test/helpers/oracle.ts`, unit-tested on synthetic outcomes. Every page's outcome is written to
  `out/corpus/oracle-ratchet.json`. The same command checks the
  op-list contract: the pdf.js op-name histogram of every page equals `packages/core/test/golden/<stem>-ophist.json`
  (after checking that a change is intended, `DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus` rewrites them; in CI,
  with `CI` set, that switch is refused and the test file throws).
* The same command runs the Scene ratchet (`packages/core/test/corpus/scene-ratchet.corpus.test.ts`, M2 Task 12):
  every page as `extractScene` converts it with its default options (lenient). The inventory each slide gives back
  (`inventoryOfSlide`) must equal the oracle's under the whole contract and by value (no `approx` pair); the slide
  must validate against `packages/core/src/scene/scene.schema.json` and have no note, no `failed` and no fallback
  element, also none in a tile cell or a soft mask (ruling M2-R17); and the SHA-256 of its canonical JSON and its
  element counts per kind must equal `packages/core/test/golden/<stem>-scene.json`
  (`{ "<page, 1-based>": { "sha256", "elements": { "shape", "textline", "picture", "fallback", "hotspot" } }, ...,
  "deck": { "sha256" } }`; the counts are of the slide's own elements, not those a tile cell or a soft mask draws).
  `deck.sha256` is the hash of the deck's font table and source (`{ fonts, source }`), which no slide holds (ruling
  M2-R27). So element ids, the rounding and the names in the Scene, the fonts' too, are frozen (rulings M2-R13,
  M2-R20, M2-R22, M2-R27). No Scene JSON is committed, only these hashes and counts;
  `DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus` rewrites the goldens with the op-list ones.
* `npm run oracle:sweep` (local, opt-in): every page of every PDF of three sets the same way, going on past pages the
  walker refuses, and every page as `extractScene` converts it. The sets are `SWEEP_SETS` of
  `packages/core/test/helpers/sweep.ts`: `atlas` (`out/atlas/*.pdf`: the atlas in every exported variant, its
  COM-authored supplement `atlas-com`, the page-size decks and the probe in `std` and `notags`; a gate),
  `atlas-win` (`out/atlas-win/*.pdf`: the atlas built with the Windows fonts, exported as `std` and `notags`; a gate)
  and `producers` (`out/producers/*.pdf`: PDFs of other producers than PowerPoint; no gate, they show what the walker
  must survive). A set whose directory is missing or holds no PDF is not swept, with a printed reason: a non-gate set
  is just skipped, and a missing gate set fails the run (below). It is opt-in because its project exists only in the
  mode `sweep` (`vitest run --mode sweep --project sweep`); a bare `vitest run` never runs it. It always writes
  `out/sweep/<YYYY-MM-DD>-oracle-sweep.json` (git-ignored); only `DECKBACK_SWEEP_RECORD=1` also writes the committed
  `results/<YYYY-MM-DD>-oracle-sweep.json`, and only when the gate below passes and every PDF has a name a committed
  source gives (ruling M2-R30, `SWEEP_PDFS` in `sweep.ts`: the atlas build's decks in their export variants, and
  `skia-<page>.pdf` for each committed `harness/producers/pages/<page>.html`; nothing in `out/` decides what is
  public). Otherwise the recording run fails, with the set and the count of unnamed PDFs but never their names, and
  the committed file is neither written nor overwritten. Without `DECKBACK_SWEEP_RECORD=1` such a PDF is swept and its
  name printed, for debugging. The file has the comparison's `tolerancePt`, the
  `engines` compared (`pdfjs`, `pymupdf`, `mupdf` versions), per PDF its bare file name (the same name can be in two
  sets), its `set` and its export variant (`variant` is `null` for a file with no known variant suffix, as the
  producers' have), per page its 0-based `index`, `ok`, `diffCount` (every diff, also those past the 50 lines per page
  section the comparison lists), `approxPaints`, the first 20 `diffs`, `unsupported` (the walker's message, or
  null) and `scene` (schema `/3`): `{ ok, elements, notes, failed }`, where `ok` says the Scene's inventory equals the
  oracle's, `elements` counts the slide's own elements per kind as the Scene goldens do, `notes` are the slide's notes
  as `"<op> (<detail>)"` (the operator's name and fixed words only, never deck text, font names or paths) and `failed`
  is the slide's `failed` or null. A file whose Scene cannot be built or compared (`extractScene` throws, which it
  should not as it is lenient, or the comparison does) has `{ ok: false, elements: all 0, notes: ["extractScene threw
  (<Name>)"], failed: "threw" }` on every page, `<Name>` the constructor name of what was thrown (`TypeError`,
  `SceneInputError`; never its message); its walker results stay, and the sweep goes on.
  `summary` counts the pages over every set, those that match (`ok`), are refused (`unsupported`) or differ
  (`diff`), the `approxPaints`, the refused pages per operator and detail (`unsupportedOps`) and the differing pages
  per diff kind (`diffKinds`, such as `fill:bbox` or `glyphs:count`; `diffKind` in
  `packages/core/test/helpers/oracle.ts`; taken from the listed lines, so a kind seen only past a section's cap shows
  as `paints:more` or `glyphs:more`), and for the Scene the pages whose Scene matches (`sceneOk`), the fallback
  elements (`fallbacks`, the slides' own), the `notes` and the slides with `failed`; `summary.bySet` gives
  `{ gate, pages, ok, unsupported, diff, approxPaints, unsupportedOps, diffKinds, sceneOk, fallbacks, notes, failed }`
  for each set that was walked, and `summary.skipped` names the sets that were not (since M2 Task 13; every set is in
  one of the two). With `DECKBACK_DUMP_SCENE=1` it also writes the Scene JSON of every PDF whose Scene was built (also
  when only its comparison threw) to `out/scene/<set>/<stem>.scene.json` (git-ignored, for debugging; never committed).
  The sweep gates (`gateProblems` in `packages/core/test/helpers/sweep.ts`), reading each set from `bySet` and never
  from the totals, which add the producers: it fails when a gate set (`atlas`, `atlas-win`) was not swept or lacks a
  PDF `SWEEP_PDFS` lists for it (a partly built `out/atlas` does not pass), or when any of its pages does not match the
  oracle as walked (`ok`) or as the Scene gives it back (`sceneOk`), was refused, failed, has a fallback element or a
  note (ruling M2-R17), or has a paint pair compared by kind and position only (`approxPaints`, ruling M2-R33: exact
  text-clip boxes are not built while the gate sets have no such paint). `producers` only reports.
* How the sets are filled (`harness/README.md`, "Feature atlas"): `atlas` with `harness.atlas.build` and
  `harness.atlas.export` (the sizes decks, the probe), plus `python -m harness.atlas.com_deck --out out/atlas` and its
  export; `atlas-win` with `python -m harness.atlas.build --deck atlas --fonts windows --out out/atlas-win` and
  `harness.atlas.export` with the variants `std,notags`. The Windows-font PDFs embed Microsoft fonts, and `atlas-com` is
  not byte-deterministic: both stay under `out/` and are never committed.

The sweep of 2026-11-05 (pdf.js 6.5.438, PyMuPDF 2.1 / MuPDF 1.28.6; run again by the final fix wave over the
re-exported atlas) walked 994 pages: the full atlas in all six export variants (std, min, notags, pdfa and msprint with
159 pages each, hidden with 161), the four page-size decks (sizes-43, sizes-a4l, sizes-a4p, sizes-custom; std and
notags, 4 pages each) and the probe (std, notags, 3 pages each). All 994 match the oracle: no operator refused, no
diff and no `approx` paint. Per atlas variant about 26,100 non-blank glyphs (blank ones are not compared) and 3,000
paints were compared by value (9,700 paints for msprint, which prints gradients and patterns as fills and images);
307 to 325 non-blank glyphs and 62 paints per page-size deck variant. The 82 pages of the committed corpus match as
well, so `known/oracle-known.json` is empty (`{}`). Every PDF here is PowerPoint for Windows output, so the sweep names
no operator and no diff kind for plan 3 to implement; the contract's known gaps (0002 §13) remain open. That file is
schema `/1`: it has no sets (all of it is what `/2` calls the `atlas` set, without `atlas-com`).

The sweep of 2026-11-10 (`results/2026-11-10-oracle-sweep.json`, schema `/3`, M2 Task 13; pdf.js 6.5.438, PyMuPDF
2.1 / MuPDF 1.28.6) compared 1,330 pages under the M2 contract (paths, line styles, text state, images, shadings,
clips, groups, soft masks, optional content), as the walker walks them and as the Scene gives them back; `skipped` is
empty. Both gate sets pass: `atlas` (18 PDFs: the atlas in its six variants, `atlas-com`, the page-size decks and the
probe; 1,004 pages) and `atlas-win` (`atlas_std.pdf`, `atlas_notags.pdf`; 320 pages) match the oracle on every page,
both ways, with no operator refused, no `approx` paint, no fallback, no note and no failed slide. Page 39 of
`atlas_std.pdf` (`atlas/fills/06`, gradients with alpha stops) is the masked gate page: 4 gradient shapes, each under
a luminosity soft mask, and it matches both ways in both sets (rulings M2-R15, M2-R28). `producers` (6 Skia PDFs; no
gate) has 5 pages that match as walked and 3 as the Scene gives back. `skia-text.pdf` has 17 `glyph:x` diffs
(0.054-0.113 pt) on both sides, as MuPDF reads glyph widths as integers (0002 §13); `skia-gradients.pdf` and
`skia-patterns.pdf` match the walker with 5 and 4 `approx` paints, the gradient and tile fills of text, which the
Scene's inventory leaves out (0002 §19, ruling M2-R26). No fallback, note or failed slide in any set. The record
names its PDFs by bare file name only: the `atlas-win` and `producers` PDFs embed Microsoft fonts and stay under
`out/`, but their names are public (built from the repository's own atlas and `harness/producers/pages`), and since
ruling M2-R30 the writer refuses any other name. Beyond counts, its only text is those 17 diff lines, which quote
single characters of the committed page `text.html`.
`known/oracle-known.json` stays empty: it lists committed corpus pages for the CI ratchet, and the sweep does not read
it.

## The PPTX ratchet (M3)

`npm run test:corpus` (CI) also runs the PPTX ratchet (`packages/core/test/corpus/pptx-ratchet.corpus.test.ts`, M3
Task 11). Every PDF in `corpus/generated/` is converted by `convert()` with its default options, as the CLI and the
website convert it, and must:

* convert to the same bytes twice, PPTX and report;
* give a PPTX in which the Open XML validator (`harness.ooxml.validate`, Office2021) finds no error;
* pass S1 and S5 on every slide;
* be nowhere worse than its golden in S2, S3, S4 and S6: a status stays as it is or becomes `pass`; any other change
  is worse, `fail` to `n/a` too, as `n/a` is never a pass (`worseThan` in `packages/core/test/helpers/ratchet.ts`);
* equal `packages/core/test/golden/<stem>-pptx.json`: `{ "sha256": <the PPTX's>, "report": <the SHA-256 of the
  report's canonical JSON>, "slides": { "<n, 1-based>": { "counts": <the report's counts of the slide>, "S1".."S6":
  <status>, "checks": <structural_cli's counts per check> } } }`. The checks' counts make a change inside a status
  visible, so a slide already at `fail` cannot get worse unseen.

A golden holds hashes, counts and statuses only. `DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus` rewrites the goldens
(refused in CI), except where a status of S2, S3, S4 or S6 would get worse than the committed golden: then the ratchet
fails and the golden stays (`goldenDecision`, unit-tested in `packages/core/test/ratchet-helpers.test.ts`). A commit
that changes a golden says why.

The S checks come from `python -m harness.fidelity.structural_cli --pdf <pdf> --pptx <pptx> [--details]`: page n of
the PDF against slide n of the PPTX, as a fidelity run checks them (a page or slide whose facts cannot be read fails
all six). Its stdout is one JSON line per slide, `{"slide": n, "S1": <status>, ..., "S6": <status>, "counts": {"S1":
{...}, ...}}`: statuses and the checks' counts only, never a detail, so nothing of the deck. With `--details` it
writes the detail of every check that does not pass to stderr; details name typefaces and shapes, so that flag is for
public decks only (the ratchet uses it on the committed corpus, to show in a failure why a check got worse). Exit codes:
0 every page checked, 2 bad arguments, 3 the PDF cannot be read.

The goldens of 2026-11-11 (82 slides: probe and atlas-smoke, `std` and `notags`, after the rulings M3-R44 to
M3-R46): S1 82 pass, S2 80 pass / 2 fail, S3 82 / 0, S4 82 / 0, S5 82 / 0, S6 82 / 0. The one fail, in both variants:
S2 on `atlas/text/06`, where PowerPoint's synthetic italic (a text matrix sheared by 1/3) reaches the slide as a size
24 x sqrt(1 + 1/9) = 25.30 pt and no italic (`text-skew`); synthetic bold and italic are M4's. Since M4 Task 2 (a
synthetic italic is written `i` at the size of its em, a synthetic bold `b` with no outline), S1 to S6 all pass on all
82 slides of these goldens, the committed corpus only; a fidelity run's other decks (the full atlas, the size decks,
private decks) have slides that do not.

How the rulings moved the first measurement (S2 76 / 6, S3 72 / 10, S6 0 / 82 with deckback's converter):

* S6: the slides name a Korean font by its Korean family name in `a:ea` (`고딕 A1` for `Gothic A1`), as spec §7 and
  PowerPoint do; S6 now takes any nameID 1 record of the font (M3-R44).
* S3 on `probe/m0/03` and `atlas/charts/01`, `04`, `07`, `09`: the chart's frame is a stroke of alpha 0 in the PDF,
  which deckback leaves out as it paints nothing (`passes/invisible.ts`); S3 subtracts it now (M3-R45, M3-R47).
* S2 on `atlas/wordart/01` and `04`: the warped text is drawn as outlines and its characters are kept as invisible,
  editable text (`a:noFill`, spec §6); its glyphs have alpha 0 in the PDF and match now (M3-R46).

## The first run with deckback's converter (M3)

`results/2026-11-11-deckback-m3-first.json` is the first full run with deckback's own converter (M3 Task 12):
`npm run fidelity:deckback -- --decks public,atlas,private`, S7 included, 1536 s, PowerPoint 16.0.17932.20976,
PyMuPDF 2.1 / MuPDF 1.28.6, Node v24.18.0. The same 19 deck x variants and 461 slides as the M1 baseline; every step
ok (input, convert, render, ground truth: no render timed out, so no repair prompt; no PowerPoint step skipped or
refused as busy). The Open XML validator finds 0 errors in all 19 outputs. No slide passes, as S7 fails on every
deck (below).

| gate | pass | fail | n/a |
|---|---|---|---|
| V1 | 61 | 374 | 26 |
| V2 | 315 | 146 | 0 |
| S1 | 461 | 0 | 0 |
| S2 | 435 | 26 | 0 |
| S3 | 455 | 6 | 0 |
| S4 | 461 | 0 | 0 |
| S5 | 461 | 0 | 0 |
| S6 | 457 | 0 | 4 |
| S7 | 0 | 461 | 0 |

The averages of raw_px32 / px32_shift1 over the run: V1 1.15 % / 0.50 % (435 slides), V2 1.30 % / 0.56 % (461 slides);
the M1 baseline had V1 6.05 % / 5.07 % and V2 6.12 % / 4.61 %. S7 fails mostly on paint counts: PowerPoint's export
of our slide has one fill more than the input on almost every page (our full-slide background rectangle on top of
the slide's own background), and one stroke less where the PDF strokes with alpha 0 (left out by the writer,
M3-R45). In the round trips of `probe_std` and `atlas-smoke_std`, exported again and compared in full, no glyph is
off its baseline by more than 0.5 pt.

### Probe parity (`harness/fidelity/parity.py`)

```
harness\.venv\Scripts\python -m harness.fidelity.parity --results <json> --deck <id-or-name> --pptx <pptx> [--pdf <pdf>]
```

gives the verdict of spec section 1.3 for one deck of a run's results, as JSON on stdout (exit 0 pass, 1 fail, 3 the
deck, its PDF or its PPTX cannot be found or read): the mean of V1's raw px32 over the slides at most 0.26 %, every
slide's V1 residual3 at most 25 px, no picture that breaks S1's own rule (covering 50 % of a slide or more with no PDF
bitmap that large containing it; ruling M3-R54), at least as many text boxes,
freeforms, rects, lines and pictures as the experimental converter wrote (39, 9, 21, 35, 1; counted in the PPTX as the
probe's count_shapes.py counted them), and as many gradFill shapes as the PDF has gradients on each page, each a rect
or a custGeom covering its gradient (ruling M3-R24). A private deck is found by its id and printed by it only.

The private probe (`4bd933b68041`) fails: mean V1 raw 0.376 % (0.200, 0.109, 0.819 %; the experimental converter had
0.338, 0.111, 0.334 % in the M1 baseline), V1 residual3 0 on every slide, no full-page picture, one gradient shape;
counts textbox 85, freeform 14, rect 17, line 11, picture 1, so rect and line are below the minimums. The chart page
draws its gridlines as three stroke-only paths of single segments (24 in all) and two paths of rectangles; the
experimental converter wrote each segment and rectangle as a shape of its own. `probe_std` fails the same way (mean
0.485 %, residual3 6, 4, 108). Task 13 closes these.

### The V2 measurement (`harness/fidelity/v2_calibration.py`)

```
harness\.venv\Scripts\python -m harness.fidelity.v2_calibration --results <json> [--population atlas] [--json <file>]
```

puts every slide's V2 next to its noise floor (V2's metrics between MuPDF and PowerPoint's render of the source deck;
M1-R33, M1-R57) and proposes V2 limits: for each metric the smallest one-digit round value above the p99 of the
population's noise floor (the full atlas by default). It prints how many slides pass under the spec's limits and
under the proposal, per deck x variant, per set and over the run, and the noise floor per deck x variant. It changes
nothing.

On this run the atlas's noise floor (318 slides) has residual5 median 12 / p95 4,335 / p99 68,522 / max 73,721 px and
px32_shift1 median 0.25 / p95 1.55 / p99 4.03 / max 6.45 %, so the proposal is 70,000 px / 5 %. Under the spec's
50 px / 0.6 % our V2 passes 315 of 461 slides and the noise floor 329 of 435; under the proposal 455 and 429.

The author chose (ruling M3-R51, applied in `metrics.py` and `run.py`): on a slide with a ground truth V2 passes when
its residual5 is at most the noise floor's + 50 px and its px32_shift1 at most the noise floor's + 0.6 % (the spec's
numbers become the excess allowed over the original's own renderer difference); on a slide without one, at most
400 px and 1 % (the p90 of the atlas noise floor). Each V2 record says which limits it was held to (`limits`, basis
`noise` or `absolute`); a noise record's own `pass` is under the latter.

## The second run with deckback's converter (M3)

`results/2026-11-11-deckback-m3.json` is the second full run (M3 Task 13), after the fixes the first run showed: chart
paths split into connectors and rects (M3-R49; a translucent stroke only where its segments do not meet, M3-R56), the
slide background as `p:bg` (M3-R52), the spacing that glyph positions carry, JPEG density EXIF before JFIF, a
custGeom's frame the extent its paths draw (a picture or gradient fill is laid over that), and dashes with round or
square caps counted with their caps. It was recorded again in M3 Task 14, after S7 was made to split both sides of its
comparison by the same rule (M3-R58: splitting only the input made a PDF differ from itself, and the source deck's own
round trip fail), so that it matches the code. The same command and decks: 1497 s, the same PowerPoint, PyMuPDF and
Node; every step ok, no render timed out (no repair prompt), no PowerPoint step skipped or refused as busy, and the Open
XML validator finds 0 errors in all 19 outputs. Against the record it replaces only the run's and the conversions'
times changed: every slide's V1, V2 and S1–S7, S7's details included, are the same. Two conversions of every deck give
the same bytes as the run's. V2 is under the author's limits (M3-R51) and S7 subtracts paints of alpha 0 (M3-R53) and
counts a split path one paint per piece on both sides (M3-R49, M3-R58).

| gate | pass | fail | n/a |
|---|---|---|---|
| V1 | 65 | 370 | 26 |
| V2 | 403 | 58 | 0 |
| S1 | 461 | 0 | 0 |
| S2 | 435 | 26 | 0 |
| S3 | 455 | 6 | 0 |
| S4 | 461 | 0 | 0 |
| S5 | 461 | 0 | 0 |
| S6 | 457 | 0 | 4 |
| S7 | 0 | 461 | 0 |

Averages of raw_px32 / px32_shift1: V1 1.06 % / 0.47 % (435 slides), V2 1.25 % / 0.48 % (461 slides).

V2 under M3-R51, ours against the noise floor (the noise floor held to the limits of a slide without a ground truth,
400 px and 1 %, which `summary.noiseFloor[].overV2` counts; against itself it would always pass):

| set | slides | ours pass | with a ground truth | noise floor pass |
|---|---|---|---|---|
| public | 82 | 74 | 82 | 74 |
| atlas | 350 | 306 | 350 | 312 |
| private | 29 | 23 | 3 (all pass) | 3 |
| all | 461 | 403 | 435 (383 pass) | 389 |

Probe parity (`parity.py`, ruling M3-R24 and, for full-page pictures, S1's own rule and pictures, M3-R54): the private
probe `4bd933b68041` passes, mean V1 raw 0.198 % (0.200, 0.109, 0.287 %), V1 residual3 0 on every slide, no full-page
picture, one gradient shape, counts textbox 85, freeform 9, rect 22, line 35, picture 1. `probe_std` still fails: mean
0.292 % (0.366, 0.223, 0.288 %) and slide 3's residual3 of 108 px (text).

S7 fails on every deck, each for a few pages: a nonzero fill PowerPoint has as several `a:path`s (M0-5, an arrow's
line and head) comes back as one fill per `a:path`; a slide whose background is not a solid colour gets the master's
white background exported as one more fill; outlined and WordArt text differs (known classes).

M4 Task 4 removed the first two (M3-R55). S7 counts the fills of a shape the writer split into `a:path`s as one paint,
reading the split from the converter's PPTX (`pptx_facts.split_fills`, `roundtrip.join_split_fills`; the input side
still counts each PDF paint once). Since M4 Task 6 the pieces must also be the colour and alpha the PPTX gives the
shape (within 1 of 255 and 0.01), not only one colour among themselves. The writer's master background is `noFill`:
PowerPoint then exports no full-page fill for a slide without `p:bg`, and renders it on the same white (renders and
every slide's V1 and V2 unchanged). A viewer other than PowerPoint may show such a slide's background as transparent,
and a slide the user adds in PowerPoint shows "No fill" while it renders white (ruling M4-R9). S7 is one round trip per
deck x variant, and its result is every slide's of that deck: on public and atlas it passes on 10 of the 14 deck x
variants (it was 0), probe and the four page-size decks, which hold 38 of the 432 slides; the slides of atlas and
atlas-smoke all fail S7 though most of their pages round-trip. Left: atlas and atlas-smoke, 13 and 3 pages per
variant: WordArt and outlined or gradient text (M5's known classes), bullet characters that come back as images
(text/25, 26; not looked into) and mixed-size baselines (text/41).

## The M4 run (`results/2026-11-14-deckback-m4.json`)

The run of M4 Task 6 (plan 5's gate, `docs/decisions/0006-m4-text-quality-gate.md`): `npm run fidelity:deckback --
--decks public,atlas,private`, S7 included, 1,104 s, the same PowerPoint, PyMuPDF and Node as M3; 19 deck x
variants, 461 slides, every step ok (no render timed out, no PowerPoint step skipped or refused as busy). The Open XML
validator finds 0 errors in all 19 outputs. S7's colour check (M4 Task 6, above) was added after the run; S7 run
again with it gives the same status on all 19 and the same problems on the 14 public ones. M4 Task 7 scored V1 again
by ruling M4-R11 (each text line may move 1 px, above) from the run's own renders and ground truths, with no new
PowerPoint run: every slide's raw V1 came out as recorded, and the file now holds both (`residual3`, `passRaw` and
`residual3Lines`, `pass`). The table's M4 V1 is per line, raw in brackets.

| gate (public + atlas, 432 slides) | M3 (`2026-11-11-deckback-m3.json`) | M4 |
|---|---|---|
| V1 pass | 62 | 243 (raw 96) |
| V2 pass | 380 | 373 |
| S1 / S3 / S4 / S5 | 432 / 428 / 432 / 432 | the same |
| S2 pass | 408 | 428 |
| S6 pass (n/a) | 428 (4) | 428 (4) |
| S7 pass | 0 | 38 |
| every gate | 0 | 14 (raw 10) |

Against M3, slide by slide: 40 V1 and 18 V2 get better, 6 V1 and 25 V2 worse (Task 3 listed them: text assembly).
The private decks (29 slides): S2 27 -> 29, S7 0 -> 9, and those 9 pass every gate; the private probe passes parity
(mean V1 raw 0.1401 %, residual3 0 / 0 / 0, counts 39 / 9 / 22 / 35 / 1). M3's V1 is raw: against M3 the counts
compare as 62 and 96.

On atlas/text (42 slides) S2 and S6 pass 42; V1 passes 24 per line with tags and 21 without (raw: 11 and 11; M3: 8).
Task 6 measured, on the raw V1, why so much of it failed where the glyphs were right: on 15 of the 27 failing text
slides with no known class (16 of 27 without tags) most of the residual went when each line of our render was moved by
whole pixels, while PowerPoint's own export of the same slides put those lines' glyphs within about a third of a point
of the source's, most within 0.1 pt. The render rounds a line to its pixels by its box, which the PDF does not record
(the same page converted with and without tags, its glyphs where they were, has text/30 at 128 and 5,587 px raw). That
is the reason for M4-R11. 0006 lists the slides that still fail per line, with their causes.
