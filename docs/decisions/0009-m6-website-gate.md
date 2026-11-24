# 0009. M6 관문: 웹사이트

- 날짜: 2026-11-19. 측정은 커밋 `6ddb279`의 코드로 돌렸다. 이 뒤의 커밋(`.gitignore`, `harness/producers/__init__.py`, 이 문서)은 변환 출력을 바꾸지 않는다
- 상태: **결정. M6의 통과 기준을 채웠다.** 단, "미리보기"는 판정 M6-R1에 따라 실제 Cloudflare가 아니라 **로컬 Pages 에뮬레이션**(`wrangler pages dev`)이다. PR #8을 검토 준비로 돌린다. 병합은 작성자가 정한다
- 범위: M6 작업 계획(계획 8)의 작업 1~5
- 읽는 법:
  - "M6-Rnn"은 M6을 진행하며 내린 판정의 번호다. 아래 "판정"에 한 줄씩 적었다.
  - "로컬 Pages 에뮬레이션"은 빌드한 `apps/web/dist`를 `_headers`까지 적용해 로컬에서 띄운 것이다. 로그인과 배포는 하지 않았다. 주소는 없다.
  - 비공개 덱은 개수로만 적는다.

## 결정

M6의 통과 기준은 계획 8로 정했다. 웹사이트가 CLI와 같은 PPTX를 만들고, 파일의 어느 것도 브라우저 밖으로 나가지 않으며, 첫 적재가 1 MB 이하이고, 변환 출력이 M5(`5579fe4`)와 같아야 한다. 모두 채웠다.

실제 Cloudflare Pages에서만 드러나는 차이(압축 방식, `_headers` 처리)는 M6-R1 때문에 M9에서야 확인한다. 그 차이를 줄이려고 같은 `_headers`를 로컬 에뮬레이션과 e2e의 시험 서버 두 곳에서 모두 돌렸다.

## 한눈에 보기

| 항목 | 기준 | 결과 | 판정 |
|---|---|---|---|
| CLI와 같은 바이트 | 4종 엔진 | 로컬 Pages 에뮬레이션에서 Chromium, Edge, Firefox, WebKit 모두 통과. probe, atlas-smoke, 그림 대체 한 장은 빌드한 CLI의 PPTX와 SHA-256이 같다. 글꼴 대응 덱은 CLI에 `--font-map`이 없어(M7) 같은 `fontMap`을 준 Node `convert`와 같다 | 통과 |
| 파일이 브라우저를 떠나지 않음 | 요청에 파일 바이트, 파일 이름, 글자, 글꼴 이름이 없음 | 4종 엔진에서 통과(원문, NFD, 퍼센트, base64, base64url, hex). 분석 비콘을 켠 빌드(가짜 토큰)도 통과. 쿠키 0. 검사기가 샘플 누출을 찾는 음성 대조가 있다 | 통과 |
| 첫 적재 | 1,000,000 B 이하(압축해서 받은 양) | 14,702 B(Chromium), 15,749(Edge), 15,674(Firefox), 14,643(WebKit). 서비스 워커를 켜면 17,288(Chromium), 17,990(Edge), 16,267(WebKit). Firefox는 워커 요청이 보이지 않아 15,674 | 통과(1.5~1.8 %) |
| 출력이 M5와 같음 | `5579fe4`와 바이트까지 같다 | 측정한 덱 33개(공개, 기능 지도, 쪽 크기, 그림 대체 시험, 비공개) × `--embed-fonts` 유무 = 66번: PPTX와 리포트가 모두 같다. 리포트는 작업 3이 더한 `fonts[].written`만 뺐다 | 통과 |
| e2e | 4종 엔진 통과 | 로컬 131개(Chromium은 성능·메모리 시험 포함). 에뮬레이션 127개(Chromium 37, Edge 30, Firefox 30, WebKit 30, 1개 건너뜀은 빌드 폴더 검사, 에뮬레이션에서는 주소 검사가 대신한다) | 통과 |
| 그 밖의 시험 | | `npm test` 1,232개, `test:local` 179개, `test:corpus` 205개(골든 그대로), `tsc -b` 오류 0 | 통과 |
| CI | 15분 한도 | `f246bed` 실행 44335389163 성공, 8분 53초(Chromium e2e 포함). 앞의 실행 넷은 작업 3이 더한 `harness/producers/`에 `__init__.py`가 없어 실패했다(`f246bed`에서 고쳤다) | 통과 |

## 무엇을 만들었나

