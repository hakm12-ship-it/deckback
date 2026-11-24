"""M8 round 1 rules of the structural checks, on facts built by hand (no PDF, no deck).

The geometry of every S3 case is copied from a real tier-B slide, named by its id (the page number counts from 1); no
text, name or picture of those decks is here. The boxes are the PDF's and the slide's, in pt.
"""

from harness.fidelity.pdf_facts import PageFacts
from harness.fidelity.pptx_facts import SlideFacts
from harness.fidelity import structural


def page(size, *, images=(), shadings=(), spans=()):
    return PageFacts(index=0, page_count=1, size_pt=size, images=[list(b) for b in images],
                     shadings=[list(b) for b in shadings], spans=list(spans))


def grad_shape(box, name="g"):
    return {"name": name, "bbox": list(box), "bbox_kind": "path", "fill": {"kind": "grad"}, "line": None}


def slide(size, *, pictures=(), gradients=(), runs=()):
    return SlideFacts(index=0, slide_count=1, size_emu=(0, 0), size_pt=size, pictures=[list(b) for b in pictures],
                      shapes=[grad_shape(b, f"g{i}") for i, b in enumerate(gradients)], runs=list(runs))


# ---- S3: a picture over a shading --------------------------------------------------------------------------------


def test_own_image_over_a_shading_is_no_cover_b_3ea2bc47f5_p28():
    """The PDF paints a shading, then its own large image over it; the slide keeps both and S3 passes."""
    size = (960.0, 540.0)
    image = [811.642, -107.556, 1215.19, 275.36]
    shading = [837.18, 187.84, 920.18, 259.84]
    result = structural.s3(page(size, images=[image], shadings=[shading]),
                           slide(size, pictures=[[811.6419, -107.5555, 1215.1895, 275.3610]], gradients=[shading]))
    assert result["status"] == "pass", result["detail"]


def test_a_raster_the_pdf_has_no_image_for_still_covers_the_shading_b_14cbf3aedb_p1():
    """A picture the PDF has no image paint for, standing for the shading (a soft-mask fallback), is a real miss."""
    size = (1440.0, 810.0)
    result = structural.s3(page(size, images=[[141.24, 134.0, 695.49, 387.5]], shadings=[[0.0, 0.0, 1440.0, 464.89]]),
                           slide(size, pictures=[[0.0, 0.0, 1440.0, 465.0], [141.24, 134.0, 695.49, 387.5]]))
    assert result["status"] == "fail"
    assert "pictures covering a shading" in result["detail"]
    assert "shadings without a gradFill" in result["detail"]


def test_a_picture_inside_no_pdf_image_covers_a_shading_even_with_other_images():
    size = (960.0, 540.0)
    shading = [100.0, 100.0, 200.0, 150.0]
    result = structural.s3(page(size, images=[[500.0, 100.0, 600.0, 200.0]], shadings=[shading]),
                           slide(size, pictures=[[90.0, 90.0, 210.0, 160.0]], gradients=[shading]))
    assert result["status"] == "fail"
    assert "picture 1 covers shading" in result["detail"]


# ---- S3: gradients that paint nothing ----------------------------------------------------------------------------


def test_a_shading_of_no_area_needs_no_gradfill_b_06e12988fc_p3():
    size = (960.0, 540.0)
    shadings = [[0.0, 0.0, 0.0, 0.0], [562.67, 170.09, 702.67, 230.75]]
    image = [-12.582, -15.59, 82.466, 112.58]  # the PDF's own image over the corner where the empty shading sits
    result = structural.s3(page(size, images=[image], shadings=shadings),
                           slide(size, pictures=[image], gradients=[shadings[1]]))
    assert result["status"] == "pass", result["detail"]
    assert "of no area paint nothing" in result["detail"]


def test_a_zero_width_gradfill_stands_for_a_shading_left_over_b_d24b09eedf_p2():
    size = (720.0, 405.0)
    image = [0.0, 0.0, 720.0, 405.0]
    shading = [44.22, 13.32, 700.16, 58.74]
    result = structural.s3(page(size, images=[image, image], shadings=[shading]),
                           slide(size, pictures=[image, image], gradients=[[44.2197, 13.3203, 44.2207, 58.7402]]))
    assert result["status"] == "pass", result["detail"]


def test_a_zero_width_gradfill_without_a_shading_still_fails():
    size = (720.0, 405.0)
    result = structural.s3(page(size), slide(size, gradients=[[44.2197, 13.3203, 44.2207, 58.7402]]))
    assert result["status"] == "fail"
    assert "gradFills without a shading: 1" in result["detail"]


def test_a_shading_with_no_gradfill_at_all_still_fails_b_d24b09eedf_p1():
    size = (720.0, 405.0)
    image = [0.0, 0.0, 720.0, 405.0]
    result = structural.s3(page(size, images=[image], shadings=[[44.2, 24.5, 700.1, 103.2]]),
                           slide(size, pictures=[image]))
    assert result["status"] == "fail"
    assert "shadings without a gradFill" in result["detail"]
    assert "pictures covering" not in result["detail"]


