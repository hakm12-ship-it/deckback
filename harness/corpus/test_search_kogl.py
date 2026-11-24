from harness.corpus import search_kogl

VIEW = """
<a href="/common/download.do?tblKey=EDN&amp;fileId=11"><img src="/images/icon_ipdf.gif" alt="PDF파일" />발표자료.pdf</a>
<a href="/common/download.do?tblKey=EDN&amp;fileId=12"><img src="/images/icon_ihwp.gif" alt="HWP파일" />보고서.hwp</a>
<a href="/common/download.do?tblKey=EDN&amp;fileId=13"><img src="/images/icon_ipdf.gif" alt="PDF파일" />둘째.pdf</a>
<div class="kogl_wrap"><img alt="공공누리 공공저작물 자유이용허락 1유형 출처표시">
 공공누리 제1유형(출처표시)의 조건</div>
"""


def test_list_page_gives_doc_ids_once_each():
    html = '<a href="expDocView.do?docId=5">a</a><a href="expDocView.do?docId=5">b</a><a href="expDocView.do?docId=7">c</a>'
    assert search_kogl.doc_ids(html) == ["5", "7"]


def test_a_type_1_page_gives_one_candidate_per_pdf():
    found = search_kogl.candidates(VIEW, "41929")
    assert [c["url"] for c in found] == ["https://www.korea.kr/common/download.do?tblKey=EDN&fileId=11",
                                         "https://www.korea.kr/common/download.do?tblKey=EDN&fileId=13"]
    assert found[0]["licence"] == "kogl-type1" and found[0]["source"] == "kogl"
    assert found[0]["licenceUrl"] == "https://www.korea.kr/archive/expDocView.do?docId=41929"
    assert found[0]["pairPptxUrl"] is None


def test_other_kogl_types_or_no_mark_give_nothing():
    assert search_kogl.candidates(VIEW.replace("1유형", "3유형"), "1") == []
    assert search_kogl.candidates(VIEW.split("<div class=\"kogl_wrap\">")[0], "1") == []
