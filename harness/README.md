# harness

Python and PowerShell test harness for deckback. It is **not published** and is not part of any package.

PyMuPDF is licensed under the AGPL. It is used here only as a test oracle (a reference to compare
the TypeScript engine against). It must never become a dependency of anything under `packages/` or `apps/`.

## Python environment

Windows, Python 3.12:

```powershell
py -3.12 -m venv harness/.venv
harness/.venv/Scripts/python -m pip install -r harness/requirements.lock.txt
```

Install from `requirements.lock.txt`, which pins every package to the exact version the committed measurements were
made with (ruling M1-R67): the oracle's ground truth and the committed baseline depend on the MuPDF version inside
PyMuPDF (PyMuPDF 2.1 / MuPDF 1.28.6), and the M1-R59 fix of the baseline converter is specific to PyMuPDF 2.1.
`requirements.txt` lists only the direct dependencies, unpinned; after changing it, install it in a fresh venv, run the
suite and refreeze the lock with `pip freeze`. Linux CI installs `requirements-ci.txt`, the same pins without the
Windows-only pieces (`harness/test_requirements_ci.py` checks that they agree).

The venv lives in `harness/.venv/` and is gitignored.

## Python tests

Run from the repository root (`pytest.ini` there sets `pythonpath = .` and `testpaths = harness`):

```powershell
harness/.venv/Scripts/python -m pytest -q                    # the whole suite; PowerPoint tests are skipped
harness/.venv/Scripts/python -m pytest --run-powerpoint -q   # also the tests that drive the desktop PowerPoint
```

Tests marked `@pytest.mark.powerpoint` open PowerPoint through COM (via `harness/ppt/DeckbackCom.psm1`), so they run
only with `--run-powerpoint` (`harness/conftest.py`); CI never passes it. Run them one at a time, never while a
PowerShell test from `harness/ppt/` is running.

## Open XML validator (`harness/ooxml`)

Checks PPTX files against the Open XML schema (`DocumentFormat.OpenXml` 3.5.1, validating as Office 2021). Every PPTX
the writer makes in tests and fidelity runs must have 0 errors. It needs the .NET SDK (8 or newer).

```
harness/.venv/Scripts/python -m harness.ooxml.validate deck.pptx [more.pptx] [--private]
```

One JSON line per file: `{"file": <basename>, "errors": [{"id", "part", "path", "description"}]}`. With `--private` it
prints only `{"file": null, "errorCount": n, "ids": [...]}`: no file name and no description (a description can quote
attribute values of a private deck). Exit 0: no errors; 1: some file has errors; 3: the validator cannot run.
`from harness.ooxml.validate import validate` is the importable form. The C# project builds into
`out/ooxml-validator/<hash>/` on first use and again only when `Program.cs` or `Validator.csproj` changes.

## Received-PDF census (`harness/census`)

```powershell
harness/.venv/Scripts/python harness/census/producers.py <folder> --out out/m0/census.json
```

Classifies every `*.pdf` under `<folder>` by producer family (`powerpoint-win`, `powerpoint-mac`, `acrobat-pdfmaker`,
`keynote`, `google-slides`, `canva`, `other`, plus `unreadable` for corrupt or password-locked files) and counts tagged
files and image-only pages. The PDFs are private: file and folder names are never written, only the first 12 hex digits
of each file's sha256 (a file whose bytes cannot be read gets `unreadable-<n>`). No error text or traceback with a path is
ever printed; `summary.skipped` counts entries that could not be examined at all. A Producer or Creator string that
looks like a path or a file name (a backslash, a drive letter, a rooted path, a document extension such as `.pptx`) is
written as `<redacted>`. The JSON stays under `out/`
(gitignored); only family counts and ratios go into a decision doc.