| 무엇 | 작업 | 결과 |
|---|---|---|
| 변환 호출의 새 옵션 | 작업 1 | `onProgress`(쪽마다), `fontMap`(글꼴 바꾸기), 리포트 `fonts[].mappedTo`. 안 쓰면 출력은 그대로다. NaN 막기를 마무리했고, 적대적인 쪽의 점 상한을 낮췄다(M6-R2) |
| 사이트 | 작업 2 | 끌어 놓기, 진행, 취소(작업자를 끝낸다), 내려받기, 리포트, 글꼴 바꾸기, 한국어와 영어. 암호 PDF, PDF 아닌 파일, 잘린 PDF는 메시지를 낸다. 권한만 걸린 PDF는 변환하고 리포트가 알린다 |
| 오프라인, 보안, 개인정보 | 작업 3 | 서비스 워커(빌드 해시로 캐시), `_headers`(CSP, noindex, no-referrer, nosniff, 권한 정책), 개인정보·오프라인·CSP·첫 적재 e2e. 작업자 안의 CSP 위반도 본다. 시험 페이지는 e2e 빌드에만 있다(M6-R3) |
| 분석과 배포 준비 | 작업 4 | 비콘은 `VITE_CF_BEACON_TOKEN`이 있을 때만 들어간다. `wrangler.toml`(프로젝트 이름, 출력 폴더, 호환성 날짜만)과 `npm run deploy:preview`는 준비만 했고 실행하지 않았다. wrangler는 개발 의존성이다 |
| 에뮬레이션 측정 | 작업 4 | `cli-bytes` e2e(빌드한 CLI와 비교), 알 수 없는 경로 시험. 에뮬레이션에서 드러난 차이 셋을 시험이 받아들이게 했다(아래) |

**에뮬레이션에서 드러난 차이.**
- **알 수 없는 경로.** Pages는 404.html이 없으면 `index.html`을 200으로 준다(단일 페이지 앱). `/test.html`은 `/test`로 리다이렉트한 뒤 같은 처리를 받는다. 운영 빌드에는 시험 페이지가 없으므로 어느 쪽도 시험 페이지가 아니다. 시험은 200이면 사이트 자신의 `index.html`일 것, 404도 받아들인다.
  - 없는 `/assets/…` 파일도 `index.html` 200이고, `Cache-Control: immutable`이 붙는다. M9에서 실제 Pages가 같은지 본다.
- **리다이렉트 응답에는 본문이 없다.** 성능 시험은 리다이렉트를 건너뛰고 `/test`를 `/test.html`로 본다.
- **일부 요청의 원시 헤더가 오지 않는다.** Chromium에서 에뮬레이션의 몇 요청은 `allHeaders()`가 끝나지 않아 개인정보 시험이 멈췄다. 5초 뒤 일반 헤더로 대신한다. 주소와 본문은 그대로 전부 검사한다.

## 판정

| 번호 | 판정 |
|---|---|
| M6-R1 | 작성자의 판정: M6에서는 Cloudflare에 배포하지 않는다. 관문의 "미리보기"는 로컬 Pages 에뮬레이션으로 재고, 실제 미리보기 배포는 M9에서 작성자의 확인을 받아 한다. |
| M6-R2 | 그림 대체 렌더러의 점 상한 `RASTER_MAX_POINTS`를 1,000,000에서 500,000으로 낮춘다. 100쪽 적대적 덱의 실제 최대 메모리가 1,063 MB에서 707 MB가 된다. 측정한 덱은 바이트까지 같다. 50만~100만 점의 그림은 M5 전의 형태로 대체된다. |
| M6-R3 | `/?request=` 시험 페이지는 운영 빌드에 넣지 않는다. `VITE_E2E=1`로 만든 `dist-e2e`에만 둔다. |
| M6-R4 | pdf.js의 .wasm 파일(JPX, JBIG2, ICC 디코더)은 쓰지 않는다. 우리 빌드는 `wasmUrl`을 주지 않으므로 JPX 그림은 Node와 브라우저 모두 `image-unreadable` 대체가 된다. JPX 해독은 M8의 일이다. 새 서비스 워커는 `skipWaiting`을 하지 않는다(새 빌드는 탭을 모두 닫은 뒤에 적용). WebKit 자신의 `<select>`가 일으키는 `style-src-attr` 이벤트 하나는 CSP 시험에서 WebKit에서만 허용한다. |
| M6-R5 | 그래도 `script-src`에 `'wasm-unsafe-eval'`을 받아들인다. pdf.js가 PostScript(Type 4) 함수를 자기 바이트에서 WebAssembly로 컴파일하는데, 막으면 Node와 다른 길로 계산한다. 컴파일만 허락하고 eval도 .wasm 파일 받기도 없다. 계획의 CSP 글자에서 한 토큰이 늘어난다. |

## M7, M8, M9가 물려받을 것

- **M7(명령어 도구와 스킬).**
  - CLI의 `--font-map` 플래그. 지금은 같은 `fontMap`을 준 Node `convert`와만 비교한다. 플래그가 생기면 `cli-bytes` e2e의 글꼴 대응 시험을 CLI와의 SHA-256 비교로 바꾼다.
  - `cli-bytes`는 전역 준비에서 CLI를 새로 빌드한다.