# ---- S2: symbol fonts ---------------------------------------------------------------------------------------------


def span(text, font="Wingdings-Regular", codes=None):
    return {"text": text, "size": 12.0, "color": [0, 0, 0], "alpha": 1.0, "font": font, "family": None,
            "families": [], "bold": False, "italic": False, "origin": (0.0, 0.0), "symbol_codes": codes}


def run(text, typeface="Wingdings"):
    return {"text": text, "size": 12.0, "color": {"rgb": [0, 0, 0], "alpha": 1.0}, "bold": False, "italic": False,
            "shape": "s", "typeface_latin": typeface, "typeface_ea": typeface, "typeface_cs": typeface}


# b-700904ace4's Wingdings: ToUnicode names code 0xE0 an arrow, 0xD8 a heavy arrowhead, 0xFC a check mark
WINGDINGS = {"→": [0xF0E0], "➢": [0xF0D8], "✓": [0xF0FC], "▪": [0xF0A7]}


def s2(pdf_text, slide_text, font="Wingdings-Regular", typeface="Wingdings", codes=WINGDINGS):
    size = (960.0, 540.0)
    return structural.s2(page(size, spans=[span(pdf_text, font, codes)]), slide(size, runs=[run(slide_text, typeface)]))


def test_symbol_pua_character_equals_the_pdfs_mapped_character():
    assert s2("→", "")["status"] == "pass"
    assert s2("➢", "")["status"] == "pass"


def test_symbol_pua_must_be_the_code_the_pdf_fonts_map_gives_not_any_pua():
    """Round 1c: no more 'any PDF character above U+00FF accepts any private-use code'."""
    result = s2("→", "")  # the arrow is code 0xE0, not 0xD8
    assert result["status"] == "fail" and "text differs" in result["detail"]
    assert s2("→", "", codes=None)["status"] == "fail"  # a font with no mapping: no match above U+00FF
    assert s2("→", "", codes={})["status"] == "fail"
    assert s2("✓", "")["status"] == "fail"


def test_symbol_code_is_compared_where_the_pdf_gives_the_code():
    assert s2("l", "", codes=None)["status"] == "pass"  # the font has no ToUnicode: MuPDF reads the code itself
    result = s2("l", "", codes=None)
    assert result["status"] == "fail" and "text differs" in result["detail"]


def test_a_pua_character_in_a_text_font_is_not_a_symbol():
    assert s2("→", "", font="Calibri", typeface="Calibri")["status"] == "fail"
    assert s2("→", "", typeface="Calibri")["status"] == "fail"
    assert s2("→", "", font="Calibri")["status"] == "fail"


def test_an_unchanged_symbol_run_still_passes():
    assert s2("→", "→")["status"] == "pass"  # the converter before round 1 wrote the Unicode character


def test_symbol_alignment_serves_s6_too():
    size = (960.0, 540.0)
    pairs = structural.aligned_characters(page(size, spans=[span("→", codes=WINGDINGS)]),
                                          slide(size, runs=[run("")]))
    assert pairs is not None and len(pairs) == 1


def test_a_run_whose_a_sym_names_the_symbol_font_is_a_symbol_run():
    """PowerPoint writes a Wingdings character as U+F000 + code with the font in a:sym (latin may be a text font)."""
    size = (960.0, 540.0)
    sym = {**run("", "Calibri"), "typeface_sym": "Wingdings"}
    assert structural.s2(page(size, spans=[span("→", codes=WINGDINGS)]), slide(size, runs=[sym]))["status"] == "pass"
    plain = run("", "Calibri")
    assert structural.s2(page(size, spans=[span("→", codes=WINGDINGS)]), slide(size, runs=[plain]))["status"] == "fail"


# ---- M8-R7: S1 and S5 for pages of another size than the first, or turned by /Rotate ------------------------------


def page_of(size, first, images=(), count=2):
    return PageFacts(index=1, page_count=count, size_pt=size, first_size_pt=first, images=[list(b) for b in images])


def test_placement_is_the_converters_scale_and_centre():
    scale, (ox, oy) = structural.placement((787.0, 602.0), (612.0, 792.0))
    assert abs(scale - 0.7776) < 1e-4 and ox == 0 and abs(oy - 161.9) < 0.05
    assert structural.placement((612.0, 792.0), (612.0, 792.0)) == (1.0, (0.0, 0.0))
    assert structural.placement((0.0, 5.0), (612.0, 792.0)) == (1.0, (0.0, 0.0))


def test_s1_compares_a_turned_page_at_its_placement_b_a03bb531ac_p2():
    """787 x 602 page on a 612 x 792 slide: the image paint [0, 0, 787, 602] is the picture [0, 161.9, 612, 630.1]."""
    result = structural.s1(page_of((787.0, 602.0), (612.0, 792.0), images=[[0.0, 0.0, 787.0, 602.0]]),
                           slide((612.0, 792.0), pictures=[[0.0, 161.9, 612.0, 630.1]]))
    assert result["status"] == "pass", result["detail"]


