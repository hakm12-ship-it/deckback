"""Proposes tier-B candidates from Zenodo: open presentations under CC-BY 4.0 or CC0 with a PDF (M8 Task 1).

    search_zenodo.py "query" [--pages 3] [--size 25 (25 is the anonymous API maximum)] [--out cand.jsonl]

The output is one candidate per line (url, licence, licenceUrl, source, pairPptxUrl); fetch_public.py --add downloads
them. A record's PPTX is a pair when it has the same name as the PDF, or when the record has exactly one PDF and one
PPTX. Only the public Zenodo API is called, with a plain user agent.
"""

import argparse
import json
import sys
import time
import urllib.parse
from pathlib import PurePosixPath

from harness.corpus import fetch_public

API = "https://zenodo.org/api/records"
MAX_BYTES = fetch_public.MAX_BYTES
LICENCES = {
    "cc-by-4.0": ("cc-by-4.0", "https://creativecommons.org/licenses/by/4.0/"),
    "cc-zero": ("cc0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
    "cc0-1.0": ("cc0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
}


def search_url(query, page=1, size=25):
    params = {"q": query, "type": "presentation", "access_status": "open", "page": page, "size": size,
              "sort": "mostrecent"}
    return API + "?" + urllib.parse.urlencode(params)


def _content_url(item):
    return (item.get("links") or {}).get("self")


def candidates(payload, max_bytes=MAX_BYTES):
    found = []
    for hit in payload.get("hits", {}).get("hits", []):
        licence = LICENCES.get(((hit.get("metadata") or {}).get("license") or {}).get("id"))
        if not licence:
            continue
        files = hit.get("files") or []
        pdfs = [f for f in files if f.get("key", "").lower().endswith(".pdf") and f.get("size", 0) <= max_bytes]
        all_pdfs = [f for f in files if f.get("key", "").lower().endswith(".pdf")]
        pptxs = [f for f in files if f.get("key", "").lower().endswith(".pptx")]
        for pdf in pdfs:
            stem = PurePosixPath(pdf["key"]).stem.lower()
            same = [p for p in pptxs if PurePosixPath(p["key"]).stem.lower() == stem]
            pair = same[0] if same else (pptxs[0] if len(all_pdfs) == 1 and len(pptxs) == 1 else None)
            if not _content_url(pdf):
                continue
            found.append({"url": _content_url(pdf), "licence": licence[0], "licenceUrl": licence[1],
                          "source": "zenodo", "pairPptxUrl": _content_url(pair) if pair else None})
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("query")
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--size", type=int, default=25)
    parser.add_argument("--out", help="append candidates to this file (default: print)")
    args = parser.parse_args(argv)
    lines = []
    for page in range(1, args.pages + 1):
        with fetch_public.open_url(search_url(args.query, page, args.size)) as response:
            lines += [json.dumps(c) for c in candidates(json.load(response))]
        time.sleep(1)
    if args.out:
        with open(args.out, "a", encoding="utf-8", newline="\n") as handle:
            handle.writelines(line + "\n" for line in lines)
    else:
        print("\n".join(lines))
    print(f"{len(lines)} candidates", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