## OFL fonts (`harness/fonts`)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File harness/fonts/install-fonts.ps1   # prints FONTS OK <n>
harness/.venv/Scripts/python -m harness.fonts.fontcheck                              # prints FONTS OK <n> families
```

`fontcheck` (and every `--fonts ofl` build, before it writes anything) checks each locked file, not only its family
(minor m11): an installed font file must have the file's family name (nameID 1) and PostScript name (nameID 6) and the
locked bytes (sha256), and no installed font file outside the lock may have a locked family name, since Windows would
resolve the typeface to one of the two and PowerPoint would embed that one. Otherwise it prints `FONTS NOT READY:` and
one line per problem, each naming its family.

`harness/fonts/program.py` is the one reader of font programs embedded in PDFs (minor m18), used by the export's font
report, the public corpus gate and the fidelity facts: a bare CFF or Type 1 program and a damaged one are reported as
such (`format`), never raised.

`fonts.lock.json` is the only list of fonts the public test decks and PDFs may contain. Every file is pinned (URL at a
commit, sha256) and carries its Windows family name (nameID 1, the typeface name the decks use), full name and
PostScript name (nameID 6; `fontcheck.lock_postscript_names()` is the set an embedded font program must match).

Which fonts, and why (rulings M1-R21, M1-R29): PowerPoint's PDF export embeds **TrueType** (`glyf`) fonts as subsets,
but not OpenType fonts with CFF outlines: it draws text set in those as a **bitmap**, so the PDF has no text for it.
And a family name that a Windows system font also has resolves to the system font (`Noto Sans KR` became the variable
`NotoSansKR-VF`, embedded whole). So the atlas roles use static TrueType OFL families with no system twin: Gothic A1
(HEAD), Pretendard (BODY, plus the separate families Pretendard Light / Pretendard Black), Gowun Batang (SERIF) and
NanumGothic / NanumGothicExtraBold (ALT). The one OpenType-CFF family, Source Sans 3, is used only by the atlas slide
`atlas/fonts/01`, which keeps the bitmap case on purpose (`knownBitmapText` in the manifest).

`install-fonts.ps1` installs per user (no admin): `%LOCALAPPDATA%\Microsoft\Windows\Fonts` plus one HKCU value per
font. It never touches HKLM or the Windows system font folder. Before installing it removes the lock's `retired` files
(the OpenType-CFF files an earlier lock installed), each only when the file has exactly the retired sha256 and its
HKCU value points at exactly that file: it unloads the font from the Windows session, deletes the file, then the value.
Anything else is left alone and reported. Programs that are already open (PowerPoint included) may need a restart.

### Baseline calibration (`harness/fonts/baseline_calib.py`)

```powershell
harness/.venv/Scripts/python -m harness.fonts.baseline_calib --fonts lock --out out/baseline-calib
harness/.venv/Scripts/python -m harness.fonts.baseline_calib --fonts windows --out out/baseline-calib
harness/.venv/Scripts/python -m harness.fonts.baseline_calib --refit
```

deckback writes each PDF text line as a text box with no insets, no wrapping and the text at the top, and places it so
that PowerPoint draws the first glyph where the PDF has it: the first baseline lies `k` x the font size below the box's
top, `k` a property of the font that PowerPoint does not document (`packages/core/src/passes/baseline.ts`). This
measures it. It builds a deck (python-pptx, through `harness.atlas.deck.AtlasDeck`) with one slide per family and weight
(Regular, Bold), each with three boxes of `Hxg 한글 Ágÿ` at 10, 18 and 36 pt at known tops. Each box is the writer's own
text box, byte for byte (`text_box_xml`, ruling M3-R37): the same run attributes, the same paragraph mark (lang, size,
bold, italic and the run's typefaces) and the same typeface elements, `ea` the family's Korean name where it has one, as
lowering writes it. `packages/ooxml/test/calibration-text-box.json` holds cases that the writer's tests and this
script's tests both check. PowerPoint exports the deck (`harness.atlas.export`, `std`). Each box's baseline is read from
the PDF with the PyMuPDF oracle's glyph origins (ruling M3-R33), and `k = (baseline - top) / size`. A family's `k` is the
mean of its samples, with their number `n` and `spread` (largest minus smallest); where both weights were measured,
`regular` and `bold` hold the same of each weight, and lowering takes the font's weight's (ruling M3-R36: NanumGothic's
Regular and Bold files are 0.08 of the size apart). For any other font deckback takes `k = scale x A / (A + D)` (ruling
M3-R35, M4 Task 3): PowerPoint's single line, 1.2 x the size, shared between the font's line ascent A and descent D as
Windows takes them, OS/2 usWinAscent and usWinDescent, or for a font with USE_TYPO_METRICS (fsSelection bit 7)
sTypoAscender with sTypoLineGap over it and -sTypoDescender; `scale` is fitted through the origin on the calibrated
families (each weight a point; 1.2032, worst error 0.0019 of the size over 20 families), 0.9 for implausible metrics.
The metrics come from the installed font files (every face of a collection), and the run says where they differ from
the programs PowerPoint embedded. Each run merges its families into `packages/core/src/passes/baseline-calib.ts`, with `_alias`, each
calibrated family's Korean name (nameID 1 for 0x412) mapped to it, since a font may carry that name alone. It holds
family names and numbers only, and the run fits the fallback again over all the families. That file is committed; the
deck, the PDF and the samples (`baseline-calib-<fonts>.json`) stay in `--out`, which must be under `out/` or the system
temp folder, and are never committed (ruling M3-R3). The table names only families of public sources (ruling M4-R8):
the two runs' lists below. A family no list names any more leaves it, with its aliases, on the next run or `--refit`
(`pruned`); `harness/fonts/test_font_sources.py` checks both font tables against spec section 7's list, the lock and
atlas-win.

- `--fonts lock`: the lock's families, after `fontcheck` (exit 3 when one is not ready). Source Sans 3 is skipped:
  PowerPoint draws OpenType-CFF text as a bitmap, so there is no glyph to read.
- `--fonts windows`: the Windows fonts of spec section 7's list (Malgun Gothic, Gulim, Batang, Dotum, Gungsuh, Noto Sans
  KR, Arial, Calibri, Segoe UI, Times New Roman, Cambria, Consolas) and of `atlas-win` (Malgun Gothic Semilight):
  `WINDOWS_FAMILIES`. The files embed Microsoft fonts.
- `--refit`: no deck and no PowerPoint: the fallback's `scale` fitted again over the committed table's families.
- A character a family's installed faces lack is left out of its text (NanumGothic has no `Á` or `ÿ`), and a sample
  whose line still holds glyphs of a second font is dropped: PowerPoint draws a missing character in another font
  (Cambria), and a line of two fonts has another baseline. With the font alone, `k` does not depend on the text (Latin
  only, Hangul only and both measured the same).
- What else moves the baseline (measured): the paragraph mark's font. The writer names the last run's typefaces, bold
  and italic on `a:endParaRPr` as PowerPoint does; without the typefaces the mark took the theme's font and the probe's
  36 pt Gothic A1 titles drew 2.1 pt higher.
- PowerPoint is driven only through `harness.atlas.export`: one `std` export per run. Exit 2 for a refused `--out` or
  when the export did not finish in time (left running, nothing stopped: look for a dialog), 3 when it failed.

### PostScript-name table (`harness/fonts/ps_family.py`)

```powershell
harness/.venv/Scripts/python -m harness.fonts.ps_family
```

Writes `packages/core/src/fonts/ps-family.ts` from two committed lists, reading no font file, so that it is the same
on any machine (ruling M4-R8): `harness/fonts/ps-family.json`, curated, the faces of spec section 7's Windows and Office
families (Malgun Gothic, Gulim, Batang, Dotum, Gungsuh, the HY family, Noto Sans KR, Arial, Calibri, Segoe UI, Times New
Roman, Cambria, Consolas) and of the atlas-win build (Malgun Gothic Semilight), and `fonts.lock.json`, the OFL fonts
(Pretendard and the Nanum family among them). Each PostScript name (nameID 6) maps to its family (nameID 1) and style
(nameID 2); a family of no public source, or a name given twice, is refused. Lowering names a font the PDF knows only by
its PostScript name by its family through it (`packages/core/src/fonts/names.ts`: `MalgunGothic,Bold` is `Malgun
Gothic`, bold), and S6 reads its families back: no typeface may be a known family without its spaces. Names only;
committed, and a test checks that it is what the generator writes.

## Converters of the fidelity run (`harness/fidelity/run.py`)

`--converter proto` is the frozen baseline (`python -m harness.baseline.proto`). `--converter deckback` is the CLI
bundle: `npm run fidelity:deckback` builds it (`npm run build:cli`, a Vite SSR build to `packages/cli/dist/deckback.mjs`,
git-ignored; `@deckback/core` and `@deckback/ooxml` bundled, `pdfjs-dist` and `fflate` resolved from `node_modules`) and runs
`node packages/cli/dist/deckback.mjs <pdf> -o <pptx>` per deck. Without the bundle a deck's convert step fails with the
reason `converter-missing`. Exit codes of the CLI: 0 done, 2 bad arguments, 3 unreadable or password-protected input,
4 any other conversion error.

## PowerPoint render harness (`harness/ppt`)

Windows only: it drives the desktop PowerPoint through COM, from Windows PowerShell 5.1.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File harness/ppt/render.ps1 -Pptx deck.pptx -OutDir out/m0/deck
powershell -NoProfile -ExecutionPolicy Bypass -File harness/ppt/test_com_module.ps1      # prints COM MODULE TESTS OK
powershell -NoProfile -ExecutionPolicy Bypass -File harness/ppt/test_render_safety.ps1   # prints SAFETY OK
```

