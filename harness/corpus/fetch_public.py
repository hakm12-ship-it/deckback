"""Downloads the tier-B PDFs (and their PPTX pairs) into corpus/public-real/ (git-ignored), idempotently (M8 Task 1).

    fetch_public.py                         download what the manifest lists and is not here yet, verify SHA-256
    fetch_public.py --add cand.jsonl        download new candidates (search_*.py output), append them to the manifest
    fetch_public.py --add-url URL --source kogl --licence kogl-type1 --licence-url PAGE [--pair-url URL]

Only the recorded public URLs are fetched, with a plain user agent; nothing about the user is sent. A file is never
downloaded twice: one that is already there with the right hash is left alone, a corrupt one is replaced. Files are
named by their tier-B id (b-<sha256[:10]>), so the manifest never carries a file name.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from functools import partial
from pathlib import Path

from harness.corpus import manifest

USER_AGENT = "deckback-corpus/0.1 (research)"
MAX_BYTES = 80 * 1024 * 1024
CHUNK = 1 << 20


# Task 1 review I4: a redirect is followed only to https and only to a host of the entry's source (or the host the
# URL itself named); a redirect to http, to another host or to another scheme ends the download.
SOURCE_HOSTS = {"zenodo": ("zenodo.org",), "ntrs": ("ntrs.nasa.gov",), "kogl": ("korea.kr",)}


class FetchError(Exception):
    pass


def host_allowed(url, allowed):
    """Whether `url` is https and its host is one of `allowed` or a subdomain of one."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(host == h or host.endswith("." + h) for h in allowed)


def allowed_hosts(url, source=None):
    """The hosts a download of `url` may be redirected to: those of the manifest's `source` and the URL's own."""
    own = (urllib.parse.urlsplit(url).hostname or "").lower()
    return {own, *SOURCE_HOSTS.get(source, ())} - {""}


class SafeRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only when the new URL is https and on an allowed host; otherwise FetchError (no file)."""

    def __init__(self, allowed):
        self.allowed = set(allowed)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        if not host_allowed(target, self.allowed):
            scheme = urllib.parse.urlsplit(target).scheme or "no scheme"
            raise FetchError(f"redirect to {scheme}://{urllib.parse.urlsplit(target).hostname or '?'} refused "
                             "(https and the source's hosts only)")
        return super().redirect_request(req, fp, code, msg, headers, target)


def _opener(url, source):
    return urllib.request.build_opener(SafeRedirects(allowed_hosts(url, source)))


def open_url(url, source=None):
    if not host_allowed(url, allowed_hosts(url, source)):
        raise FetchError("not an https url")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return _opener(url, source).open(request, timeout=60)


def open_tail(url, size=262144, source=None):
    """The last `size` bytes of a file (an HTTP range request), b"" when the server does not support it or the
    request is refused (not https, a redirect off the source's hosts)."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": f"bytes=-{size}"})
    try:
        if not host_allowed(url, allowed_hosts(url, source)):
            return b""
        with _opener(url, source).open(request, timeout=60) as response:
            return response.read(size + 1) if response.status == 206 else b""
    except (OSError, FetchError):
        return b""


def guess_origin(tail):
    """"powerpoint-windows" when the Producer/Creator text in the tail of a PDF says Microsoft PowerPoint 2016 or
    later / 365, else None. Only a cheap guess to skip downloads; census.py reads the real metadata afterwards."""
    from harness.corpus import census

    for text in (tail.decode("latin-1"), tail.replace(bytes(1), b"").decode("latin-1")):
        for match in re.finditer(r"PowerPoint", text):
            if census.classify_origin(text[max(0, match.start() - 20):match.end() + 40], "") == "powerpoint-windows":
                return "powerpoint-windows"
    return None


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, dest, sha256, opener=open_url, max_bytes=MAX_BYTES):
    """Fetch `url` to `dest` unless it is there with `sha256` (None: any existing file counts). Returns "present" or
    "downloaded"; raises FetchError (no file left behind) on a failure, a wrong hash or a file over `max_bytes`."""
    dest = Path(dest)
    if dest.is_file() and (sha256 is None or _sha256(dest) == sha256):
        return "present"
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    digest, size = hashlib.sha256(), 0
    try:
        with opener(url) as response, open(part, "wb") as out:
            for chunk in iter(lambda: response.read(CHUNK), b""):
                size += len(chunk)
                if size > max_bytes:
                    raise FetchError(f"larger than {max_bytes} bytes")
                digest.update(chunk)
                out.write(chunk)
        if sha256 is not None and digest.hexdigest() != sha256:
            raise FetchError("sha256 does not match the manifest")
        os.replace(part, dest)
    except FetchError:
        part.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001 - network errors come in many types
        part.unlink(missing_ok=True)
        raise FetchError(f"{type(exc).__name__}") from exc
    return "downloaded"