def test_s1_without_the_placement_that_picture_would_fail_and_a_misplaced_one_still_does():
    pdf = page_of((787.0, 602.0), (612.0, 792.0), images=[[100.0, 100.0, 300.0, 200.0]])
    placed_box = structural.placed([100.0, 100.0, 300.0, 200.0], *structural.placement((787.0, 602.0), (612.0, 792.0)))
    assert structural.s1(pdf, slide((612.0, 792.0), pictures=[placed_box]))["status"] == "pass"
    assert structural.s1(pdf, slide((612.0, 792.0), pictures=[[100.0, 100.0, 300.0, 200.0]]))["status"] == "fail"
    assert structural.s1(pdf, slide((612.0, 792.0), pictures=[[0.0, 0.0, 612.0, 792.0]]))["status"] == "fail"


def test_s1_a_page_of_the_slides_own_size_is_unchanged():
    size = (960.0, 540.0)
    result = structural.s1(page_of(size, size, images=[[10.0, 10.0, 100.0, 100.0]]),
                           slide(size, pictures=[[12.0, 12.0, 90.0, 90.0]]))
    assert result["status"] == "pass", result["detail"]


def deck_slide(emu):
    return SlideFacts(index=1, slide_count=2, size_emu=emu, size_pt=(emu[0] / 12700, emu[1] / 12700))


def test_s5_the_slide_is_the_first_pages_size_not_this_pages():
    """b-a03bb531ac: page 2 is 787 x 602 (turned), the slide is the first page's 612 x 792."""
    first = (612.0, 792.0)
    assert structural.s5(page_of((787.0, 602.0), first), deck_slide((7772400, 10058400)))["status"] == "pass"
    wrong = structural.s5(page_of((787.0, 602.0), first), deck_slide((787 * 12700, 602 * 12700)))
    assert wrong["status"] == "fail" and "EMU" in wrong["detail"]


def test_s5_a_first_page_beyond_powerpoints_range_is_scaled_into_it():
    assert structural.slide_frame((8064.0, 4032.0)) == (4032.0, 2016.0)
    assert structural.slide_frame((20.0, 100.0)) == (72.0, 360.0)
    assert structural.slide_frame((960.0, 540.0)) == (960.0, 540.0)
    result = structural.s5(page_of((8064.0, 4032.0), (8064.0, 4032.0)), deck_slide((4032 * 12700, 2016 * 12700)))
    assert result["status"] == "pass", result["detail"]


def test_to_unicode_map_reads_bfchar_and_bfrange():
    from harness.fidelity.pdf_facts import to_unicode_map

    cmap = "beginbfchar <E0> <2192> <A7> <25AA> endbfchar beginbfrange <30> <32> <0041> <40> <41> [<0061> <0062>] endbfrange"
    assert to_unicode_map(cmap) == {0xE0: "→", 0xA7: "▪", 0x30: "A", 0x31: "B", 0x32: "C", 0x40: "a", 0x41: "b"}
    assert to_unicode_map("garbage") == {}


def test_symbol_codes_of_a_real_wingdings_pdf_are_the_round_1a_mapping_b_700904ace4_p5():
    import pytest
    from pathlib import Path
    from harness.fidelity import pdf_facts

    pdf = Path(__file__).resolve().parents[2] / "corpus" / "public-real" / "b-700904ace4.pdf"
    if not pdf.is_file():
        pytest.skip("tier-B deck not downloaded")
    facts = pdf_facts.page_facts(pdf, 4)
    wing = next(f for f in facts.fonts if "Wingdings" in f["basefont"])
    assert wing["symbol_codes"] == {"✓": [0xF0FC], "▪": [0xF0A7], "❖": [0xF076], "➢": [0xF0D8],
                                    "→": [0xF0E0]}
    assert next(f for f in facts.fonts if "Constantia" in f["basefont"] and "Bold" not in f["basefont"])["symbol_codes"] is None


def test_symbol_codes_follow_an_indirect_descendant_fonts_array_b_92273609d2_p18():
    """PowerPoint's export writes /DescendantFonts as an indirect array and a CIDToGIDMap stream: the CIDs of a subset
    are renumbered, so only the GID route gives U+F0E0 for the arrow (found when r1 measured it)."""
    import pytest
    from pathlib import Path
    from harness.fidelity import pdf_facts

    pdf = Path(__file__).resolve().parents[2] / "corpus" / "public-real" / "b-92273609d2.pdf"
    if not pdf.is_file():
        pytest.skip("tier-B deck not downloaded")
    wing = next(f for f in pdf_facts.page_facts(pdf, 17).fonts if "Wingdings" in f["basefont"])
    assert wing["symbol_codes"]["→"] == [0xF0E0]
    assert 0xF001 not in sum(wing["symbol_codes"].values(), [])  # not the renumbered CID itself