`render.ps1` writes `slide<N>.png` (1920 x 1080 by default; always 8-bit RGB, see below) and exits 0, or 2 on
timeout (possible repair or modal dialog), or 3 on an open/export error, or 5 when PowerPoint refused its calls because
it was busy (a dialog open in PowerPoint, possibly yours; ruling M1-R74). The author's own PowerPoint may be open with
unsaved work, so the scripts never kill a process, never quit a PowerPoint they did not start (decided by process id),
and never close a presentation they did not open: `render.ps1` renders a unique temp copy of the file.

Python code that runs one of these scripts never lets `subprocess` end it: `subprocess.run(..., timeout=...)` kills the
child when the limit passes, and a script ended in the middle cannot close its copy or quit the PowerPoint it started.
It uses `harness.ppt.never_stop.run_script` (or `Popen.communicate` with a limit, as `harness/fidelity/run.py` and
`harness/atlas/export.py` do), which leaves an overrunning script running. `harness/ppt/test_never_stop.py` checks every
harness Python file for this and for any process-ending call, also on CI (minor m6).

### Truecolour renders (`harness/ppt/pngmode.py`)

Every PNG the harness compares must be 8-bit RGB (PNG colour type 2) or RGBA (6). PowerPoint's own
`Slide.Export(path, 'PNG', W, H)` sometimes writes an 8-bit **palette** PNG (type 3) for slides with few colours (M0:
the fill-rule slide), and the quantised colours would add noise to every pixel metric (on the M0-6 gradient slides
the largest pixel difference against the ground truth fell from 19 / 23 to 3 / 11 once the renders were truecolour).
So `render.ps1` never uses the PNG filter:

- **Route that works: BMP, then System.Drawing.** Inside the module action, `Slide.Export(path, 'BMP', W, H)` writes a
  24-bit BMP (BITMAPINFOHEADER, 24 bits per pixel, 1920 x 1080), which is copied pixel for pixel into a
  `Format24bppRgb` bitmap and saved as PNG. The result is RGB (colour type 2), byte-identical in pixels to the BMP.
  The intermediate `slide<N>.bmp` is deleted.
- **Fallback: TIF.** If a BMP is ever not 24-bit (its header says fewer bits per pixel), that slide is exported with
  `'TIF'` instead and converted the same way; `render.ps1` then prints a note on stderr. A palette (indexed) image
  from either route is an error (exit 3), because its colours are already quantised. The TIF route was checked on
  the same slide and gives identical pixels; `-TestForceTif` (a test hook) forces it.
- `render.ps1` also checks that every written PNG has colour type 2. `pngmode.png_colour_type(path)` reads the colour
  type (IHDR byte 25) for tests and for the later comparison code, which must treat type 3 as an error.

