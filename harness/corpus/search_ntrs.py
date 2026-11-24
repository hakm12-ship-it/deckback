"""Proposes tier-B candidates from NASA NTRS: public presentations whose record says public use is permitted (M8 Task 1).

    search_ntrs.py "query" [--pages 3] [--size 25] [--out cand.jsonl]

A record is taken only when its distribution is PUBLIC, its copyright determination is (GOV_)PUBLIC_USE_PERMITTED, it
says it holds no third-party material, and it has a PDF. The licence page recorded is the record's own page, where the
distribution statement is. Only the public NTRS API is called, with a plain user agent.
"""

import argparse
import json
import sys
import time
import urllib.parse

from harness.corpus import fetch_public

API = "https://ntrs.nasa.gov/api/citations/search"
SITE = "https://ntrs.nasa.gov"
OK_DETERMINATIONS = ("GOV_PUBLIC_USE_PERMITTED", "PUBLIC_USE_PERMITTED")


def search_url(query, page=0, size=25, since=None):
    params = {"q": query, "stiType": "PRESENTATION", "page.size": size, "page.from": page * size}
    if since:
        params["published.gte"] = since
    return API + "?" + urllib.parse.urlencode(params)


def candidates(payload):
    found = []
    for hit in payload.get("results", []):
        copyright_ = hit.get("copyright") or {}
        if (hit.get("stiType") != "PRESENTATION" or hit.get("distribution") != "PUBLIC"
                or copyright_.get("determinationType") not in OK_DETERMINATIONS
                or copyright_.get("containsThirdPartyMaterial") is not False):
            continue
        for item in hit.get("downloads") or []:
            link = (item.get("links") or {}).get("pdf")
            if item.get("mimetype") == "application/pdf" and link:
                found.append({"url": SITE + link, "licence": "nasa-public-use",
                              "licenceUrl": f"{SITE}/citations/{hit['id']}", "source": "ntrs", "pairPptxUrl": None})
                break
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("query")
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--size", type=int, default=25)
    parser.add_argument("--since", help="only records published on or after this date (YYYY-MM-DD): newer decks are made by newer PowerPoint")
    parser.add_argument("--out", help="append candidates to this file (default: print)")
    args = parser.parse_args(argv)
    lines = []
    for page in range(args.pages):
        with fetch_public.open_url(search_url(args.query, page, args.size, args.since)) as response:
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
