"""Known-unrecoverable classes established by measurement, per atlas slide id (spec 5.2, rulings M1-R56, M5-R13).

The other known classes follow from what a slide declares in its deck manifest (its features and `knownBitmapText`;
harness/fidelity/run.py `known_classes`). A class here is a property of PowerPoint's PDF export of the slide that only a
measurement shows, so it is listed by slide id, with its evidence, and the fidelity run gives it to the slide of that id
in every deck that holds it (atlas, atlas-smoke). It is kept out of the manifest on purpose: a manifest is part of the
export stamp of its PDFs (M1-R77), so changing it would make the committed atlas-smoke PDFs stale and call for a new
PowerPoint export of decks whose slides did not change.

lossyPictureExport (M5-R13). PowerPoint's PDF export re-encodes the slide's pictures lossily: crops and recolours of a
PNG become new JPEGs, and its own JPEGs are written again at a lower quality. deckback passes the PDF's bytes through
and matches MuPDF's render of them; the ground truth renders the lossless source. The swap test puts the source's own
picture (its lossless image, srcRect and render-time recolour) into deckback's output slide and renders it again; V1 per
line, before -> after (2026-11-18, PowerPoint 16.0.17932.20976, std):
  atlas/pictures/03  700 -> 120 px  (the 120 are crop-edge rows: PowerPoint samples past a srcRect's edge, into
                                     pixels the PDF does not carry)
  atlas/pictures/06   57 -> 0 px    (recolours: grayscl, duotone, biLevel, lum)
  atlas/pictures/11   89 -> 0 px
A class is recorded, never excused by the run (M1-R56); the M5 gate (0008) lists it as an exception, and such a slide
must still pass V2.
"""

MEASURED = {
    "atlas/pictures/03": ("lossyPictureExport",),
    "atlas/pictures/06": ("lossyPictureExport",),
    "atlas/pictures/11": ("lossyPictureExport",),
}


def measured_classes(slide_id):
    """The known classes measured for the slide `slide_id` (its manifest id), () for any other."""
    return MEASURED.get(slide_id, ()) if isinstance(slide_id, str) else ()
