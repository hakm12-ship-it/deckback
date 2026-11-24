"""Proposes tier-B candidates under 공공누리 제1유형 (KOGL Type 1, attribution only) from korea.kr (M8 Task 1).

    search_kogl.py [--pages 5] [--start 1] [--out cand.jsonl]

Walks the 정책브리핑 전문자료 list (https://www.korea.kr/archive/expDocList.do), opens each document page and takes its
PDF attachments only when the page itself shows the 공공누리 1유형 mark ("... 1유형 출처표시" and "제1유형(출처표시)의
조건"). The licence page recorded is that document page. Only public pages and the public download links on them are
fetched, with a plain user agent.
"""

import argparse
import json
import re
import sys
import time

from harness.corpus import fetch_public

SITE = "https://www.korea.kr"
LIST = SITE + "/archive/expDocList.do?pageIndex={}"
VIEW = SITE + "/archive/expDocView.do?docId={}"
_DOC = re.compile(r"expDocView\.do\?docId=([0-9]+)")
_PDF = re.compile(r'<a href="(/common/download\.do\?[^"]+)">\s*<img[^>]*alt="PDF[^"]*"', re.IGNORECASE)
_TYPE1 = re.compile(r"자유이용허락\s*1유형|제1유형\(출처표시\)")
_OTHER_TYPE = re.compile(r"자유이용허락\s*[234]유형|제[234]유형")


def doc_ids(html):
    return list(dict.fromkeys(_DOC.findall(html)))


def candidates(html, doc_id):
    if "kogl_wrap" not in html:
        return []
    kogl = html[html.index("kogl_wrap"):]
    if not _TYPE1.search(kogl) or _OTHER_TYPE.search(kogl):
        return []
    return [{"url": SITE + link.replace("&amp;", "&"), "licence": "kogl-type1",
             "licenceUrl": VIEW.format(doc_id), "source": "kogl", "pairPptxUrl": None}
            for link in _PDF.findall(html)]


def _get(url):
    with fetch_public.open_url(url) as response:
        return response.read().decode("utf-8", "replace")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pages", type=int, default=5)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--out", help="append candidates to this file (default: print)")
    args = parser.parse_args(argv)
    lines = []
    out = open(args.out, "a", encoding="utf-8", newline="\n") if args.out else None
    for page in range(args.start, args.start + args.pages):
        try:
            ids = doc_ids(_get(LIST.format(page)))
        except OSError as exc:  # a slow page must not lose what was found: skip it
            print(f"list page {page} skipped: {type(exc).__name__}", file=sys.stderr)
            continue
        for doc_id in ids:
            try:
                found = [json.dumps(c) for c in candidates(_get(VIEW.format(doc_id)), doc_id)]
            except OSError as exc:
                print(f"doc {doc_id} skipped: {type(exc).__name__}", file=sys.stderr)
                continue
            lines += found
            if out and found:
                out.write("\n".join(found) + "\n")
                out.flush()
            time.sleep(0.5)
    if out:
        out.close()
    else:
        print("\n".join(lines))
    print(f"{len(lines)} candidates", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
