from harness.corpus import search_ntrs


def result(rid=1, determination="GOV_PUBLIC_USE_PERMITTED", distribution="PUBLIC", third_party=False,
           downloads=None, sti="PRESENTATION"):
    if downloads is None:
        downloads = [{"mimetype": "application/pdf", "name": f"{rid}.pdf",
                      "links": {"pdf": f"/api/citations/{rid}/downloads/{rid}.pdf"}}]
    return {"id": rid, "stiType": sti, "distribution": distribution, "downloads": downloads,
            "copyright": {"determinationType": determination, "containsThirdPartyMaterial": third_party}}


def test_a_public_use_presentation_pdf_becomes_a_candidate():
    found = search_ntrs.candidates({"results": [result(20190002820)]})
    assert found == [{"url": "https://ntrs.nasa.gov/api/citations/20190002820/downloads/20190002820.pdf",
                      "licence": "nasa-public-use", "licenceUrl": "https://ntrs.nasa.gov/citations/20190002820",
                      "source": "ntrs", "pairPptxUrl": None}]


def test_both_public_use_determinations_are_accepted():
    assert len(search_ntrs.candidates({"results": [result(1, "PUBLIC_USE_PERMITTED"), result(2)]})) == 2


def test_restricted_distribution_copyright_or_third_party_material_is_dropped():
    hits = [result(1, distribution="NASA_ONLY"), result(2, determination="COPYRIGHT"), result(3, third_party=True),
            result(4, determination="NOT_SET"), result(5, sti="REPORT"), result(6, downloads=[])]
    assert search_ntrs.candidates({"results": hits}) == []


def test_only_the_pdf_download_is_used():
    pptx = [{"mimetype": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "name": "a.pptx",
             "links": {"original": "/api/citations/7/downloads/a.pptx"}}]
    assert search_ntrs.candidates({"results": [result(7, downloads=pptx)]}) == []


def test_since_asks_for_newer_records_only():
    assert "published.gte=2020-01-01" in search_ntrs.search_url("x", since="2020-01-01")
    assert "published.gte" not in search_ntrs.search_url("x")
