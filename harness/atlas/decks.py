"""Deck recipes: which sections go into which output deck, at which slide size.

A recipe is a function `(fonts) -> [DeckSpec, ...]`; most recipes produce one deck, `sizes` produces one deck per
slide size. `build.py` writes `<out>/<spec.name>.pptx` and `<out>/<spec.name>.manifest.json` per spec.

- `atlas`: every section at 16:9 (960x540 pt), with two hidden slides between the WordArt and table sections; the
  `fonts` section (one slide of OpenType-CFF text that PowerPoint draws as a bitmap) comes last.
- `atlas-smoke`: the atlas with only its `smoke: true` slides (M1-R5, M1-R24). It is built by authoring the full atlas
  and dropping the other slides before saving, so a slide keeps its atlas id (`atlas/shapes/09`, also the label on the
  slide) and its features; only the manifest's `n` (position in the deck) changes. The deck is named `atlas-smoke`.
- `probe`: the M0 probe deck's three slides, re-created in the OFL fonts.
- `sizes`: four slides at each of 4:3 (720x540), A4 landscape (842x595), A4 portrait (595x842) and a custom
  1000x1000 pt square, written as the decks `sizes-43`, `sizes-a4l`, `sizes-a4p` and `sizes-custom`.

`excluded` lists what the atlas does not author, with the reason, so the measurements never pretend to cover it.
"""

from dataclasses import dataclass, replace

from harness.atlas.deck import AtlasDeck
from harness.atlas.sections import (
    backgrounds,
    charts,
    effects,
    fills,
    fonts as fonts_section,
    hidden,
    lines,
    pictures,
    probe as probe_section,
    shapes,
    sizes as sizes_section,
    tables,
    text,
    wordart,
)

SIZE_16X9 = (960, 540)
SIZE_DECKS = (("sizes-43", (720, 540)), ("sizes-a4l", (842, 595)), ("sizes-a4p", (595, 842)),
              ("sizes-custom", (1000, 1000)))
NOT_AUTHORABLE = "not authorable with python-pptx/DrawingML in M1 — add via COM authoring later"
EXCLUDED = (
    ("svgIcon", NOT_AUTHORABLE),
    ("smartArt", NOT_AUTHORABLE),
    ("artisticEffects", NOT_AUTHORABLE),
    ("3dModel", NOT_AUTHORABLE),
)
# Emoji are authorable (the --fonts windows build has a slide of them); an --fonts ofl deck leaves them out.
EMOJI_EXCLUDED = ("emoji", "no OFL colour-emoji font in harness/fonts/fonts.lock.json, so PowerPoint would draw emoji "
                  "in Segoe UI Emoji, a Microsoft font; only the --fonts windows build authors them")


@dataclass(frozen=True)
class DeckSpec:
    name: str  # output file stem and manifest `deck`
    size_pt: tuple  # (width, height) in points
    sections: tuple  # section modules; each has build(deck: AtlasDeck) -> None
    excluded: tuple = ()  # ((feature, reason), ...) for the manifest
    id_prefix: str = None  # slide ids are `<id_prefix>/<section>/<nn>`; default: the deck name
    smoke_only: bool = False  # drop every slide that is not a smoke slide before the deck is returned


def build_deck(spec, fonts, drop=()):
    """Author every section of `spec` into a new AtlasDeck and return it (not yet saved). `drop`: ids of slides to
    leave out as well (after the smoke filter), e.g. to make a published deck smaller."""
    deck = AtlasDeck(fonts, spec.size_pt, deck=spec.name, id_prefix=spec.id_prefix)
    for section in spec.sections:
        section.build(deck)
    for feature, reason in spec.excluded:
        deck.exclude(feature, reason)
    if spec.smoke_only:
        deck.keep_only(lambda entry: entry["smoke"])
    if drop:
        deck.drop_slides(drop)
    return deck


def atlas(fonts):
    excluded = EXCLUDED + ((EMOJI_EXCLUDED,) if fonts == "ofl" else ())
    sections = (shapes, lines, fills, effects, text, wordart, hidden, tables, charts, pictures, backgrounds,
                fonts_section)
    return [DeckSpec("atlas", SIZE_16X9, sections, excluded)]


def atlas_smoke(fonts):
    (full,) = atlas(fonts)
    return [replace(full, name="atlas-smoke", id_prefix=full.name, smoke_only=True)]


def probe(fonts):
    return [DeckSpec("probe", SIZE_16X9, (probe_section,))]


def sizes(fonts):
    return [DeckSpec(name, size, (sizes_section,)) for name, size in SIZE_DECKS]


RECIPES = {"atlas": atlas, "atlas-smoke": atlas_smoke, "probe": probe, "sizes": sizes}
