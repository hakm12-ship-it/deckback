"""Publish the small public test corpus that is committed to the repository (corpus/generated/).

  harness/.venv/Scripts/python -m harness.atlas.publish [--force]

Needs Windows with desktop PowerPoint and the OFL fonts of harness/fonts/fonts.lock.json installed (run
harness/fonts/install-fonts.ps1). It builds two decks with python-pptx, has PowerPoint export them (through
harness/atlas/export.py and harness/ppt/DeckbackCom.psm1, never directly) and puts the results into
corpus/generated/:

  probe.pptx          the M0 probe deck re-created in the OFL fonts (3 slides)
  probe_std.pdf       PowerPoint's standard (tagged) PDF export of it
  probe_notags.pdf    the same without the structure tree
  probe_gt/           slide1..3.png, PowerPoint's own render of each slide (1920x1080), and map.json (slide -> std page)
  atlas-smoke.pptx    the `smoke: true` slides of the atlas, with their atlas ids (recipe `atlas-smoke`)
  atlas-smoke_std.pdf, atlas-smoke_notags.pdf
  probe.manifest.json, atlas-smoke.manifest.json   the decks' slide manifests (ids, features, flags)
  probe.export.json, atlas-smoke.export.json       the export stamps (M1-R77): which deck and manifest the PDFs are
                                                   exports of (export.py writes them)
  fallback/*.pdf      the raster fallback fixtures (M5 Task 2), synthetic PDFs harness/atlas/fallback_pdfs.py writes
                      byte for byte the same every time (no PowerPoint)
  manifest.json       {files: [{path, sha256, bytes, pages|null}], fonts: [family], dropped: [slide id]}

`fonts` are the families whose programs the PDFs embed (nameID 1); `dropped` are the smoke slides left out because
the files would otherwise exceed the size limits of scripts/check-no-binaries.mjs (3 MiB per file, 12 MiB in all):
slides are dropped from the end of the manifest order until everything fits. The hand-written README.md is never
touched.

Ruling M1-R30: PowerPoint's PDFs and PNGs change on every export (creation time, document ids), so a deck whose rebuilt
.pptx is byte-for-byte the committed one is neither exported nor rewritten: its committed PDFs and PNGs are kept (the
smoke deck is rebuilt with the slides that manifest.json says were dropped). With the export stamps (M1-R77) that also
needs the rebuilt manifest to be the committed one and the committed stamp to record the committed PDFs; otherwise the
deck is exported again. `--force` exports everything again.

The gate: everything is staged in out/publish/stage/ in its final layout and harness/atlas/corpuscheck.py (the same
checks harness/atlas/test_corpus.py runs on what is committed: embedded fonts, author and creator metadata, fonts named
by the decks, ground truth, every lock TrueType font embedded) must find nothing, or nothing at all is installed. The
install then copies each changed file next to its place and renames it over (an unchanged file is left alone), and
deletes files that are no longer part of the corpus only after all new ones are in place, manifest.json last of the
new ones; a failure leaves the old corpus whole.

The .pptx files are byte-for-byte reproducible; the PDFs are not.

Exit codes: 0 published, 1 an export failed, the checks failed or the corpus cannot fit the limits, 2 usage error,
3 OFL fonts missing (nothing done).
"""

import argparse
import hashlib
import json
import math
import os
import shutil
import sys
from pathlib import Path

import pymupdf

from harness.atlas import build, corpuscheck, decks, export, fallback_pdfs

REPO_ROOT = build.REPO_ROOT
CORPUS_DIR = REPO_ROOT / "corpus" / "generated"
WORK_DIR = REPO_ROOT / "out" / "publish"
VARIANTS = ["std", "notags"]
MAX_FILE_BYTES = 3 * 1024 * 1024  # scripts/check-no-binaries.mjs
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MIN_SMOKE_SLIDES = 30
RESERVE_BYTES = 128 * 1024  # room for the slide manifests, manifest.json and README.md
README = "README.md"
MANIFEST = "manifest.json"
PROBE_GT_DIR = "probe_gt"


class PublishError(RuntimeError):
    pass


def build_into(work, spec, drop=()):
    """Author `spec` (without the slides in `drop`) into `work` as <name>.pptx and <name>.manifest.json."""
    deck = decks.build_deck(spec, "ofl", drop=drop)
    pptx = deck.save(Path(work) / f"{spec.name}.pptx")
    manifest = deck.manifest()
    build.write_manifest(Path(work) / f"{spec.name}.manifest.json", manifest)
    return pptx, manifest


def export_deck(export_fn, pptx, work, ground_truth):
    """Have PowerPoint export `pptx` (std and notags, plus the ground truth PNGs) into `work`; PublishError unless
    every part succeeded. The script's stderr quotes paths and is never printed."""
    result = export_fn(pptx, work, VARIANTS, ground_truth)
    for variant in VARIANTS:
        record = result["variants"].get(variant) or {}
        if not record.get("ok"):
            reason = record.get("reason", "see the exit code")
            raise PublishError(f"{Path(pptx).stem}: the {variant} export failed ({reason}; "
                               f"exit code {record.get('exitCode')})")
    if ground_truth and not (result.get("groundTruth") or {}).get("ok"):
        raise PublishError(f"{Path(pptx).stem}: the ground truth export failed")
    return result