Note: PNGs written by System.Drawing carry `sRGB` and `gAMA` chunks (pixel values are untouched; PIL reads them
unchanged).

### The PowerPoint COM module (`harness/ppt/DeckbackCom.psm1`)

Every script that drives PowerPoint does it through this module, and no other file creates a
`PowerPoint.Application` COM object. `test_com_module.ps1` guards this statically over every `*.ps1`, `*.psm1` and
`*.py` under `harness/`: nothing ends a process, nothing outside the module attaches to a COM server or names the
PowerPoint ProgID, and `Connect-`/`Disconnect-DeckbackPowerPoint` appear only in the module and the three tests
that play the author. A script hands the module a deck and an action:

```powershell
Import-Module harness/ppt/DeckbackCom.psm1
$r = Invoke-DeckbackPowerPoint -Pptx deck.pptx -ActionArgs @('out/x') -Action @'
param($pres, $app, $args)
$pres.Slides.Count
'@
# $r: ok, exitCode (0 ok / 2 timeout / 3 open or action error / 4 skipped), message, result (the action's output),
#     newPids (PowerPoint processes that appeared and are still there), ownedPid (the one this run started),
#     stuck (the job could not be stopped after a timeout), skipped (exitCode 4, see -RequireOwned),
#     busy (PowerPoint refused the calls: busy), leftRunning (its own instance was not quit: M1-R73)
```

- The action is the source text of a script block `param($pres, $app, $args)`. It runs inside a job against a
  read-only, windowless temp copy (`%TEMP%\deckback-com-<id>.pptx`); `$args` holds `-ActionArgs`. It returns
  plain data and starts any child process through `Invoke-DeckbackChildProcess` (empty stdin, stdout and stderr
  to files), because a job host talks to its parent over its own stdin/stdout. It may work only on the copy it
  is given: an action whose text mentions `ActivePresentation`, `ActiveWindow`, `.Presentations`, `.Windows`,
  `.Quit(` or `.Close(` (or attaches to PowerPoint itself) is rejected with exit code 3 before PowerPoint is
  touched, since the copy has no window and those could only reach the author's documents.
- The module owns everything else: the process id snapshot, the temp copy, the open and the proof that the
  opened presentation is the copy, closing only that copy, `Quit()` only for an instance it started and proved
  by process id (checked again before the call: still the only POWERPNT process, still `-Embedding`), releasing every
  COM reference (two GC rounds), deleting the copy, and the timeout. It never ends a PowerPoint process.
- PowerPoint runs as one process: if you start PowerPoint (or open a `.pptx` from an e-mail, in Protected View) while a
  run's own hidden instance is up, yours joins that instance. So right before `Quit()` the module reads what the
  instance shows (ruling M1-R73, `Get-DeckbackAuthorSigns`): an open presentation, a document window, a Protected View
  window, the application visible (your start screen), `UserControl` where the application has it. With any of these it
  does not quit: it releases its COM references, leaves PowerPoint running and says so (`leftRunning`, and a warning in
  `message`: "the PowerPoint this run started (process id N) was left running: ..."). Such a PowerPoint is yours to
  close when you are done with it; it may stay open with no window (see the manual cleanup below).
  `test_com_module.ps1` checks each case with a PowerPoint of its own, and its static guard checks that `Quit()` is
  called only there and only after that check.
- A call PowerPoint refuses because it is busy (`RPC_E_CALL_REJECTED`, `RPC_E_SERVERCALL_RETRYLATER`: a dialog is open
  in it, possibly yours) ends the run with exit code 3 and `busy` true (ruling M1-R74); `render.ps1` then exits 5 and
  `export.ps1` records the reason `powerpoint-busy`, so that it is not counted against the deck. Such a run is not
  retried.
