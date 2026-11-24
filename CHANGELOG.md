# Changelog

All notable changes to deckback. The versions before 1.0.0 were milestones inside a private repository (the gate records are in `docs/decisions/`); 1.0.0 is the first release.

## 1.0.0

The first release: a PDF to an editable PowerPoint converter that runs on your own computer. Summary of milestones M0 to M8, then what M9 adds.

### What it does

- Converts a PDF to a PPTX whose text boxes, shapes, lines, pictures and gradients are objects you can edit. Conversion output is deterministic: the committed corpus is checked byte by byte (hash) and with the Open XML validator.
- Three ways to use it: a static web site (`apps/web`, converts in the browser, works offline; not deployed yet, run it locally), the `deckback` command line (`npx deckback@1.0.0` once published to npm; not yet), and a Claude Code skill (`skills/pdf-to-pptx`).
- A conversion report (JSON) per run: per-slide counts, what was approximated or replaced by a picture, fonts, and the program that made the PDF. It holds no document text.
- Options: `--pages`, `--font-map`, `--embed-fonts`, `--scene`, `--strict`.

### Measured (M8, `docs/decisions/0011-m8-real-pdf-gate.md`)

- Tier A (our own CC0 test decks, 350 slides): 231 pass (66.0 %).
- Tier B (public real PDFs, 71 PowerPoint (Windows) decks, 1,781 slides): 1,115 pass every gate (62.6 %); 39 of them are position-verified, so 1,076 pass on the gates alone. 666 do not; the causes are listed under "Known limits" in the README and in 0011.
- All 200 tier-B decks (71 PowerPoint (Windows) and 129 other producers): 0 crashes, 0 PowerPoint repair windows.
- Tier C (one author deck, Acrobat PDFMaker, reported only): 12 of 21 slides pass.
- The promise covers PDFs saved by PowerPoint for Windows. Other producers convert but are only reported.

### Milestones

- **M0 engine gate (0001, 0002).** The engine (pdf.js, run in a worker; Node and four browsers give the same result) and the inventory contract.
- **M1 measurement harness (0003).** The fidelity harness: renders every slide with PowerPoint and MuPDF, pixel gates V1 and V2, structural checks S1 to S7, the feature atlas, the PyMuPDF oracle, CI.
- **M2 walker and Scene (0004).** The page walker and the Scene schema v1 (the PDF as the converter reads it).
- **M3 PPTX writer (0005).** The writer, with parity against the experimental converter; PowerPoint opens the output without repair.
- **M4, M4b text quality (0006, 0007).** Baselines, spacing, kerning, text drift handling, font name tables from public sources only.
- **M5 fills, pictures, fallbacks (0008).** Gradients, patterns, pictures, effects, and an honest fallback to a picture where an effect cannot be built.
- **M6 web site (0009).** The static site: drop a PDF, convert in the browser, offline use, a service worker, the report panel, Korean and English.
- **M7 command line and skill (0010).** The `deckback` package (no runtime dependencies, bundled pdf.js and fflate, CJK character maps) and the Claude Code skill.
- **M8 real PDFs (0011).** 200 public decks gathered, three fix rounds, the numbers above, and the known limits.

### M9, release preparation

- The package, the skill's pin and the site footer say 1.0.0.
- README in Korean and English with the measured numbers and comparison pictures made from our own CC0 test deck (`docs/images/`, `scripts/make-comparison-images.py`).
- CHANGELOG, CONTRIBUTING, SECURITY, NOTICE ("Copyright 2026 the deckback authors").
- **Pending:** the npm release and the web site deploy have not happened. Until they do, README, the CLI README and the skill say "coming soon" and show how to use deckback from source, from a locally packed tarball (`npm pack -w packages/cli`, then `npx --yes --package ./deckback-1.0.0.tgz -- deckback ...`), and the site locally (`npm run dev --workspace apps/web`). The skill needs `DECKBACK_NPX_SPEC` until then. The repository will be https://github.com/hakm12-ship-it/deckback.
- `scripts/release-check.mjs` (tests, pack, privacy scan of the tree, history scan with `--fresh` or `--full`) and `scripts/fresh-export.mjs` (a one-commit copy of the tree for a new public repository). The binary guard has an explicit allowlist (path and SHA-256) for the comparison pictures.