def deck_files(work, stem):
    return [Path(work) / f"{stem}.pptx", *(Path(work) / f"{stem}_{variant}.pdf" for variant in VARIANTS)]


def fit_smoke(work, export_fn, *, fixed_bytes, max_file=MAX_FILE_BYTES, max_total=MAX_TOTAL_BYTES,
              min_slides=MIN_SMOKE_SLIDES, reserve_bytes=RESERVE_BYTES):
    """Build and export atlas-smoke into `work`, dropping slides from the end of its manifest order until no file is
    over `max_file` and `fixed_bytes` (the rest of the corpus) plus the deck's files plus `reserve_bytes` are within
    `max_total`. Returns (manifest of the deck as exported, [dropped slide ids in manifest order])."""
    spec = decks.RECIPES["atlas-smoke"]("ofl")[0]
    order = [entry["id"] for entry in decks.build_deck(spec, "ofl").manifest()["slides"]]
    dropped = []
    while True:
        pptx, manifest = build_into(work, spec, dropped)
        export_deck(export_fn, pptx, work, ground_truth=False)
        sizes = [path.stat().st_size for path in deck_files(work, spec.name)]
        total = fixed_bytes + sum(sizes) + reserve_bytes
        excess = max((max(sizes) - max_file) / max(sizes), (total - max_total) / total, 0)
        if not excess:
            return manifest, sorted(dropped, key=order.index)
        kept = [entry["id"] for entry in manifest["slides"]]
        count = max(1, math.floor(len(kept) * excess))  # an estimate that errs low; the loop then goes on one by one
        if len(kept) - count < min_slides:
            raise PublishError(f"atlas-smoke cannot keep at least {min_slides} slides within the size limits "
                               f"({len(kept)} kept so far, largest file {max(sizes)} bytes, total {total} bytes)")
        dropped += kept[-count:]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def corpus_manifest(root, dropped):
    """manifest.json's content: every file under `root` except manifest.json and README.md, and the embedded
    families."""
    files, families = [], set()
    for path in sorted(p for p in Path(root).rglob("*") if p.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative in (README, MANIFEST):
            continue
        pages = None
        if path.suffix == ".pdf":
            with pymupdf.open(path) as doc:
                pages = doc.page_count
            families |= {family for family, _ in corpuscheck.pdf_font_problems(path)[1]}
        files.append({"path": relative, "sha256": sha256(path), "bytes": path.stat().st_size, "pages": pages})
    return {"files": files, "fonts": sorted(families), "dropped": list(dropped)}


# --- what is already committed ----------------------------------------------------------------------------------------


def companions(stem, slides):
    """The files the committed corpus keeps next to <stem>.pptx, as paths relative to corpus/generated/: the PDFs and
    their export stamp (M1-R77), and for the probe its ground truth (PowerPoint's render of every slide and the
    slide-to-page map)."""
    names = [f"{stem}_{variant}.pdf" for variant in VARIANTS] + [export.stamp_path(".", stem).name]
    if stem == "probe":
        names += [f"{PROBE_GT_DIR}/slide{n}.png" for n in range(1, slides + 1)] + [f"{PROBE_GT_DIR}/map.json"]
    return names


def committed_dropped(corpus):
    """The slide ids the committed manifest.json says were dropped from atlas-smoke ([] if unreadable)."""
    try:
        dropped = json.loads((Path(corpus) / MANIFEST).read_text(encoding="utf-8"))["dropped"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return [d for d in dropped if isinstance(d, str)] if isinstance(dropped, list) else []


def unchanged(corpus, pptx, force):
    """True when the committed <stem>.pptx and <stem>.manifest.json are exactly the rebuilt ones, everything exported
    from them is there, and the committed export stamp records the committed PDFs as exports of them (M1-R30,
    M1-R77)."""
    pptx, corpus = Path(pptx), Path(corpus)
    committed = corpus / pptx.name
    manifest = pptx.with_name(f"{pptx.stem}.manifest.json")
    committed_manifest = corpus / manifest.name
    if force or not committed.is_file() or committed.read_bytes() != pptx.read_bytes():
        return False
    if not committed_manifest.is_file() or committed_manifest.read_bytes() != manifest.read_bytes():
        return False
    if not all((corpus / name).is_file() for name in companions(pptx.stem, export.slide_count(pptx))):
        return False
    return all(export.stamp_problem(corpus / f"{pptx.stem}_{variant}.pdf", variant, committed, committed_manifest)
               is None for variant in VARIANTS)


def stage_deck(stage, work, corpus, pptx, reuse):
    """Put a deck's files into `stage` in their final layout: the freshly built deck and manifest always, the PDFs and
    ground truth from the committed corpus when `reuse`, else from this run's export in `work`."""
    stage, work, corpus, pptx = Path(stage), Path(work), Path(corpus), Path(pptx)
    stem = pptx.stem
    for name in (pptx.name, f"{stem}.manifest.json"):
        shutil.copyfile(work / name, stage / name)
    for name in companions(stem, export.slide_count(pptx)):
        source = corpus / name if reuse else (
            work / "gt" / stem / Path(name).name if name.startswith(PROBE_GT_DIR) else work / name)
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, stage / name)


def install(stage, corpus):
    """Make `corpus` (corpus/generated/) equal `stage`, keeping README.md, without ever leaving it half done. Each
    changed file is copied beside its place and renamed over it (an unchanged file is not touched), manifest.json is
    the last of them, and only then are files that are no longer in the corpus deleted. A failure part-way leaves old
    files, or complete new ones, in place."""
    stage, corpus = Path(stage), Path(corpus)
    if corpus.name != "generated":
        raise PublishError(f"refusing to install into a directory that is not called 'generated': {corpus.name}")
    corpus.mkdir(parents=True, exist_ok=True)
    staged = sorted(p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file())
    for relative in [*(r for r in staged if r != MANIFEST), *(r for r in staged if r == MANIFEST)]:
        source, target = stage / relative, corpus / relative
        if target.is_file() and target.read_bytes() == source.read_bytes():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")
        try:
            shutil.copyfile(source, part)
            os.replace(part, target)
        finally:
            part.unlink(missing_ok=True)
    for path in sorted(corpus.rglob("*"), reverse=True):  # files before their folders
        relative = path.relative_to(corpus).as_posix()
        if path.is_file() and relative != README and relative not in staged:
            path.unlink()
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    return json.loads((corpus / MANIFEST).read_text(encoding="utf-8"))


def publish(corpus=CORPUS_DIR, work=WORK_DIR, export_fn=export.export, check=corpuscheck.corpus_problems, force=False,
            **fit_limits):
    """Rebuild and export the decks that changed, stage the whole corpus, run `check(stage)` (a list of problems) and
    install. `fit_limits` go to fit_smoke. Returns the new manifest.json content."""
    corpus, work = Path(corpus), Path(work)
    if corpus.name != "generated":  # before anything is built or exported
        raise PublishError(f"refusing to publish into a directory that is not called 'generated': {corpus.name}")
    shutil.rmtree(work, ignore_errors=True)
    stage = work / "stage"
    stage.mkdir(parents=True)

    probe_pptx, _ = build_into(work, decks.RECIPES["probe"]("ofl")[0])
    probe_reuse = unchanged(corpus, probe_pptx, force)
    if not probe_reuse:
        export_deck(export_fn, probe_pptx, work, ground_truth=True)
    stage_deck(stage, work, corpus, probe_pptx, probe_reuse)
    fallback_pdfs.write(stage)  # M5 Task 2's fixtures: the generator's bytes, so a publish keeps them

    smoke_spec = decks.RECIPES["atlas-smoke"]("ofl")[0]
    dropped = committed_dropped(corpus)
    try:
        smoke_pptx, _ = build_into(work, smoke_spec, dropped)
    except ValueError:  # the committed manifest names a slide the recipe no longer has
        dropped, smoke_pptx = [], None
    smoke_reuse = smoke_pptx is not None and unchanged(corpus, smoke_pptx, force)
    if not smoke_reuse:
        readme = corpus / README
        fixed = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
        fixed += readme.stat().st_size if readme.is_file() else 0
        _, dropped = fit_smoke(work, export_fn, fixed_bytes=fixed, **fit_limits)
        smoke_pptx = work / f"{smoke_spec.name}.pptx"
    stage_deck(stage, work, corpus, smoke_pptx, smoke_reuse)

    build.write_manifest(stage / MANIFEST, corpus_manifest(stage, dropped))
    problems = check(stage)
    if problems:
        raise PublishError(f"{len(problems)} problem(s) in the staged corpus, nothing was installed:\n  - "
                           + "\n  - ".join(problems))
    return install(stage, corpus)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true",
                        help="export both decks again even if their .pptx is the committed one (M1-R30)")
    args = parser.parse_args(argv)
    problem = build.check_ofl_fonts()
    if problem:
        print(problem, file=sys.stderr)
        return build.EXIT_FONTS
    try:
        manifest = publish(force=args.force)
    except (PublishError, export.ExportError) as exc:
        print(f"publish failed: {exc}", file=sys.stderr)
        return 1
    for entry in manifest["files"]:
        pages = f", {entry['pages']} pages" if entry["pages"] else ""
        print(f"{entry['path']}: {entry['bytes']} bytes{pages}")
    print(f"{len(manifest['files'])} files, {sum(e['bytes'] for e in manifest['files'])} bytes; "
          f"embedded fonts: {', '.join(manifest['fonts'])}; dropped smoke slides: {len(manifest['dropped'])}")
    print("now run: harness/.venv/Scripts/python -m pytest harness/atlas/test_corpus.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