- `-RequireOwned` is for an action that may change state shared by the whole application, such as the active printer
  (which is the author's when the author has PowerPoint open). The action then runs only in an instance this run started
  (`ownedPid`, proved by process id right after the attach): with a POWERPNT process around, the run is skipped before the
  copy is opened and the action is not run (`exitCode 4`, `skipped`, `ok` false; not an error). It is checked before the job
  starts and again inside the job right after its attach, so a PowerPoint that started in between is caught too. Only
  such an action may name `ActivePrinter` (without `-RequireOwned` an action that does is rejected, exit code 3).
- One run at a time: `Invoke-DeckbackPowerPoint` holds the named mutex `Global\deckback-powerpoint` while it
  works. A second run, from any process, waits for it up to its own time limit and then gives up with exit
  code 3 and a message saying so, without touching PowerPoint.
- The time limit is `120 s + 4 s per slide` by default (`Get-DeckbackTimeout`, slides counted by
  `Get-PptxSlideCount` from the zip, without PowerPoint); `-TimeoutSec` overrides it. On timeout the module
  asks its job to stop. If the action was only waiting, the job still closes the copy and quits only an
  instance it started. If a PowerPoint call is blocked (a dialog), the job cannot stop: it is left alone,
  `stuck` is true and the message says what may be left behind (manual cleanup below). A normal `exit` of the
  calling process would then wait for that job, possibly forever, so a script ends with
  `[Environment]::Exit(<code>)` when `stuck` is true (`render.ps1` and `m0_7_make_deck.ps1` do). The job host is
  created without inheriting any handle of the caller, so a caller that reads the script's output to the end
  (Python's `subprocess` with `capture_output`) gets it as soon as the script exits.
- `message` may contain input paths (for example "file not found: <path>"). Treat it as private: do not copy it
  into results JSON or the dashboard.
- `Connect-DeckbackPowerPoint` / `Disconnect-DeckbackPowerPoint` attach with ownership decided by process id
  and release again. Disconnect goes by what Connect recorded, not by the session object's properties, and
  ignores objects Connect did not return. The module's job uses them, and so do the tests that play the author;
  harness scripts use `Invoke-DeckbackPowerPoint` only.

### Feature atlas (`harness/atlas/build.py`)

The test decks are authored with python-pptx (no PowerPoint), so building is deterministic: the same code and inputs
give byte-identical `.pptx` files.

```powershell
harness/.venv/Scripts/python -m harness.atlas.build --deck atlas --fonts ofl --out out/atlas
harness/.venv/Scripts/python -m harness.atlas.build --deck sizes --fonts ofl --out out/atlas
harness/.venv/Scripts/python -m harness.atlas.build --deck probe --fonts ofl --out out/atlas
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/atlas.pptx --out out/atlas
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/sizes-43.pptx --out out/atlas --variants std,notags
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/probe.pptx --out out/atlas --variants std,notags
```

The sizes decks `sizes-a4l`, `sizes-a4p` and `sizes-custom` are exported as `sizes-43` is. `npm run oracle:sweep`
expects exactly these exports in `out/atlas` (with `atlas-com`'s, below): the atlas in all six variants and every
other deck in `std` and `notags` (`SWEEP_PDFS` in `packages/core/test/helpers/sweep.ts`, ruling M2-R30); a missing one
fails it.

`build` writes `<out>/<deck>.pptx` and `<out>/<deck>.manifest.json` for each deck of a recipe
(`harness/atlas/decks.py`):

| `--deck` | decks | what |
|---|---|---|
| `atlas` | `atlas` | the full feature atlas: every section of `harness/atlas/sections/` (shapes, lines, fills, effects, text, WordArt, tables, charts, pictures, backgrounds, fonts, hidden slides), 16:9 |
| `atlas-smoke` | `atlas-smoke` | the atlas's `smoke: true` slides, keeping their atlas ids (the public corpus deck; `publish` builds it) |
| `probe` | `probe` | the three-slide probe (shapes and lines, a table with a picture, a chart) |
| `sizes` | `sizes-43`, `sizes-a4l`, `sizes-a4p`, `sizes-custom` | four slides each at 4:3, A4 landscape, A4 portrait and a 1000 x 1000 pt square |

- `--fonts ofl` uses only the OFL fonts of `harness/fonts/fonts.lock.json` and first checks them (`fontcheck`, see
  "OFL fonts"); if a locked file is missing, differs or has a twin it exits 3, naming the family, before writing
  anything. `--fonts windows` uses Malgun Gothic and other Windows fonts, skips the check, and may write only into
  `out/`, `corpus/private/` or the system temp folder, never into `corpus/generated/` (exit 2).
- Exit codes: 0 built, 2 usage error or a refused `--fonts windows` location, 3 OFL fonts not ready or not checkable.
- The manifest lists every slide: its id (also printed on the slide as its label), section, the features it
  exercises, `hidden`, `smoke` and `knownBitmapText`.
- Then export each deck (below). The fidelity run measures `out/atlas` (its `atlas` set: the atlas and the sizes decks)
  and `npm run oracle:sweep` walks every PDF there; both need the export stamp, so after rebuilding a deck export it
  again.

#### COM-authored supplement (`harness/atlas/com_deck.py`, `author_com.ps1`)

python-pptx cannot write SmartArt, SVG pictures or picture effects (`decks.EXCLUDED`), so a supplement deck has them
authored by PowerPoint's COM interface, and its PDFs widen what `npm run oracle:sweep` walks:

```powershell
harness/.venv/Scripts/python -m harness.atlas.com_deck --out out/atlas
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/atlas-com.pptx --out out/atlas --variants std,notags
```

`com_deck` writes `<out>/atlas-com.pptx` and `<out>/atlas-com.manifest.json`: nine slides with ids
`atlas-com/<section>/<nn>`, in the OFL fonts (Korean text in Pretendard): `smartart` (basic process, cycle, hierarchy,
pyramid), `svg` (a filled icon, a dashed and gradient-stroked icon, an icon with nested transforms and a clip) and
`pictureEffects` (pencil sketch and blur on a JPEG, shown next to the original). python-pptx writes the base deck (title,
caption and label of every slide, like every atlas deck); the SVG icons (from strings) and the JPEG (with Pillow) are
generated into a temp directory at run time and removed afterwards, so nothing binary is committed;
`harness/atlas/author_com.ps1` then adds the SmartArt, the pictures and the effects in one run of
`Invoke-DeckbackPowerPoint` (a GUID-named temp copy, windowless, the module's rules; `AddSmartArt`, `AddPicture`,
`Fill.PictureEffects.Insert`, then `SaveCopyAs` to the output). The deck is not byte-deterministic and is never committed:
it is written only inside `out/`, `corpus/private/` or the temp directory, never `corpus/generated/` (exit 2).

The run never opens a window. A call that cannot work without one is not worked around: its slide is left out of the deck
and the manifest, and its feature goes to the manifest's `excluded` as `<kind>:<variant>` (`smartArt`, `svgIcon`,
`artisticEffects`) with the reason, which is also printed. On PowerPoint 2024 (16.0.17932) `Application.SmartArtLayouts`
(and `SmartArtColors`, `SmartArtQuickStyles`) is not available to a windowless instance (error 0x80048010, "Object does
not exist"), so the four SmartArt slides are recorded that way, and the deck then has five slides. A call PowerPoint
refuses because it is busy (a dialog is open in it, possibly yours: `RPC_E_CALL_REJECTED`, `RPC_E_SERVERCALL_RETRYLATER`)
is no such failure and no fault of a slide (ruling M1-R74): for every call the script's action makes, at any slide, it
fails the whole run as `powerpoint-busy` (exit 3, nothing written), and nothing is put in `excluded`. Method calls throw;
every property read and write goes through `InvokeMember` (`Get-ComProperty`, `Set-ComProperty`), because PowerShell's COM
adapter can turn a failing read into `$null` without an error, which would hide the refusal. Open: the calls the module
makes itself (opening and closing the copy, its checks before it quits an instance) are outside this script and follow the
module's own rules. Exit codes: 0 deck written (also with excluded features), 2 usage error or refused location, 3 OFL
fonts not ready, or PowerPoint did not author the deck (a timeout, PowerPoint busy, an error: nothing written). The
command does not check the declared features itself: the `powerpoint` test in `test_com_deck.py` runs the whole path and
checks each of them on the authored deck (`com_deck.missing_features`), with
`pytest --run-powerpoint -k test_authored_deck_really_has_the_features`; `-k test_a_busy_refusal` runs the busy cases
with hooks that raise the refusal at one slide or at one property read.

#### Windows-font atlas (`atlas-win`)

The atlas built with Malgun Gothic, Batang and Gulim is a second set for the sweep (`atlas-win`, a gate); the PDFs embed
Microsoft fonts and stay under `out/`:

```powershell
harness/.venv/Scripts/python -m harness.atlas.build --deck atlas --fonts windows --out out/atlas-win
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas-win/atlas.pptx --out out/atlas-win --variants std,notags
```

`npm run oracle:sweep` walks `out/atlas` (`atlas`), `out/atlas-win` (`atlas-win`) and `out/producers` (`producers`, no
gate), converts every page to a Scene as well, and writes `out/sweep/<date>-oracle-sweep.json`, schema
`deckback.oracle-sweep/3`; only `DECKBACK_SWEEP_RECORD=1` also writes the committed `fidelity/results/` file
(`fidelity/README.md`), and only for a passing run whose every PDF has a name a committed source gives (ruling
M2-R30). It fails if `atlas` or `atlas-win` was not swept (no PDF in its directory), lacks one of the PDFs it must
hold, or any of their pages does not match the oracle, so build and export both before running it.

#### Other producers: Skia PDFs from the browser (`harness/producers`)

Everything measured so far is PowerPoint output. To see what the walker meets in a PDF from another tool, Playwright's
Chromium prints six small pages to PDF (its PDF backend is Skia):

```powershell
npm run producers:skia   # from the repository root; writes out/producers/skia-<page>.pdf
npm run oracle:sweep     # walks them as the set `producers`
```

`harness/producers/make_skia.mjs` prints each page of `harness/producers/pages/` (`gradients`, `transparency`, `clips`,
`text`, `patterns`, `images`) with `page.pdf({ printBackground: true, preferCSSPageSize: true })`, one 960 x 540 pt PDF
page each. It finds Chromium the way the e2e tests do (`@playwright/test` of the workspace `apps/web`; if the browser is
missing, `npx playwright install chromium`), prints the Chromium version, and fails if a page prints as more than one PDF
page, a page script throws, or a page asks for the network (only `data:`, `about:` and a `file:` URL of this machine are
allowed, `harness/producers/requests.mjs`: a `file:` URL with a host, or with an empty host and a UNC-like path such as
`file:////host/...` or `file:///%5C%5Chost/...`, would be read over SMB). The pages are plain HTML
with system fonts (Malgun Gothic, Segoe UI, Batang, Gulim, Consolas, Segoe UI Emoji) and no network; the two tiny images
(a 16 x 16 PNG with alpha, a 24 x 24 JPEG) are data URIs inside the HTML. `scripts/producer-pages.test.mjs` checks that
the pages exist and name no address but a data URI or a fragment (in `src`, `href`, `url()`, `@import`, `srcset` and
`image-set()`), and which requests the maker allows.

These PDFs are **local-only**: they embed Windows system fonts, so they stay under `out/` (gitignored) and are never
committed, like `out/atlas-win`. They are **not a gate**: a non-PowerPoint PDF is outside the "perfect" promise (spec
section 2), so the `producers` set only shows what the walker must survive (`gate: false`; a diff or an unsupported
operator there fails nothing). The sweep records only the first unsupported operator of a page, so the unsupported counts
for `producers` are a lower bound.

### Export variants (`harness/atlas/export.ps1`, `export.py`)

PowerPoint turns an authored deck (the atlas, the probe) into the PDFs every test uses, and into ground-truth PNGs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File harness/atlas/export.ps1 -Pptx out/atlas/atlas.pptx -OutDir out/atlas -GroundTruth
harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/atlas.pptx --out out/atlas --ground-truth
```

It writes `<OutDir>/<stem>_<variant>.pdf` for `std`, `min` (minimum size), `notags`, `pdfa`, `hidden` (hidden slides
included) and `msprint` (the Microsoft Print to PDF printer). `-Variants std,min` picks some; `-GroundTruth` adds
`gt/<stem>/slide<N>.png` (8-bit RGB, 2 px/pt, by the same BMP route as `render.ps1`, whose action text lives in
`harness/ppt/slide_png_action.ps1`) and `gt/<stem>/map.json`, which maps each slide number to its page number in the `std`
PDF (`null` for a hidden slide). The last stdout line is one JSON line with `ok`, `exitCode` (the module's 0 / 2 / 3 / 4),
`pages`, `expectedPages` and `seconds` per variant. Each variant is a PowerPoint run of its own, one after another (a hang
costs one time limit and is recorded); if a run comes back `stuck` the rest are recorded as `skipped-after-stuck` and the
script ends with `[Environment]::Exit`. Exit code 0 all exported, 2 a run timed out, 3 bad arguments or a variant failed; an
unexpected exception still writes the JSON line (exit 3). `export.py` wraps it (`export(pptx, out_dir, variants,
ground_truth)`; it gives up waiting after a limit derived from the module's time limits, without stopping the script) and adds
`fonts`: the font programs embedded in the `std` and in the `msprint` PDF (family, PostScript name, `variable` = has an
`fvar` table). Its `stderr` field holds the module's messages, which quote paths: keep it private. It also writes the
export stamp `<OutDir>/<stem>.export.json` (ruling M1-R77): the SHA-256 of the deck, of its manifest
(`<stem>.manifest.json` next to it) and, per variant exported `ok`, of the PDF, with the PowerPoint version. The
fidelity run measures a PDF only when its stamp records it as the export of the deck and manifest next to it, so a
rebuilt deck must be exported again.

What a variant must have to be `ok`: its PDF has `expectedPages` pages, a number taken from the deck file itself
(`ppt/presentation.xml`, slides with `show="0"` are hidden): all slides for `hidden`, the visible ones for every other
variant. Otherwise it is `ok: false` (`page-count-mismatch`, or `slide-count-mismatch` when PowerPoint sees a different
number of slides than the file has, as after a repair) and its PDF is deleted.

Things to know when reading these PDFs:

- `msprint` sets the presentation's printer (`PrintOptions.ActivePrinter`), `PrintInBackground = 0` and
  `PrintHiddenSlides = 0` (PowerPoint's default prints hidden slides; `std` does not, and `msprint` mirrors `std`, ruling
  M1-R28). Ruling M1-R27: because a printer setting may be application-wide, `msprint` runs only in a PowerPoint this run
  started (`Invoke-DeckbackPowerPoint -RequireOwned`). If a PowerPoint was already running it is recorded `ok: false`,
  `exitCode: 4`, reason `skipped: PowerPoint already running (msprint changes the shared ActivePrinter)`, PowerPoint is not
  touched for it, and the export still exits 0; a missing printer is recorded the same way (`printer-missing`). Nothing in
  PowerPoint is restored afterwards: the instance is the run's own and is quit. (Measured on one PC: setting the
  presentation's printer to another printer left the application's `ActivePrinter` alone, so the rule is conservative.)
  The temp copy is never saved. The print job is a real one, and with Windows' "Let Windows manage my default printer"
  on, Windows may make `Microsoft Print to PDF` your default printer: so `export.ps1` reads the Windows default printer
  before `msprint` and, if it changed, puts it back afterwards (`harness/atlas/default_printer.ps1`; with the printer
  API, and Windows' setting back too if that call turned it off). The `msprint` record says `defaultPrinter`:
  `unchanged`, `restored`, `not-restored` or `unknown` (minor m5).
- With `BitmapMissingFonts = -1` (every variant but `msprint`) PowerPoint draws text in a font it will not embed as
  a bitmap (an image in the text colour with a 1-bit mask at 600 dpi; no text layer). It does not embed OpenType-CFF
  fonts, which is why the lock's role fonts are all TrueType (see "OFL fonts" above). With them every `std` and
  `notags` page of the atlas and the probe has a text layer with at least the slide's label (its id), except the
  deliberate CFF sample `atlas/fonts/01`; but not all of a slide's text is in it. PowerPoint exports text rotated at an
  angle that is not a multiple of 90 degrees, text in a rotated shape or group, outline-only, unfilled or
  gradient-filled text and most WordArt warps as vector outlines (with no text, or invisible text), and some effect
  slides are partly bitmaps. The manifest's features say which slides those are, and the fidelity run records them as
  the `known` classes `textAsOutlines` and `bitmapEffect` (`fidelity/README.md`). `fonts` in the export result lists
  the embedded programs (`family` is nameID 1, as in the lock); check it before trusting a PDF's text.

### Public test corpus (`harness/atlas/publish.py`, `corpus/generated/`)

```powershell
harness/.venv/Scripts/python -m harness.atlas.publish [--force]
harness/.venv/Scripts/python -m pytest harness/atlas/test_corpus.py
git add corpus/generated
node scripts/check-no-binaries.mjs --all
```

`check-no-binaries --all` checks the files git holds (the index), never the working tree, so stage the published
corpus first (`git add corpus/generated`); run before that, it would check the previously committed files again.

`publish` builds the `probe` deck and the `atlas-smoke` deck (the full atlas with every non-`smoke` slide dropped before
saving, so slides keep their atlas ids), has PowerPoint export `std` and `notags` PDFs through `export.py` (plus the
probe's ground truth PNGs), stages the whole corpus and installs it into `corpus/generated/` (committed) only if
`corpuscheck.py` finds nothing wrong. The same checks run in `test_corpus.py`: every embedded font program of every PDF
is TrueType, not variable and one lock file (nameID 1 plus nameID 6), the PDFs name only `deckback harness` as author
and PowerPoint as creator and producer (no Office account name), the decks and their chart workbooks likewise, and the
embedded fonts across the PDFs are exactly the lock's TrueType files (the smoke deck includes `atlas/text/05`, which
uses every role face, for that); a font PowerPoint substituted is fixed in the deck content, never in the test.
PowerPoint's PDFs and PNGs differ on every export (creation time, document ids), so a deck whose rebuilt `.pptx` and
manifest are the committed ones, with a committed export stamp that records the committed PDFs, is not exported or
rewritten (M1-R30, M1-R77); `--force` exports again. If the PDFs would exceed the guard's
limits (3 MiB per file, 12 MiB in all) smoke slides are dropped from the end until they fit and listed in `manifest.json`
(`dropped`). `corpus/generated/README.md` is hand-written (contents, licenses: CC0-1.0 content, OFL-1.1 fonts).

### 51-slide test deck (`harness/spikes/m0_7_make_deck.ps1`)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File harness/spikes/m0_7_make_deck.ps1   # writes out/m0/deck51.pdf
```

Spike M0-7 needs a 51-page PowerPoint-exported PDF. The script duplicates the 3 slides of
`corpus/private/probe/original.pptx` (in a copy) until there are 51, saves the copy as `out/m0/deck51.pdf` and
asks PyMuPDF for the page count (exit 4 if it is not 51). It drives PowerPoint through the same module as
`render.ps1` (same exit codes 0 / 2 / 3, same temp copy `%TEMP%\deckback-com-<id>.pptx`), so the manual cleanup
below applies to it unchanged. Its default time limit is `120 s + 4 s` for each slide of the finished deck.

`-OutPdf` must end in `.pdf` and must not be the input (it is deleted before the run). On every failure exit
(2, 3, 4) the PDF this run wrote is deleted, and nothing else. `harness/spikes/test_m0_7_make_deck.ps1` checks this
and that an author's own PowerPoint session survives a run (it prints `DECK SCRIPT TESTS OK`; it skips the session
check when a PowerPoint is already running).

### After a timed-out run (exit code 2): manual cleanup

A fidelity run stops using PowerPoint after the first timeout: every later render, ground truth and S7 of that run is
recorded as `skipped-after-stuck` (ruling M1-R74). Clean up as below, then run it again.

Because the scripts never kill anything, a run that timed out can leave things behind on purpose. The
message on stderr (or the module's `message`) says which. When the run was only waiting, the module's stopped
job cleans up after itself and nothing is left; leftovers come from a PowerPoint call that is blocked, for example
by a repair or other modal dialog. Check, and close by hand only what is yours:

1. **A PowerPoint the script started** (stderr: "New PowerPoint process id(s) ... appeared"). It has no
   window and its command line contains `-Embedding`; a PowerPoint you opened yourself does not:

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='POWERPNT.EXE'" | Select-Object ProcessId, CreationDate, CommandLine
   ```

   **Never run the snippet below while you have any PowerPoint document open.** You cannot choose which
   PowerPoint `GetActiveObject` attaches to: it can return your own PowerPoint, not the leftover one. Close your own documents (or wait until
   you are done) first. The snippet then quits only an instance with no presentation open, and leaves
   anything else alone:

   ```powershell
   $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
   if ($app.Presentations.Count -eq 0) { $app.Quit() } else { 'documents open - leave it' }
   ```

   If `GetActiveObject` fails (the instance is hung), end that one process id in Task Manager
   (Details tab). Never end a PowerPoint that has your documents open.
2. **A windowless presentation left open in your own PowerPoint** (stderr: "may still be open"). It is
   named `deckback-com-<id>.pptx`, opened read-only, and has no window, so you will not see it. Close
   exactly those:

   ```powershell
   $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
   foreach ($p in @($app.Presentations)) { if ($p.Name -like 'deckback-com-*.pptx') { $p.Close() } }
   ```
3. **The PowerShell job host** that was running the COM call: `powershell.exe -Version 5.1 -s -NoLogo
   -NoProfile` (stderr: "The PowerPoint job did not stop"). It normally exits together with its parent. If one
   is still there and its parent process no longer exists, end it in Task Manager; it is a PowerShell process,
   not PowerPoint.

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
     Where-Object { $_.CommandLine -like '*-Version 5.1 -s -NoLogo*' } |
     Select-Object ProcessId, ParentProcessId, CreationDate
   ```
4. **Temp copies** (stderr: "could not delete the temp copy"): delete `%TEMP%\deckback-com-*.pptx` once
   PowerPoint no longer has them open.
5. **A PowerPoint a run started and left running because it showed signs of use** (message: "was left running: it
   shows signs of use", ruling M1-R73): it is the instance you joined, or one that became visible. Close your own
   documents in it as usual; if a PowerPoint stays running with no window afterwards, open PowerPoint from the Start
   menu (it joins that instance) and close its window, or use the snippet in 1.
6. **`test_render_safety.ps1` or `test_com_module.ps1` timed out**: it may have left an untitled presentation
   (named like `Presentation1`) and a `same-file.pptx` window open in PowerPoint. Close both without saving
   (`out/m0/render-safety/same-file.pptx` and `out/m1/com-module/same-file.pptx` are scratch copies, so nothing
   is lost).
