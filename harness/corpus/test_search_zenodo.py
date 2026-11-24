from harness.corpus import search_zenodo


def record(files, licence="cc-by-4.0", rid=1, title="A talk"):
    return {"id": rid, "metadata": {"title": title, "license": {"id": licence}}, "links": {},
            "files": [{"key": name, "size": size, "links": {"self": f"https://zenodo.org/api/records/{rid}/files/{name}/content"}}
                      for name, size in files]}


def test_a_cc_by_pdf_with_a_pptx_of_the_same_name_is_a_pair():
    found = search_zenodo.candidates({"hits": {"hits": [record([("talk.pdf", 1000), ("talk.pptx", 5000)])]}})
    assert len(found) == 1
    entry = found[0]
    assert entry["url"].endswith("/files/talk.pdf/content") and entry["pairPptxUrl"].endswith("/files/talk.pptx/content")
    assert entry["licence"] == "cc-by-4.0" and entry["source"] == "zenodo"
    assert entry["licenceUrl"] == "https://creativecommons.org/licenses/by/4.0/"


def test_cc0_has_its_own_licence_page():
    found = search_zenodo.candidates({"hits": {"hits": [record([("a.pdf", 1)], licence="cc-zero")]}})
    assert found[0]["licence"] == "cc0-1.0"
    assert found[0]["licenceUrl"] == "https://creativecommons.org/publicdomain/zero/1.0/"


def test_other_licences_and_restricted_records_are_dropped():
    hits = [record([("a.pdf", 1)], licence="cc-by-nc-4.0"), record([("b.pdf", 1)], licence="cc-by-sa-4.0", rid=2),
            record([("c.pdf", 1)], licence="", rid=3)]
    assert search_zenodo.candidates({"hits": {"hits": hits}}) == []


def test_a_pdf_over_the_cap_is_dropped_and_a_lone_pptx_pairs_with_a_lone_pdf():
    hits = [record([("big.pdf", 90 * 1024 * 1024)]), record([("deck.pdf", 10), ("slides.pptx", 20)], rid=2)]
    found = search_zenodo.candidates({"hits": {"hits": hits}})
    assert [e["url"].split("/")[-2] for e in found] == ["deck.pdf"]
    assert found[0]["pairPptxUrl"].endswith("slides.pptx/content")


def test_several_pdfs_without_matching_names_have_no_pair():
    found = search_zenodo.candidates({"hits": {"hits": [record([("a.pdf", 1), ("b.pdf", 1), ("x.pptx", 1)])]}})
    assert len(found) == 2 and all(e["pairPptxUrl"] is None for e in found)


def test_the_query_asks_for_open_presentations():
    url = search_zenodo.search_url("slides", page=2, size=50)
    assert "type=presentation" in url or "resource_type.type" in url
    assert "access_status=open" in url and "page=2" in url
