import hashlib
import io
import subprocess
from pathlib import Path

import pytest

from harness.corpus import fetch_public, manifest

PDF = b"%PDF-1.4\n" + b"x" * 100
SHA = hashlib.sha256(PDF).hexdigest()


class FakeNet:
    def __init__(self, files):
        self.files, self.calls = files, []

    def __call__(self, url):
        self.calls.append(url)
        if url not in self.files:
            raise OSError("404")
        return io.BytesIO(self.files[url])


def candidate(url="https://example.org/a.pdf", **extra):
    return {"url": url, "licence": "cc-by-4.0", "licenceUrl": "https://creativecommons.org/licenses/by/4.0/",
            "source": "zenodo", "pairPptxUrl": None, **extra}


def test_download_verifies_the_sha256_and_does_not_download_twice(tmp_path):
    net = FakeNet({"u": PDF})
    dest = tmp_path / "a.pdf"
    assert fetch_public.download("u", dest, SHA, opener=net) == "downloaded"
    assert dest.read_bytes() == PDF
    assert fetch_public.download("u", dest, SHA, opener=net) == "present"
    assert net.calls == ["u"]


def test_a_wrong_sha256_leaves_no_file(tmp_path):
    dest = tmp_path / "a.pdf"
    with pytest.raises(fetch_public.FetchError, match="sha256"):
        fetch_public.download("u", dest, "0" * 64, opener=FakeNet({"u": PDF}))
    assert not dest.exists() and list(tmp_path.iterdir()) == []


def test_a_corrupt_file_already_there_is_downloaded_again(tmp_path):
    dest = tmp_path / "a.pdf"
    dest.write_bytes(b"broken")
    assert fetch_public.download("u", dest, SHA, opener=FakeNet({"u": PDF})) == "downloaded"
    assert dest.read_bytes() == PDF


def test_the_size_cap_stops_the_download(tmp_path):
    with pytest.raises(fetch_public.FetchError, match="larger"):
        fetch_public.download("u", tmp_path / "a.pdf", None, opener=FakeNet({"u": PDF}), max_bytes=50)
    assert list(tmp_path.iterdir()) == []


def test_add_candidate_names_the_entry_by_its_hash_and_skips_duplicates(tmp_path):
    net = FakeNet({"https://example.org/a.pdf": PDF, "https://example.org/copy.pdf": PDF})
    entries = []
    added = fetch_public.add_candidate(tmp_path, entries, candidate(), opener=net)
    assert added["id"] == "b-" + SHA[:10] and added["sha256"] == SHA and added["bytes"] == len(PDF)
    assert (tmp_path / manifest.PUBLIC_REAL / f"{added['id']}.pdf").read_bytes() == PDF
    assert fetch_public.add_candidate(tmp_path, entries, candidate("https://example.org/copy.pdf"), opener=net) is None
    assert len(entries) == 1
    assert fetch_public.add_candidate(tmp_path, entries, candidate(), opener=net) is None  # same url: not asked again
    assert net.calls == ["https://example.org/a.pdf", "https://example.org/copy.pdf"]


def test_add_candidate_refuses_a_licence_that_is_not_on_the_list(tmp_path):
    with pytest.raises(fetch_public.FetchError, match="licence"):
        fetch_public.add_candidate(tmp_path, [], candidate(licence="cc-by-nc-4.0"), opener=FakeNet({}))


def test_add_candidate_refuses_something_that_is_not_a_pdf(tmp_path):
    with pytest.raises(fetch_public.FetchError, match="PDF"):
        fetch_public.add_candidate(tmp_path, [], candidate(), opener=FakeNet({"https://example.org/a.pdf": b"<html>"}))
    assert not (tmp_path / manifest.PUBLIC_REAL).exists() or not list((tmp_path / manifest.PUBLIC_REAL).iterdir())