- **M8(실제 PDF).**
  - JPX 해독(M6-R4). PowerPoint는 JPX를 내보내지 않는다. 켜면 JPX PDF의 출력이 바뀌므로 따로 판정한다.
  - 너무 복잡한 PDF와 덱이 잘리는 경우의 e2e. 지금은 없다.
  - Firefox와 WebKit은 Playwright가 서비스 워커의 요청을 보여 주지 않아, 워커가 일으키는 두 번째 내려받기와 캐시 채우기를 Chromium과 Edge에서만 센다. 그 두 엔진에서는 시험이 서비스 워커의 요청을 볼 수 없다.
- **M9(공개).**
  - 작성자의 확인을 받은 뒤 실제 Cloudflare 배포(`npm run deploy:preview`)와 분석 비콘의 토큰(`.env`의 `VITE_CF_BEACON_TOKEN`). 비콘의 실제 트래픽도 그때 본다.
  - 비콘: 시험은 대역(stub)의 내용만 확인했다. 실제 비콘의 필드를 적어 두고, 고정되지 않은 제3자 스크립트가 `#download-name`과 글꼴 이름에 접근할 수 있다는 점과 SRI 또는 버전이 붙은 주소를 판정한다.
  - 토큰 파일 위치: `deploy:preview`는 `apps/web`에서 빌드하므로 Vite는 `apps/web/.env`의 `VITE_CF_BEACON_TOKEN`을 읽고, wrangler는 저장소 루트 `.env`의 `CLOUDFLARE_API_TOKEN`을 읽는다. 비콘 토큰을 루트 `.env`에 두면 비콘 없이 배포된다.
  - 워커 덩어리를 못 불러오면(첫 방문 전 오프라인, 배포 뒤의 옛 페이지) 지금은 일반 `error.failed`다. "시작 전에 실패"를 따로 말할지 판정한다.
  - `MAX_FILE_BYTES`(200 MB)는 1 GB 예산과 맞춰 재지 않았다. 사본이 셋(페이지, 전송본, pdf.js) 동시에 살고 그 뒤에 PPTX와 Blob이 온다.
  - 실제 Pages의 압축(brotli, gzip)과 SPA 대체(없는 경로, 없는 `/assets/…`의 `immutable`)가 에뮬레이션과 같은지 다시 잰다. 첫 적재는 거기서 다시 잰다.
  - 사이트를 공개하는 일과 알리는 일은 각각 확인을 받는다. 그때까지 `X-Robots-Tag: noindex`다.

## 안전 기록

- **배포와 로그인.** 하지 않았다. `wrangler`는 로컬 모드로만 돌렸고 로그인을 요구하지 않았다. 토큰, 계정 정보, 주소는 어디에도 없다. 비콘 시험에는 가짜 토큰(`e2e-fake-beacon-token-0000`)만 썼고, 요청은 컴퓨터를 떠나지 않는다.
- **PowerPoint.** 이 마일스톤에서는 쓰지 않았다.
- **저장소 기록 점검(`5579fe4..HEAD`, 커밋 15개, 이 문서의 커밋 포함).**
  - 커밋 메시지: 개인 이름, 경로, 사용자 이름, 토큰 값 없음. 변수 이름(`VITE_CF_BEACON_TOKEN`)만 있다.
  - 추가한 줄(`package-lock.json` 제외, 잠금 파일은 따로 검사): 컴퓨터 경로, 사용자 이름, 토큰 모양의 문자열 없음. 시험 파일 이름 `홍길동_발표자료.pdf`는 지어낸 이름이다.
  - 작성자 표기는 모든 커밋이 GitHub noreply 주소다.
- **정리.** 에뮬레이션과 비교에 쓴 작업 폴더(`5579fe4` 작업 트리 포함)는 임시 폴더에만 있었고 지웠다. wrangler가 만드는 `.wrangler/`는 `.gitignore`에 넣었다.

## 이번에 새로 돌린 결과

| 명령 | 결과 |
|---|---|
| `wrangler pages dev`(`dist`, 비콘 가짜 토큰 `dist-beacon`, e2e `dist-e2e` 세 개) + `E2E_BASE_URL`, `E2E_BEACON_URL`, `E2E_TEST_URL`로 `npm run e2e` | 4종 엔진 127개 통과(위) |
| 같은 e2e, 내장 시험 서버 | 131개 통과 |
| `npm test`, `npm run test:local`, `npm run test:corpus`, `tsc -b` | 1,232 / 179 / 205개 통과, 오류 0 |
| 빌드한 CLI(`5579fe4`)와 새 CLI | 33개 PDF × 2 = 66번 PPTX 바이트 동일, 리포트 동일(`written` 제외) |

사용한 버전은 Node 24.18.0, wrangler 4.164.0, Playwright 1.64.1이다.
