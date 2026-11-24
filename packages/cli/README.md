# deckback

PDF를 편집 가능한 PowerPoint(PPTX)로 바꿉니다. 내 컴퓨터 안에서만 돌고, 아무것도 업로드하지 않습니다.
Converts a PDF to an editable PowerPoint (PPTX), on your own computer. Nothing is uploaded.

## 사용법 / Usage

> **npm 꾸러미는 준비 중입니다. / The npm package is coming soon.** 아직 npm에 올리지 않아서 `npx deckback`은 올린 뒤부터 됩니다. / It is not on npm yet, so `npx deckback` works only after the npm release.

지금 쓰는 법 (Node.js 22.13 이상) / How to use it now (Node.js 22.13 or newer), from a clone of <https://github.com/hakm12-ship-it/deckback>:

```
npm ci
npm run build:cli
node packages/cli/dist/deckback.mjs 발표자료.pdf -o 발표자료.pptx
```

또는 꾸러미를 직접 만들어서 / or pack it yourself:

```
npm pack -w packages/cli
npx --yes --package ./deckback-1.0.0.tgz -- deckback 발표자료.pdf -o 발표자료.pptx
```

npm에 올린 뒤에는 / After the npm release:

```
npx deckback@1.0.0 발표자료.pdf -o 발표자료.pptx
```

아래 `deckback ...`은 위 어느 방법으로든 같은 옵션입니다 / the `deckback ...` synopsis below is the same whichever way you run it.

```
deckback <in.pdf> -o <out.pptx> [--report <file.json>] [--scene <file.json>] [--pages <list>]
         [--font-map <file.json|A=B;C=D>] [--embed-fonts] [--strict]
```

| 옵션 / Option | 뜻 / Meaning |
|---|---|
| `-o <out.pptx>` | 만들 PPTX (필수) / the PPTX to write (required) |
| `--report <file.json>` | 변환 보고서도 씁니다 / also write the conversion report |
| `--scene <file.json>` | 변환기가 읽은 PDF 내용(Scene)을 JSON으로 씁니다 / also write the Scene (the PDF as the converter read it) as canonical JSON |
| `--pages <list>` | 일부 쪽만 변환. 1부터 셉니다. `1-3,5,8-` (`8-`은 8쪽부터 끝까지). 슬라이드는 적은 순서대로. 같은 쪽을 두 번 쓰거나 끝을 넘으면 오류 / only these pages, 1-based, as in `1-3,5,8-`; slides in the order written; a page twice or past the end is an error |
| `--font-map <map>` | 쓰인 글꼴을 다른 글꼴로 바꿔 씁니다. `{"원래 글꼴": "쓸 글꼴"}` JSON 파일(1 MB 이하) 또는 `A=B;C=D` / write another font family where one is used: a JSON file (up to 1 MB) or inline `A=B;C=D` |
| `--embed-fonts` | 허용되는 PDF의 TrueType 글꼴을 PPTX에 넣습니다 / embed the PDF's own TrueType fonts that allow it |
| `--strict` | 그림으로 대체해야 하는 PDF는 거절합니다 / refuse a PDF that needs a fallback (a raster of an effect or of an unmodelled operator) |
| `--help`, `-h` | 도움말 / help |
| `--version` | 버전 / version |

`-o`, `--report`, `--scene`은 서로 달라야 하고 입력 PDF와도 달라야 합니다(입력은 덮어쓰지 않습니다). 값을 받는 옵션을 두 번 쓰면 오류입니다.
`-o`, `--report` and `--scene` must differ from each other and from the input (the input is never overwritten); a value option given twice is an error. 세 파일은 함께 쓰이거나 하나도 남지 않습니다 / The files are written together or not at all.

종료 코드 / Exit codes: `0` 완료 done; `2` 인자 오류 bad arguments; `3` 입력을 읽을 수 없음(없음, PDF 아님, 암호) the input cannot be read; `4` 그 밖의 변환 오류(쓸 수 없는 출력 포함) any other conversion error; `5` `--strict`인데 대체가 필요함, 아무것도 쓰지 않음 a fallback would be written, nothing is written.
성공하면 표준 출력에 쪽·도형 수 같은 한 줄짜리 JSON이 나옵니다 / On success one JSON line of counts is printed on stdout.

## 보고서에 든 것 / What the report holds

`--report`의 JSON에는 슬라이드마다 만든 글상자·도형·선·그림·그라데이션의 개수, 그림으로 대체했거나 근사한 것, 글꼴 이름과 그 처리(대체, 삽입), PDF를 만든 프로그램, 전체 합계가 들어 있습니다. 문서 본문의 글자는 들어 있지 않습니다.
Per slide: the counts of text boxes, shapes, lines, pictures and gradients, anything replaced by a picture or approximated, the font names and what became of each (substituted, embedded), the program that made the PDF, and the totals. The document's body text is not in it.

## 개인정보 / Privacy

변환은 모두 이 컴퓨터에서 이루어지고 네트워크를 쓰지 않습니다. 인터넷이 막힌 곳에서도 같은 결과가 나옵니다. (npm에 올린 뒤 `npx`가 이 꾸러미를 처음 내려받을 때만 네트워크를 씁니다.) 오류 메시지에는 입력한 경로만 나오고 문서 내용은 나오지 않습니다.
The conversion runs entirely on this computer and makes no network request; it gives the same result with the network blocked. (After the npm release, only `npx` itself downloads this package.) Error messages quote the paths you typed, never the document.

## 라이선스 / Licence

Apache-2.0. `LICENSE`와, 함께 들어 있는 제3자 소프트웨어(pdf.js, fflate)를 밝힌 `NOTICE`를 보세요.
Apache-2.0. See `LICENSE`, and `NOTICE` for the third-party software bundled in (pdf.js, fflate).