def test_fetch_all_downloads_the_pdf_and_its_pptx_pair(tmp_path):
    pptx = b"PK\x03\x04pptx"
    entry = {**candidate(pairPptxUrl="p"), "id": "b-" + SHA[:10], "sha256": SHA, "bytes": len(PDF)}
    manifest.save(tmp_path / manifest.MANIFEST, [entry])
    net = FakeNet({"https://example.org/a.pdf": PDF, "p": pptx})
    report = fetch_public.fetch_all(tmp_path, opener=net)
    assert report == {"downloaded": 2, "present": 0, "failed": []}
    assert manifest.pptx_path(tmp_path, entry).read_bytes() == pptx
    assert fetch_public.fetch_all(tmp_path, opener=net)["present"] == 2


def test_a_checked_pair_is_verified_by_its_recorded_hash(tmp_path):
    pptx = b"PK\x03\x04pptx"
    entry = {**candidate(pairPptxUrl="p"), "id": "b-" + SHA[:10], "sha256": SHA, "bytes": len(PDF),
             "pairPptxSha256": hashlib.sha256(pptx).hexdigest()}
    manifest.save(tmp_path / manifest.MANIFEST, [entry])
    report = fetch_public.fetch_all(tmp_path, opener=FakeNet({"https://example.org/a.pdf": PDF, "p": b"PK swapped"}))
    assert report["downloaded"] == 1 and len(report["failed"]) == 1 and "sha256" in report["failed"][0]
    assert not manifest.pptx_path(tmp_path, entry).exists()
    manifest.pptx_path(tmp_path, entry).write_bytes(b"PK truncated")  # a changed file on disk is fetched again
    assert fetch_public.fetch_all(tmp_path, opener=FakeNet({"p": pptx}))["downloaded"] == 1
    assert manifest.pptx_path(tmp_path, entry).read_bytes() == pptx


def test_the_downloads_are_git_ignored_and_the_binary_guard_refuses_them(tmp_path):
    root = Path(__file__).resolve().parents[2]
    ignored = subprocess.run(["git", "check-ignore", "-q", "corpus/public-real/b-0123456789.pdf"], cwd=root)
    assert ignored.returncode == 0
    assert "corpus/public-real/" in (root / ".gitignore").read_text(encoding="utf-8")
    # even forced into the index (git add -f), the guard refuses a PDF by extension and by signature
    guard = (root / "scripts" / "check-no-binaries.mjs").read_text(encoding="utf-8")
    assert "'.pdf'" in guard and "'.pptx'" in guard


def test_origin_is_guessed_from_the_tail_of_a_pdf():
    tail = b"junk /Producer (Microsoft\xae PowerPoint\xae 2019) /Creator (Microsoft\xae PowerPoint\xae 2019) >>"
    assert fetch_public.guess_origin(tail) == "powerpoint-windows"
    utf16 = "/Producer (".encode() + "Microsoft® PowerPoint® for Microsoft 365".encode("utf-16-be") + b")"
    assert fetch_public.guess_origin(utf16) == "powerpoint-windows"
    assert fetch_public.guess_origin(b"/Producer (pdfTeX-1.40)") is None
    assert fetch_public.guess_origin(b"/Producer (Microsoft PowerPoint 2010)") is None


def test_a_candidate_whose_tail_is_not_powerpoint_windows_is_skipped_without_a_download(tmp_path):
    net = FakeNet({"https://example.org/a.pdf": PDF})
    ranger = lambda url, size: b"/Producer (pdfTeX)"  # noqa: E731
    assert fetch_public.add_candidate(tmp_path, [], candidate(), opener=net, want="powerpoint-windows",
                                      ranger=ranger) is None
    assert net.calls == []


# ---- Task 1 review I4: https only, and only the source's hosts ---------------------------------------------------


def _redirect(url, target, source="zenodo"):
    import http.client
    import urllib.request

    handler = fetch_public.SafeRedirects(fetch_public.allowed_hosts(url, source))
    return handler.redirect_request(urllib.request.Request(url), None, 302, "Found", http.client.HTTPMessage(), target)