def _for_source(opener, source, default):
    """`opener` as it is, or `default` bound to the entry's source when it is the default one (a test's opener takes
    the URL alone)."""
    return partial(default, source=source) if opener is default else opener


def add_candidate(root, entries, cand, opener=open_url, max_bytes=MAX_BYTES, want=None, ranger=open_tail):
    """Download a candidate, name it by its hash and append the entry to `entries`. None for a url or a file the
    manifest already has. FetchError for a licence off the list, a failed download or a file that is not a PDF."""
    if any(e["url"] == cand["url"] for e in entries):
        return None
    if cand.get("source") != "other" and cand.get("licence") not in manifest.LICENCES:
        raise FetchError(f"licence {cand.get('licence')!r} is not on the list")
    if want and guess_origin(_for_source(ranger, cand.get("source"), open_tail)(cand["url"], 262144)) != want:
        return None  # judged from the tail of the file: nothing is downloaded
    folder = Path(root) / manifest.PUBLIC_REAL
    temp = folder / f"incoming-{os.getpid()}.pdf"
    opener = _for_source(opener, cand.get("source"), open_url)
    download(cand["url"], temp, None, opener=opener, max_bytes=max_bytes)
    try:
        with open(temp, "rb") as handle:
            if handle.read(1024).find(b"%PDF-") < 0:
                raise FetchError("not a PDF")
        sha = _sha256(temp)
        entry = {**cand, "id": manifest.tier_b_id(sha), "sha256": sha, "bytes": temp.stat().st_size}
        if any(e.get("sha256") == sha for e in entries):
            return None
        os.replace(temp, manifest.pdf_path(root, entry))
    finally:
        temp.unlink(missing_ok=True)
    pair = entry.get("pairPptxUrl")
    if pair:
        try:
            download(pair, manifest.pptx_path(root, entry), None, opener=opener, max_bytes=max_bytes)
        except FetchError as exc:  # said, not silent (Task 1 review M2); the URL stays, census.py drops a pair that is not there
            print(f"pair of {entry['id']} not downloaded: {exc}", file=sys.stderr)
    entries.append(entry)
    return entry


def fetch_all(root, opener=open_url):
    """Download every PDF and PPTX the manifest lists that is not in corpus/public-real/ yet."""
    root = Path(root)
    report = {"downloaded": 0, "present": 0, "failed": []}
    for entry in manifest.load(root / manifest.MANIFEST):
        jobs = [(entry["url"], manifest.pdf_path(root, entry), entry["sha256"])]
        if entry.get("pairPptxUrl"):
            # a pair census.py has checked is verified by its hash like the PDF (Task 1 review I5)
            jobs.append((entry["pairPptxUrl"], manifest.pptx_path(root, entry), entry.get("pairPptxSha256")))
        for url, dest, sha in jobs:
            try:
                report[download(url, dest, sha, opener=_for_source(opener, entry.get("source"), open_url))] += 1
            except FetchError as exc:
                report["failed"].append(f"{entry['id']}: {exc}")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".")
    parser.add_argument("--manifest", help="manifest file to extend (default: corpus/manifest.jsonl; others are merged by hand)")
    parser.add_argument("--add", help="a .jsonl file of candidates")
    parser.add_argument("--add-url")
    parser.add_argument("--pair-url")
    parser.add_argument("--source", default="other")
    parser.add_argument("--licence")
    parser.add_argument("--licence-url")
    parser.add_argument("--want-origin", help="only take candidates whose PDF tail says this origin (powerpoint-windows)")
    parser.add_argument("--limit", type=int, default=0, help="stop after this many new entries (0: no limit)")
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between downloads")
    args = parser.parse_args(argv)
    root = Path(args.root)
    path = Path(args.manifest) if args.manifest else root / manifest.MANIFEST
    if args.add or args.add_url:
        if args.add:
            cands = [json.loads(line) for line in Path(args.add).read_text(encoding="utf-8").splitlines() if line.strip()]
        else:
            cands = [{"url": args.add_url, "licence": args.licence, "licenceUrl": args.licence_url,
                      "source": args.source, "pairPptxUrl": args.pair_url}]
        entries, added = manifest.load(path), 0
        for cand in cands:
            try:
                entry = add_candidate(root, entries, cand, want=args.want_origin)
            except FetchError as exc:
                print(f"skipped {cand['url']}: {exc}", file=sys.stderr)
                continue
            if entry:
                added += 1
                manifest.save(path, entries)
                print(f"added {entry['id']} ({entry['bytes']} bytes) {cand['url']}")
                if args.limit and added >= args.limit:
                    break
                time.sleep(args.delay)
        print(f"{added} new entries; {len(entries)} in the manifest")
        return 0
    report = fetch_all(root)
    print(f"downloaded {report['downloaded']}, already present {report['present']}, failed {len(report['failed'])}")
    for line in report["failed"]:
        print(f"failed {line}", file=sys.stderr)
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