def test_a_redirect_to_http_or_to_another_host_is_refused():
    url = "https://zenodo.org/records/1/files/a.pdf"
    assert _redirect(url, "https://zenodo.org/api/files/x").full_url == "https://zenodo.org/api/files/x"
    assert _redirect(url, "/api/files/x").full_url == "https://zenodo.org/api/files/x"  # a relative redirect
    assert _redirect(url, "https://cdn.zenodo.org/x").full_url == "https://cdn.zenodo.org/x"  # a subdomain of the source
    for target in ("http://zenodo.org/x", "https://example.com/x", "https://zenodo.org.evil.example/x",
                   "ftp://zenodo.org/x", "file:///c:/x"):
        with pytest.raises(fetch_public.FetchError, match="refused"):
            _redirect(url, target)


def test_the_hosts_of_a_download_are_the_sources_and_the_urls_own():
    assert fetch_public.allowed_hosts("https://www.korea.kr/x.pdf", "kogl") == {"www.korea.kr", "korea.kr"}
    assert fetch_public.allowed_hosts("https://example.org/x.pdf", "other") == {"example.org"}
    assert fetch_public.host_allowed("https://www.korea.kr/x", {"korea.kr"})
    assert not fetch_public.host_allowed("http://www.korea.kr/x", {"korea.kr"})
    assert not fetch_public.host_allowed("https://notkorea.kr/x", {"korea.kr"})


def test_a_plain_http_url_is_never_opened():
    with pytest.raises(fetch_public.FetchError, match="https"):
        fetch_public.open_url("http://zenodo.org/records/1/files/a.pdf", source="zenodo")
    assert fetch_public.open_tail("http://zenodo.org/x", source="zenodo") == b""


def test_a_refused_redirect_ends_the_download_and_leaves_no_file(tmp_path):
    def opener(url):
        raise fetch_public.FetchError("redirect to http://evil.example refused (https and the source's hosts only)")

    with pytest.raises(fetch_public.FetchError, match="refused"):
        fetch_public.download("https://zenodo.org/x", tmp_path / "x.pdf", None, opener=opener)
    assert list(tmp_path.iterdir()) == []


def test_the_default_opener_is_bound_to_the_entries_source(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(fetch_public, "open_url", lambda url, source=None: seen.append(source) or (_ for _ in ()).throw(
        fetch_public.FetchError("stop")))
    monkeypatch.setattr(fetch_public, "download", lambda url, dest, sha, opener, **k: opener(url))
    entry = {"id": "b-0123456789", "url": "https://www.korea.kr/x.pdf", "sha256": "0" * 64, "source": "kogl"}
    manifest.save(tmp_path / manifest.MANIFEST, [entry])
    report = fetch_public.fetch_all(tmp_path, opener=fetch_public.open_url)
    assert seen == ["kogl"] and len(report["failed"]) == 1


def test_a_failed_pair_download_is_said_and_keeps_the_url(tmp_path, capsys):
    cand = candidate(pairPptxUrl="https://example.org/missing.pptx")
    entry = fetch_public.add_candidate(tmp_path, [], cand, opener=FakeNet({"https://example.org/a.pdf": PDF}))
    assert entry["pairPptxUrl"] == "https://example.org/missing.pptx"
    assert "pair of b-" in capsys.readouterr().err


def test_a_manifest_id_cannot_leave_the_download_folder(tmp_path):
    assert manifest.pdf_path(tmp_path, {"id": "b-0123456789"}).name == "b-0123456789.pdf"
    for bad in ("../x", "b-01234567890", "b-0123456789/../../x", "B-0123456789", None):
        with pytest.raises(ValueError):
            manifest.pdf_path(tmp_path, {"id": bad})
        with pytest.raises(ValueError):
            manifest.pptx_path(tmp_path, {"id": bad})
