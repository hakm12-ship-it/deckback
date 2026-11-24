# 0002. 인벤토리 계약: 오라클과 walker가 같은 목록을 내는 규칙

- 날짜: 2026-11-04
- 상태: M0에서 정함. M1에서 고침: 타일 패턴 paint(`pattern`)와 어림 표시(`approx`)를 더하고 §9를 바로잡았다. M2에서 더함: 경로 기하(§14)와 선 속성(§15). 패턴으로 그린 선도 이제 인벤토리에 든다. 글자의 글꼴, 크기, 색, 칠하는 방식, 보이지 않는 글자, 세로쓰기, Type 3 글꼴(§6). 그림의 행렬, 픽셀 크기, 이미지 마스크의 색과 그라데이션의 종류(§16). 소프트 마스크 영역(§10)을 walker도 맞춘다. 모든 paint의 클립 상자, 그룹 알파, 블렌드 모드, 소프트 마스크와 글자의 그룹 알파(§17). 선택적 내용(§18). 장면(Scene)이 돌려주는 인벤토리가 무엇을 내고 무엇을 빼는지(§19). 지금 코드가 이 규칙대로 동작한다.
- 범위: PyMuPDF 오라클(`harness/oracle/mupdf_inventory.py`), pdf.js walker(`packages/core/src/extract/walker.ts`), 경로 계산(`packages/core/src/extract/paths.ts`), 글자 배치(`packages/core/src/extract/text.ts`), 그래픽 상태(`packages/core/src/extract/gstate.ts`), 인벤토리 형식과 비교(`packages/core/src/extract/inventory.ts`), 선택적 내용을 묻는 pdf.js 어댑터(`packages/core/src/engine/pdfjs-adapter.ts`의 `isOcVisible`), 장면에서 인벤토리를 다시 만드는 `inventoryOfSlide`(`packages/core/src/scene/inventory.ts`, §19)
- 읽는 법: 이 규칙들은 M0 개발 중에 하나씩 정했고, 그동안은 커밋하지 않는 개발 진행 기록에 번호로만 남아 있었다. 이제 이 문서가 기준이다. 코드 주석은 "`docs/decisions/0002-inventory-contract.md` §5 shade bbox"처럼 절 번호와 괄호 안의 영어 이름으로 이 문서를 가리킨다. 규칙을 바꿀 때는 이 문서, 오라클, walker를 한 커밋에서 함께 바꾼다.

## 인벤토리란

PDF 한 쪽에서 **무엇을 어디에 칠했는가**(paint)와 **글자가 어디에 있는가**(glyph)를 적은 목록이다. 두 프로그램이 같은 형식으로 이 목록을 만든다.

- **오라클**: PyMuPDF(MuPDF)로 만든 기준값이다. 시험 도구(`harness/`) 안에만 있다.
- **walker**: 제품 코드다. pdf.js가 준 명령 목록을 직접 해석한다.

`compareInventories`가 두 목록을 비교한다. 목록이 같으면 walker가 PDF를 MuPDF와 같게 읽었다는 뜻이다. 아래 규칙은 "둘이 같아야 하는 것"을 정한다. 한쪽만 다르게 하면 거짓 차이가 나거나, 진짜 차이를 놓친다.

## 1. 공통 형식 (types)

두 쪽이 내는 JSON의 모양이다. TypeScript 정의는 `packages/core/src/extract/inventory.ts`에 있다.

```ts
type Box = [x0: number, y0: number, x1: number, y1: number];   // pt, 슬라이드 좌표계
interface Inventory { pages: PageInv[] }
interface PageInv { index: number; size: [w: number, h: number]; paints: Paint[]; glyphs: Glyph[]; invisible: InvisibleGlyph[] }
type PathSeg =                        // 경로의 선분 하나. 점은 슬라이드 좌표계(§14)
  | ['M', x: number, y: number] | ['L', x: number, y: number]
  | ['C', x1: number, y1: number, x2: number, y2: number, x3: number, y3: number] | ['Z'];
interface LineInv {                   // 선 속성(§15)
  w: number; cap: 0 | 1 | 2; join: 0 | 1 | 2; miter: number; dash: number[]; phase: number;
}
type Ctm = [a: number, b: number, c: number, d: number, e: number, f: number];   // x' = a·x + c·y + e, y' = b·x + d·y + f
interface Paint {                     // 칠한 순서대로
  kind: 'fill' | 'stroke' | 'shade' | 'image' | 'pattern';
  bbox: Box;                          // 도형의 상자. 선(stroke)도 선 두께만큼 넓히지 않는다
  rgb: [r: number, g: number, b: number] | null;   // 0~255 정수. fill, stroke의 단색과 이미지 마스크의 채우기 색. 그 밖에는 null
  alpha: number;                      // 0~1
  evenOdd: boolean;                   // fill에서만 뜻이 있다. 다른 종류는 false
  approx?: true;                      // walker만 단다. 상자가 어림값이다(§5). 오라클은 달지 않는다
  path?: PathSeg[];                   // fill, stroke: 그린 경로(§14)
  line?: LineInv;                     // stroke: 선 속성(§15)
  ctm?: Ctm;                          // image: PDF의 단위 정사각형 → 슬라이드 좌표계(§16)
  px?: [w: number, h: number];        // image: 그림의 너비와 높이, 픽셀(§16)
  stencil?: boolean;                  // image: 이미지 마스크이면 true(§16)
  shading?: 'function' | 'axial' | 'radial' | 'mesh';   // shade: 그라데이션의 종류(§16)
  clip: Box;                          // 칠하는 순간의 클립 상자. 소프트 마스크 영역은 넣지 않는다(§17)
  clipApprox?: true;                  // walker만 단다. 클립이 글자 클립의 어림값에서 나왔다(§17)
  groupAlpha: number;                 // 감싼 투명 그룹들의 알파의 곱(§17)
  blend: string;                      // paint에서 바깥으로 처음 만나는 normal이 아닌 블렌드 모드(§17)
  masked: boolean;                    // 위에 소프트 마스크가 있다(§17)
}
interface Glyph {                     // 기준선 위의 글자 원점과 칠하는 상태(§6)
  u: string; x: number; y: number;
  font: string;                       // 정확한 글꼴 이름, 부분집합 표지 포함
  size: number;                       // 글꼴 크기 × 글자 행렬 y축의 길이. 슬라이드 좌표계의 pt
  rgb: [r: number, g: number, b: number] | null;
  alpha: number;
  groupAlpha: number;                 // 감싼 투명 그룹들의 알파의 곱(§17)
  paint: 'fill' | 'stroke' | 'fillStroke' | 'clip';
  wmode: 0 | 1;
  type3?: true;                       // Type 3 글꼴이면 양쪽 모두 단다(§6)
}
interface InvisibleGlyph { u: string; x: number; y: number; font: string; type3?: true }   // Tr 3의 글자(§6)
```

- **좌표계**: 모든 좌표는 슬라이드 좌표계다. 단위는 pt, 원점은 왼쪽 위, y는 아래로 커진다. 페이지의 `/Rotate`와 CropBox 원점 이동을 적용한 뒤의 값이다.
- **반올림**: 모든 숫자는 소수점 셋째 자리에서 반올림한다. `-0`은 `0`으로 쓴다.
- **paint 순서**: `paints`는 PDF가 칠한 순서 그대로다.
- **채우기와 선을 한 명령으로**(`B`, `b`, `B*`, `b*`) 그리면 `fill` 하나 다음에 `stroke` 하나, 두 개가 된다.
- **paint가 아닌 것**: 클립만 하는 경로(`W n`)와 선분이 하나도 없는 경로는 paint가 아니다.
- **rgb**: `fill`과 `stroke`의 단색, 그리고 이미지 마스크(`stencil`)를 칠하는 채우기 색을 sRGB로 바꾼 0~255 정수다. `shade`, `pattern`, 이미지 마스크가 아닌 `image`는 `null`이다.
- **alpha**: 그 paint에 직접 걸린 알파다. 투명 그룹의 알파는 곱하지 않는다. 그룹 안의 내용은 알파 1에서 시작한다. 그룹의 알파는 `groupAlpha`가 나른다(§17).
- **clip, groupAlpha, blend, masked**: 모든 paint가 가진다. 글자는 `groupAlpha`를 가진다(§17). `clipApprox`는 `approx`처럼 walker만 단다.
- **image**: 상자는 단위 정사각형(0,0)~(1,1)을 현재 변환 행렬(CTM)로 옮긴 것의 상자다. 단색 이미지 마스크도 `image`다. 행렬(`ctm`), 그림의 크기(`px`), 이미지 마스크인지(`stencil`)는 §16에 있다.
- **pattern**: 타일 패턴으로 칠한 것 하나다. 상자는 그 순간의 클립이다(§9).
- **approx**: walker만 단다. 상자가 walker의 어림 글자 상자에서 나온 `shade`와 `pattern`에 붙는다(§5). 비교는 이런 paint의 종류와 순서만 본다(§12). 오라클은 이 필드를 쓰지 않는다.
- **path, line**: `fill`과 `stroke`의 경로는 §14, `stroke`의 선 속성은 §15에 있다. `shade`, `image`, `pattern`에는 없다.
- **ctm, px, stencil, shading**: `image`는 앞의 셋을, `shade`는 `shading`을 가진다(§16). 다른 종류에는 없다.
- **glyph**: `u`는 그 글자의 유니코드 문자다. 글리프 하나가 여러 문자로 매핑되면(ToUnicode 1:N) 문자마다 하나씩, 모두 같은 원점에 둔다. ToUnicode가 U+0000 하나로 매핑한 글자는 "유니코드가 없다"는 뜻이라 U+FFFD다. MuPDF가 그렇게 내고, walker는 pdf.js가 주는 U+0000을 바꾼다(Skia가 이런 항목을 쓴다). 나머지 필드는 §6에 있다.
- `size`는 슬라이드 좌표계에서 쪽의 너비와 높이다.

## 2. 쪽 번호 (page index)

- `pages[].index`는 양쪽 모두 **0부터 센** 쪽 번호다.
- 반면 오라클 명령의 `--pages` 인자와 walker 시험의 쪽 목록은 사람이 읽는 **1부터 센** 쪽 번호다.
- 예: `--pages 1`로 오라클을 돌리면 결과의 `index`는 `0`이다.

## 3. 페이지 내용만 (page contents only)

- 인벤토리에는 쪽의 내용(content stream)만 들어간다. 주석(annotation)과 양식 위젯은 넣지 않는다.
- 오라클은 `fz_run_page_contents`로 쪽을 돌린다. `fz_run_page`는 주석까지 그리므로 쓰지 않는다.
- walker는 pdf.js에 `getOperatorList({ annotationMode: AnnotationMode.DISABLE })`로 명령 목록을 받는다.
- 이유: 한쪽만 주석을 그리면 주석이 있는 PDF에서 거짓 차이가 난다.

## 4. 경로 상자 (path bbox)

- `fill`과 `stroke`의 상자는 **경로의 모든 점**을 CTM으로 옮긴 뒤의 경계다. 베지어 곡선의 **제어점도 포함**한다. MuPDF의 `fz_bound_path(path, NULL, ctm)`와 같은 뜻이다.
- 곡선이 실제로 지나가는 가장 바깥(꼭 맞는 경계)이 아니다. 예: `50 50 m 50 150 200 150 200 50 c` 곡선은 PDF 좌표로 y 125까지만 가지만, 제어점이 y 150에 있으므로 상자는 150까지다.
- 선 두께로 넓히지 않는다. `stroke`도 마찬가지다.
- `moveTo`는 뒤에 선분이 올 때만 점으로 센다. 끝에 남은 `moveTo`나 연달아 나온 `moveTo`는 상자에 넣지 않는다(MuPDF와 같다).
- `moveTo` 바로 뒤의 `closePath`(`m h`)는 CTM이 축을 지킬 때(§15)만 그 점을 상자에 넣는다. 회전이나 기울임이 있는 CTM에서는 넣지 않는다. 그래서 그런 CTM 아래에서 `m h`밖에 없는 경로는 상자가 없고 paint도 아니다. MuPDF에서 잰 결과다.
- 첫 `moveTo` 앞의 선분, 곡선, `closePath`는 현재 점이 없어서 세지 않는다. 그것뿐인 경로는 paint가 아니다.
- walker는 이 상자를 pdf.js가 계산해 주는 `minMax` 값으로 쓰지 않는다. 그 값은 곡선에 꼭 맞게 잡힐 수 있어서 제어점 기준과 다를 수 있다. walker는 경로 명령(`DrawOPS`)을 선분으로 바꾼 뒤(§14) 거기서 직접 계산한다(`boundsOf`).
- 이 상자는 비교용이다. 꼭 맞는 경계가 필요한 다음 단계는 따로 계산한다.

## 5. 그라데이션 상자와 클립 스택 (shade bbox)

**`shade` paint의 상자는 그 순간의 클립 상자다.** 클립 상자는 지금 걸려 있는 모든 클립 상자의 교집합을 쪽 크기로 자른 것이다. 타일 패턴의 `pattern` paint도 같은 클립을 쓴다(§9).

- 이유 1: 끝을 늘이는(Extend) 축 그라데이션은 범위가 무한해서 그라데이션 자신의 상자가 없다.
- 이유 2: 작성기(M3)는 이 클립 상자를 그라데이션 도형의 위치로 쓴다(M0-6에서 확인).

**클립 스택(오라클)**:

- 맨 아래 칸은 쪽 사각형이다.
- 다음 호출이 올 때마다 "그 호출의 상자 ∩ 지금 클립"을 한 칸 쌓는다: `clip_path`, `clip_stroke_path`, `clip_text`, `clip_stroke_text`, `clip_image_mask`, 그리고 `end_mask`에서 MuPDF가 알려 주는 마스크 영역.
- `pop_clip` 하나마다 한 칸을 뺀다.
- 교집합이 비면 상자는 `[0, 0, 0, 0]`이다.
- 모든 paint가 내는 `clip`도 이 스택이다. 단 소프트 마스크 영역은 넣지 않는다(§17).

**walker도 같은 규칙을 따른다**:

- 클립 경로(`W`/`W*` 다음의 경로)가 클립을 좁힌다. 선분이 없는 클립 경로는 전부를 잘라 낸다(`[0, 0, 0, 0]`).
- 글자 클립: 그리기 방식 4~7의 글자가 있는 `BT..ET` 블록은 `ET`에서 클립을 좁힌다.
- 폼 XObject와 투명 그룹의 `/BBox`도 클립을 좁힌다.
- `Q`와 폼·그룹의 끝에서 클립이 되돌아간다.
- 소프트 마스크 영역은 `sh`의 경계가 정해진 그라데이션일 때만 쌓는다(§10).

**그라데이션 패턴으로 칠한 것**도 `shade`가 된다(타일 패턴은 §9).

- 그라데이션 패턴으로 채운 경로: `fill`이 아니라 `shade` 하나. 상자는 클립 ∩ 경로 상자다.
- 그라데이션 패턴으로 채운 글자: 글자(§6)와 함께 **글자 묶음**(아래)마다 `shade` 하나. 상자는 클립 ∩ 그 묶음의 상자(사방 1pt 여유)다. 타일 패턴으로 채운 글자(§9)도 같다.
- 그라데이션 패턴 색의 이미지 마스크: `shade` 하나. 상자는 클립 ∩ 이미지 상자다.
- 그라데이션 패턴으로 그린 선: `stroke`가 아니라 `shade` 하나. 상자는 클립 ∩ 선이 닿는 상자(§15 `strokeBounds`)이고, 알파는 선 알파(`CA`)다. 채우기와 선을 한 명령으로 그리면 채우기의 paint 다음에 이 paint가 온다.
- 그라데이션 패턴으로 선을 그린 글자: 글자(§6)와 함께 글자 묶음마다 `shade` 하나. 상자는 묶음의 상자(사방 1pt 여유)를 §15의 식으로 넓혀 클립과 교집합한 것이다. 채우기도 패턴이면 `shade`나 `pattern`이 채우기와 선에 하나씩, 둘이다. 순서는 채우기, 선이다.

**글자 묶음 (text stretch)**: MuPDF는 `Tj`마다 칠하지 않는다. 글자를 모아 두었다가, 아래의 일이 생길 때 한 번에 칠한다. 패턴이면 이때 `shade`나 `pattern`이 하나 나온다. walker도 같은 때 낸다. 오라클과 비교해서 잰 규칙이다.

- **묶음을 끝내는 것**: 색(`rg`, `RG`, `g`, `G`, `k`, `K`, `sc`, `SC`, `scn`, `SCN`. 같은 색이어도, 채우기에 쓰이지 않는 선 색이어도), 선 상태(`w`, `J`, `j`, `M`, `d`), `ri`, 표시 내용(`BMC`, `BDC`, `EMC`), `ET`. 쪽이 끝나도 칠한다.
- **`gs`는 키에 달렸다.** `LW`, `LC`, `LJ`, `ML`, `D`, `RI`, `CA`, `ca`, `BM`, `SMask`, `OP`, `op`, `OPM`이 있으면 값이 그대로여도 끝낸다. `FL`, `Font`, `TR`, `TR2`, `SA`, `AIS`, `TK`, `SM`, `HT`, `BG`, `BG2`, `UCR`, `UCR2`, `Type`만 있으면 끝내지 않는다.
- **그리기 방식이 바뀌면 다음 글자가 나올 때** 끝낸다. `Tr`만으로는, 그리고 빈 `()Tj`로는 끝나지 않는다. 같은 값의 `Tr`도 그렇다.
- **끝내지 않는 것**: `Tf`, `Td`, `TD`, `Tm`, `T*`, `Tc`, `Tw`, `Tz`, `TL`, `Ts`, `'`, `"`, `i`, `BX`, `EX`, `BT`.
- PDF가 글자 블록 안에서 금지한 것도 재 두었다. `q`는 끝내지 않고 `Q`, `cm`, `W`, `W*`는 끝낸다. 경로 칠하기, `sh`, 그림은 끝내지 않는다. 그래서 그 paint가 먼저 나오고 글자의 paint는 묶음이 끝날 때 나온다. 이 경우 일부는 맞추지 않았다(§13).
- 칠하는 상태는 묶음이 끝날 때의 상태이지만, 상태를 바꾸는 것은 모두 묶음을 끝내므로(`q`만 빼고) 글자를 낼 때의 상태와 같다. 그래서 글자의 색과 알파(§6)는 `Tj` 때의 값으로 맞는다.
- walker는 pdf.js가 넘기지 않는 것을 볼 수 없다. `MP`, `DP`, `cs`, `CS`, 그리고 pdf.js가 버리는 `OP`, `op`, `OPM`만 있는 `gs`도 MuPDF에서는 묶음을 끝낸다(§13).

**walker의 근사와 `approx` 표시**: 글자 클립 상자와 글자 묶음 상자는 글자의 진행 상자(원점에서 진행 폭까지, 글꼴의 descent에서 ascent까지)로 어림한다. MuPDF의 글자 경계처럼 사방 1pt 여유를 둔다. 글꼴에 ascent/descent 값이 없으면 0으로 두므로, 합성 사례에서는 실제와 최대 13.5pt까지 달랐다(실험 파일에는 이런 경우가 없다).

그래서 walker는 상자가 이 어림값에서 나온 paint에 `approx: true`를 단다.

- 그라데이션이나 타일 패턴으로 채우거나 선을 그린 글자의 `shade`와 `pattern`. 언제나 붙는다.
- 글자 클립이 클립을 좁힌 뒤의 `shade`와 `pattern`. `ET`에서 글자 클립이 걸린 때부터, 그 클립을 되돌리는 `Q`(또는 폼·그룹의 끝)까지다. 그사이 클립 경로나 폼 상자로 더 좁혀져도 표시는 남는다.
- `fill`, `stroke`, `image`의 상자는 클립을 쓰지 않으므로 표시가 붙지 않는다.

비교는 `approx` paint의 상자와 값을 보지 않고 종류와 칠한 순서 안의 자리만 본다(§12). 그래서 이 상자들의 회귀는 비교가 잡지 못한다(§13).

## 6. 글자 (glyphs)

**글자 = 그리기 방식(Tr)이 3이 아닌 모든 글자 덩어리(run)의 글자다.** 즉 Tr 0~2와 4~7이다. 덩어리 하나는 한 번만 센다.

- **Tr 3**(보이지 않는 글자)은 글자가 아니다. `glyphs`가 아니라 `invisible`에 넣는다(아래).
- **Tr 2**(채우기와 선)는 글자 하나다. 채우기와 선으로 두 번 세지 않는다. Tr 6도 같다.
- **패턴이나 그라데이션으로 채운 글자**도 글자다. 글자와 함께 `shade`(§5)나 `pattern`(§9) paint도 나온다.
- **Tr 7**(클립만 하고 아무것도 칠하지 않는 글자)도 글자로 센다. `paint`가 `clip`이다.

**글자의 상태**: 글자마다 어떻게 칠하는지를 함께 적는다. PPTX 작성기가 이 값을 쓴다.

| 필드 | 뜻 | 오라클 | walker |
|---|---|---|---|
| `font` | 정확한 글꼴 이름, 부분집합 표지 포함 | `fz_font_name` | pdf.js `font.name` |
| `size` | 글꼴 크기 × 글자 행렬 y축의 길이(슬라이드 좌표계). 부호는 없고, `Tz`는 들어가지 않는다 | 덩어리 `trm`의 y축 × CTM | `Tf` 크기 × CTM × `Tm`의 y축 |
| `rgb` | 채우면 채우기 색, 선만 그리면 선 색. 그 색이 패턴이면 `null`, `clip`이면 `null` | `fill_text`, `stroke_text`의 색 | 글자를 낼 때의 색 |
| `alpha` | 채우면 `ca`, 선만 그리면 `CA`, `clip`이면 1 | 그 호출의 알파. 패턴은 §5, §9 | 글자를 낼 때의 알파 |
| `paint` | Tr 0, 4는 `fill`, 1, 5는 `stroke`, 2, 6은 `fillStroke`, 7은 `clip` | 아래 | `Tr`에서 바로 |
| `wmode` | 1이면 세로쓰기 | 덩어리의 `wmode` | pdf.js `font.vertical` |

**오라클이 세는 방법**:

- `fill_text`와 `stroke_text`에서 글자를 낸다.
- `clip_text`와 `clip_stroke_text`에서는 아직 내지 않은 글자만 낸다. 패턴으로 채운 글자는 MuPDF가 `clip_text` 다음에 `fill_shade`(그라데이션)나 칸 그리기(타일, §9)로 그리므로 여기서 잡힌다.
- 같은 덩어리를 두 번 내지 않는다.
  - Tr 2와 6에서 `stroke_text`가 바로 앞의 `fill_text`/`clip_text`와 같은 덩어리면 건너뛰고, 앞서 낸 글자의 `paint`를 `fillStroke`로 고친다. 선을 패턴으로 그리면 `stroke_text` 대신 `clip_stroke_text`가 오는데, 이것도 같다. 따로 이어지는 다른 덩어리(`0 Tr (A) Tj 1 Tr (B) Tj`)는 둘 다 낸다.
  - Tr 4~6은 `ET`에서 블록 전체를 누적 `clip_text`로 한 번 더 보낸다. 그 글자들은 앞서 낸 글자(같은 문자, 같은 위치)와 하나씩 짝지어 지운다.
- `clip_text`로만 본 글자는 일단 `clip`이다. 그 클립 아래에 패턴 하나(`fill_shade` 하나, 또는 타일 칸)만 칠해지고 `pop_clip`이 오면 패턴으로 채운 글자이므로 `fill`로 고치고, 알파는 그 `fill_shade`의 값으로 한다(타일은 1, §11). `clip_stroke_text`도 같은 식으로 `stroke`다.
- 이 판단의 한계가 하나 있다. Tr 7 블록 바로 뒤에 `sh` 하나만 칠하고 그 클립이 끝나면(`q 7 Tr BT (A) Tj ET /Sh sh Q`) 장치가 받는 호출이 패턴으로 채운 글자와 똑같다. 오라클은 `fill`로 낸다(§13). 그 아래에 무엇이든 하나 더 칠하면 `clip`이다.

**walker가 세는 방법**:

- `showText`에서 Tr이 3이 아니면 글자를 낸다.
- Tr 7 덩어리의 글자는 MuPDF가 `ET`에서야 받으므로, walker도 `ET`에서 낸다. 그래서 순서가 같다.

**보이지 않는 글자 (invisible)**: Tr 3의 글자다. 비교는 글자처럼 한다(§12). 필드는 `u`, `x`, `y`, `font`이고 Type 3 글꼴이면 `type3`도 있다. 칠하지 않으므로 색, 알파, 크기는 적지 않는다. 오라클은 `ignore_text`에서, walker는 `showText`에서 모은다. 소프트 마스크와 타일 칸의 내용은 여기도 들지 않는다(§9).

**세로쓰기 (vertical writing)**: `Identity-V` 같은 세로 CMap의 글꼴이다. 원점은 글자 자신의 원점이다. 양쪽 모두 같은 식이고 `/W2`, `/DW2`를 읽는다. `[w1y, vx, vy]`가 글자의 세로 값(천분율)이고 기본은 `[-1000, 글자 폭 ÷ 2, 880]`이다. `s`는 글꼴 크기 ÷ 1000이다.

```
원점 x = 현재 x − vx × s × Tz × 크기의 부호
원점 y = 현재 y + Ts − (진행량 + vy × s) × 크기의 부호
진행량에 더한다: −w1y × s − (Tc + 공백이면 Tw) × 크기의 부호
TJ의 수 n: 진행량에 n × 글꼴 크기 ÷ 1000을 더한다
덩어리가 끝나면 현재 y를 진행량 × 크기의 부호만큼 뺀다
```

pdf.js `showText`와 같다. 마지막 줄만 다르다. pdf.js는 부호 없이 빼므로 음수 크기의 덩어리 뒤에서 어긋난다. PDF 규격과 MuPDF는 위와 같다.

**Type 3 글꼴**: PDF 규격대로(9.3.6) 그리기 방식이 뜻이 없다.

- MuPDF와 walker 모두 Tr 3과 7은 보이지 않는 글자(`invisible`)로, 나머지는 `fill`로 낸다. 색과 알파는 채우기의 값이다. 글자 클립도 없다.
- MuPDF는 Tr이 0이나 3이 아니면 글자마다 묶음을 끝낸다(§5). 패턴으로 채우면 `shade`나 `pattern`이 글자마다 나온다. walker도 같다.
- **글리프의 내용은 paint가 아니다.** MuPDF는 `d0` 글리프가 물려받은 색으로 칠하면 칸처럼 쪽에 바로 그리고, 글자는 `ignore_text`로 알린다. 그대로 두면 칠이 paint로, 글자가 보이지 않는 글자로 잘못 나온다. 그래서 오라클은 `detail`이 있을 때 쪽을 돌리기 전에 **메모리 안에서만** 모든 Type 3 글리프의 내용을 빈 `d1`로 바꿔 둔다(§9의 칸과 같은 방법. 파일은 그대로다). 그러면 MuPDF가 모든 글자를 `fill_text`로 보낸다. 진행 폭은 `/Widths`에서 오므로 달라지지 않는다.
- `font`: MuPDF는 `Type3 (5 0 R)`처럼 객체 번호로 부르고 pdf.js는 글꼴 설명자의 이름을 준다. 뜻이 다르므로 비교하지 않는다. 대신 양쪽 모두 `type3`을 단다. `size`는 양쪽이 같아서(글꼴 행렬이 들어가지 않는다) 비교한다. 원점과 `u`도 비교한다.

**`detail=False`**: `inventory(..., detail=False)`(비교하지 않는 `harness/fidelity`용)의 글자는 `u`, `x`, `y`뿐이다. `invisible`도 없고 Type 3 글리프도 바꾸지 않는다. M2 앞의 결과와 같다.

## 7. 클립 밖 글자 (no clip culling)

- 클립 밖에 있는 글자도 양쪽 모두 센다. 화면에 보이지 않는 자리의 글자도 인벤토리에 있다.
- MuPDF 자체의 글자 추출은 클립 밖 글자를 버리지만, 오라클은 버리지 않는다.

## 8. 공백 글자 (whitespace)

- 공백만 있는 글자(`u.trim() === ''`)도 **출력에는 남긴다.** 양쪽 모두 그렇다.
- **비교할 때만** 양쪽에서 함께 뺀다(§12). 예: 실험 PDF 1쪽은 글자 119개, 공백을 빼면 99개다.
- 계약은 "비교하기 전에 뺀다"이지 "출력에서 뺀다"가 아니다.

## 9. 마스크와 타일 패턴의 내용 (mask and pattern contents)

**마스크와 칸의 내용은 paint도 글자도 아니다.** 소프트 마스크를 정의하는 내용과 타일 패턴 칸(cell)의 내용은 마스크·패턴 데이터이지 쪽의 내용이 아니기 때문이다. 양쪽 모두 뺀다.

- walker(pdf.js): 소프트 마스크 그룹의 내용은 쪽의 명령 목록 **안에** 그대로 있다(`smask`가 달린 `beginGroup`..`endGroup`). walker는 그 사이를 쪽의 목록이 아니라 그 마스크의 목록(`SoftMask.ops`)에 모은다. 장면(Scene)은 이것으로 마스크의 내용(`MaskDef`)을 만든다. 쪽의 paint와 글자에는 넣지 않으므로 인벤토리에 들지 않는다. 따로 떨어져 있는 것은 타일 패턴 칸의 내용뿐이다. pdf.js는 칸마다 별도의 명령 목록을 만들어 패턴 색 안에 넣으므로, 칸의 내용은 쪽의 명령 목록에 나오지 않는다.
- 오라클(MuPDF): `begin_mask`..`end_mask`와 `begin_tile`..`end_tile` 사이를 숨긴다. MuPDF가 `begin_tile` 없이 칸을 쪽에 바로 그리는 경우에는 칸의 내용을 미리 표지로 바꿔 둔다(아래 "오라클이 타일 채우기를 찾는 방법").

**타일 패턴으로 칠한 것은 `pattern` paint 하나다.** 타일 패턴으로 채운 경로, 이미지 마스크, 글자 묶음(§5)마다, 그리고 타일 패턴으로 그린 선마다 하나씩 나온다.

- 상자는 그 순간의 클립이다(§5). 경로는 경로 상자 ∩ 클립, 이미지 마스크는 단위 정사각형의 상자 ∩ 클립, 글자는 글자 클립 상자 ∩ 클립, 선은 선이 닿는 상자(§15 `strokeBounds`) ∩ 클립이다.
- `rgb`는 `null`, `alpha`는 채우기 알파(선이면 선 알파), `evenOdd`는 `false`다.
- 칸의 내용은 여전히 paint가 아니다. 칸 안의 그림(예: PowerPoint가 그림 채우기를 내보낸 JPEG)도 `image`로 나오지 않는다.
- 타일 패턴으로 채우거나 선을 그린 글자는 글자로도 센다(§6). 글자들과 함께 묶음마다 `pattern` paint 하나가 나온다. 그 상자는 어림값이라 walker는 `approx`를 단다(§5).

**오라클이 타일 채우기를 찾는 방법**: MuPDF는 먼저 칠할 모양을 클립으로 쌓고(`clip_path`, `clip_text`, `clip_image_mask`, 선이면 `clip_stroke_path`, `clip_stroke_text`), 그다음 칸을 그린다. 어느 길로 그릴지는 칠할 영역(모양의 상자를 패턴 공간으로 옮긴 것)의 **크기**가 정한다. 영역이 칸 경계를 몇 개 넘는지는 상관없다.

- 영역이 가로로 `XStep`보다 넓거나 세로로 `YStep`보다 높으면, `begin_tile`을 한 번 부르고 칸을 한 번 그려 타일로 깐다. 오라클은 `begin_tile`에서 `pattern` paint를 내고 `end_tile`까지 숨긴다.
- 그렇지 않으면(가로 `XStep` 이하, 세로 `YStep` 이하) `begin_tile`을 부르지 않는다. 대신 영역이 걸친 칸**마다** 칸의 내용을 쪽에 **바로** 그린다. 칸 하나 안이면 한 번, 칸 경계를 넘으면 두 번이나 네 번이다(예: 칸 10pt에 `5 1 10 8 re f`는 두 번, `5 5 10 10 re f`는 네 번). PowerPoint의 그림 채우기처럼 칸이 그림만큼 큰 패턴이 이 경우다. 장치(device)에서는 이렇게 그린 칸의 내용을 쪽의 내용과 구별할 수 없다.
- 그래서 오라클은 쪽을 돌리기 전에, **메모리 안에서만** 모든 타일 패턴의 칸 내용을 표지 하나로 바꿔 둔다(`ActualText`가 정해진 문자열인 표시 내용 `BDC`..`EMC`. 파일은 그대로다). 칸을 바로 그리면 장치에는 칸마다 이 표지(`begin_metatext`)만 온다.
- 오라클은 **모양의 클립 하나에 `pattern` paint를 하나만** 낸다. 클립 스택의 칸마다 일련번호를 붙여 두고, 같은 클립 칸이 맨 위에 있는 동안 오는 표지는 첫 번째만 센다. 한 채우기의 칸들은 모두 그 채우기의 모양 클립 아래에서 오고, 다음 채우기는 자기 모양 클립을 새로 쌓는다. `begin_tile` 안에서 오는 표지는 숨겨져 있으므로 세지 않는다.
- 칸의 내용은 원래 인벤토리에 들어가지 않으므로 이렇게 바꿔도 다른 결과는 같다. MuPDF가 타일과 바로 그리기 가운데 고르는 방식도 칸의 내용과 상관없다.
- 시험에서 MuPDF는 타일 채우기 하나에 `begin_tile`을 한 번 부르거나, 0번 부르고 칸을 1·2·4번 바로 그렸다(경로, 이미지 마스크, 글자 모두). 어느 쪽이든 `pattern` paint는 정확히 하나다.

**오라클의 알파**: MuPDF는 칸을 그릴 때 채우기 알파를 함께 주지 않는다.

- 경로를 채울 때 채우기 알파가 1보다 작으면, MuPDF는 그 채우기를 그 알파의 그룹(`begin_group`)으로 감싼다. 이 그룹은 모양의 클립 바로 앞에 열린다. 오라클은 그 그룹에서 알파를 읽는다. 경로의 선도 선 알파로 똑같이 감싼다. 폼 XObject의 투명 그룹은 열린 뒤 자기 `/BBox`를 클립으로 쌓으므로 이것과 헷갈리지 않는다. 이 그룹의 알파는 paint 자신의 알파이므로 `groupAlpha`(§17)에 넣지 않는다.
- 글자와 이미지 마스크는 MuPDF가 채우기 알파를 무시하고 패턴을 불투명하게 그린다. 글자의 선도 선 알파를 무시한다. 그래서 오라클은 알파 1을 낸다(§11 오라클 한계).

## 10. 소프트 마스크 영역 (soft-mask area)

- 오라클은 §5대로 `end_mask`에서 마스크 영역을 클립 스택에 쌓는다. 이 영역은 마스크를 받은 물체의 경계(슬라이드 좌표계)이고, 마스크 폼의 `/BBox`가 아니다.
- MuPDF는 마스크를 받은 물체마다 그 물체 자신의 경계로 클립했다가 바로 빼므로, 대부분은 다른 상자를 좁히지 않는다. 결과가 달라지는 경우는 소프트 마스크 아래에서 **경계가 정해진 `sh`**를 그릴 때뿐이다. 이때 `shade`의 상자는 클립 ∩ 그라데이션의 경계다.
- **walker도 같다.** `sh`에서 마스크가 걸려 있고(`GState.masked`) 그 마스크를 투명 그룹이 가져가지 않았고(`GState.maskInGroup`, 아래) 그라데이션에 경계가 있으면, 클립과 그 경계의 교집합을 상자로 쓴다. 경계가 없으면 클립 그대로다.

**그라데이션의 경계**(MuPDF의 `fz_bound_shade`, walker는 pdf.js의 중간 표현에서 읽는다):

- 축(2)과 원형(3): `/BBox`가 있으면 그것이다. 없으면 경계가 없다(끝을 늘이든 아니든).
- 메시(4~7)와 함수형(1): 꼭짓점의 상자와 `/BBox`의 교집합이다. 패치 메시(6, 7)의 꼭짓점은 제어점까지이고 곡선이 지나가는 가장 바깥이 아니다. 함수형은 `/Domain`을 `/Matrix`로 옮긴 상자다. 둘이 만나지 않으면 남는 것이 없어 상자는 `[0, 0, 0, 0]`이다. `/BBox`가 없으면 꼭짓점의 상자 하나다.
- 이 경계는 그라데이션 공간의 상자다. 영역은 그 네 모서리를 CTM으로 옮긴 것의 경계다. CTM이 회전하면 옮긴 모양의 경계가 아니라 옮긴 상자의 경계다(함수형의 `/Matrix`가 돌려도 마찬가지다).

**마스크가 걸려 있는 상태**(`masked`): gs의 `/SMask` 딕셔너리가 켜고 `/SMask /None`이 끈다. `q`와 `Q`로 저장하고 되돌리며, 폼 XObject는 부른 쪽의 상태를 이어받는다. 단 **투명 그룹인 폼**(`/Group`)은 마스크를 그룹 전체에 쓰고 그 안의 내용에는 걸지 않는다. 알파가 1에서 시작하는 것(§1)과 같다. 그룹 안에서도 `masked`는 참이지만 마스크는 그룹이 가져갔으므로(`maskInGroup`), 안의 `sh`는 줄지 않는다. 그 안에서 새로 `/SMask`를 걸면 그 마스크는 안의 물체에 걸린다. `/Group`이 없는 폼은 마스크를 이어받아 안의 물체마다 받는다. 인벤토리의 `masked`(§17)는 이와 달리 그룹이 가져간 마스크도 센다. 그룹 안의 물체도 그 마스크 아래에 있기 때문이다.

**줄지 않는 것**: 그라데이션 패턴(`scn`)으로 칠한 경로, 선, 글자, 이미지 마스크의 `shade`는 마스크 아래에서도 §5의 상자 그대로다. MuPDF가 마스크에 넘기는 영역이 그 모양의 상자와 같기 때문이다. 이미지와 일반 경로, 글자도 자기 상자가 곧 영역이라서 남는 것이 없다. 이것들은 `sh`와 달리 그라데이션 자신의 경계를 쓰지 않는다.

합성 PDF로 오라클과 비교해 맞췄다(`walker.contract.local.test.ts`의 "a bounded sh under a soft mask has the narrowed box", 오라클 쪽은 `test_a_bounded_sh_under_a_soft_mask_is_bounded_by_the_shading`).

## 11. 오라클 한계: MuPDF 글자 클립 (MuPDF text clip)

- MuPDF는 `BT..ET` 블록에서 **마지막으로 글자를 낸 그리기 방식**이 클립 방식(4~7)일 때만 블록에 쌓인 글자 클립을 `clip_text`로 보낸다. 글자 없이 `Tr`만 바꾼 것은 세지 않는다.
- 블록이 글자 0~2로 끝나면 `clip_text`가 오지 않는다. 그러면 (1) 글자 클립이 적용되지 않고, (2) 그 블록의 Tr 7 글자가 사라진다. 예: `BT 7 Tr (B) Tj 0 Tr (A) Tj ET`에서 오라클은 `A`만 낸다.
- 블록이 글자 3으로 끝나면 쌓인 글자 클립이 `ignore_text`로 온다. 오라클은 그 글자를 `invisible`에 넣는다. 예: `BT 4 Tr (A) Tj 3 Tr (B) Tj ET`에서 `A`는 `glyphs`와 `invisible`에 다 있고, `BT 7 Tr (A) Tj 3 Tr (B) Tj ET`에서 `A`는 `invisible`에만 있다.
- walker는 §6 규칙과 PDF 규격(그리고 pdf.js)대로 Tr 7 글자를 글자로 세고, `ET`에서 클립도 적용한다.
- 그래서 이런 블록에서 생긴 차이는 **오라클의 한계**이지 walker의 잘못이 아니다. walker 시험의 합성 사례는 블록이 클립 방식으로 끝나게 만들어 이 한계를 피한다.
- 오라클의 한계가 하나 더 있다. 같은 글자를 같은 위치에, 그리기 방식이 다른 별도 덩어리로 두 번 그리면(예: `0 Tr (A) Tj` 다음에 따로 `1 Tr (A) Tj`) 오라클의 중복 제거(§6)가 둘을 하나로 합칠 수 있다. 이때는 오라클 쪽 글자 수가 적게 나온다.
- 타일 패턴의 알파도 오라클의 한계다(§9). MuPDF 1.28은 타일 패턴으로 채운 글자와 이미지 마스크를 채우기 알파(`ca`)와 상관없이 불투명하게 그린다(렌더링으로 확인했다). 그래서 오라클의 `pattern` 알파는 1이고, walker는 채우기 알파를 낸다. 글자의 `pattern`은 `approx`라 알파를 비교하지 않지만, 이미지 마스크의 `pattern`은 알파가 1보다 작으면 `alpha` 차이로 드러난다. 타일 패턴으로 채운 글자 자체의 `alpha`(§6)도 같은 이유로 오라클은 1, walker는 채우기 알파다.

## 12. 비교 규칙 (comparison)

`compareInventories(expected, actual, tolPt)`. `expected`는 오라클, `actual`은 walker, 허용 오차 `tolPt`의 기본값은 0.05pt(`TOLERANCE_PT`)다.

- **쪽**: 순서대로 짝짓는다. `index`가 같아야 하고, `size`는 허용 오차 안이어야 한다.
- **paint 개수와 순서**: 종류별 개수와 종류의 순서(칠한 순서)가 같아야 한다.
- **paint 값**: 종류별로 순서대로 짝지어 비교한다. 그래서 `fill`이 하나 더 있어도 `stroke` 비교가 한 칸씩 밀리지 않는다.
  - `bbox`: 네 좌표가 모두 허용 오차 안.
  - `rgb`: 채널마다 ±1. 두 엔진이 0~1 색을 0~255로 반올림하는 방식이 달라서다. `null`은 `null`하고만 같다.
  - `alpha`: ±1/255.
  - `evenOdd`: 같아야 한다.
  - `path`: 양쪽을 `canonicalPath`(§14)로 바꾼 뒤 길이와 연산자가 같고, 모든 좌표가 허용 오차 안이어야 한다. 경로 하나의 차이는 점이 몇 개 다르든 한 줄이다. 길이나 연산자가 다르면 첫 차이를 적고, 좌표만 다르면 첫 차이와 가장 큰 차이, 다른 선분의 수를 적는다.
  - `line`: `w`, `dash`의 각 값, `phase`는 허용 오차 안(`tolPt`, 기본 0.05pt), `miter`는 ±0.01, `cap`과 `join`은 같아야 하고 `dash`의 길이도 같아야 한다. 차이는 필드마다 한 줄이다.
  - `ctm`: 여섯 계수가 모두 허용 오차(`tolPt`) 안이어야 한다. 행렬 하나의 차이는 한 줄이다.
  - `px`: 두 값이 모두 같아야 한다(양의 정수). `stencil`: 같아야 한다. `shading`: 같아야 한다. 차이는 필드마다 한 줄이다.
  - `path`, `line`, `ctm`, `px`, `stencil`, `shading`은 양쪽 다 없으면 비교하지 않고, 한쪽에만 있거나 꼴이 틀리면 차이다. 오라클의 명령줄과 walker는 `fill`과 `stroke`에 `path`를, `stroke`에 `line`을, `image`에 `ctm`, `px`, `stencil`을, `shade`에 `shading`을 언제나 쓴다. `walker.contract.local.test.ts`가 실제로 있는지 확인한다. `inventory(..., detail=False)`만 이것들을 뺀다. 그것은 비교하지 않는 `harness/fidelity`용이다.
  - `clip`(§17): `bbox`처럼 네 좌표가 모두 허용 오차(`tolPt`) 안이어야 한다. 한쪽이라도 `clipApprox`면 꼴(유한한 숫자 4개)만 본다. `maxBboxDelta`에는 넣지 않는다.
  - `groupAlpha`: ±1/255. `blend`: §17의 열여섯 이름 가운데 하나이고 같아야 한다. `masked`: 참·거짓 값이고 같아야 한다.
  - 이 넷은 종류와 상관없이 모든 paint에 있어야 한다. 양쪽 모두 없어도 차이다(`path` 등과 다르다). 차이는 필드마다 한 줄이다.
- **어림 paint**(`approx: true`, §5): 짝지은 두 `shade`나 `pattern` 가운데 하나라도 `approx`면 종류와 칠한 순서 안의 자리만 비교한다. 이 둘은 위의 개수·순서 검사가 이미 본다.
  - 상자, `rgb`, `alpha`, `evenOdd`의 값은 비교하지 않고, `maxBboxDelta`에도 넣지 않는다. `clip`도 꼴만 본다. `shading`, `groupAlpha`, `blend`, `masked`는 어림이 아니어서 비교한다.
  - 그래도 값의 꼴은 본다. 상자가 유한한 숫자 4개가 아니거나, `alpha`가 유한한 숫자가 아니거나, `rgb`가 `null`도 유한한 숫자 3개도 아니거나, `evenOdd`가 참·거짓 값이 아니면 차이다(아래의 "빠진 값" 규칙과 같다).
  - `approx`는 `shade`와 `pattern`에만 뜻이 있다. 다른 종류에 붙어 있으면 그 자체가 차이이고, 그 paint는 보통처럼 값까지 비교한다.
  - 오라클은 `approx`를 달지 않으므로 실제로는 walker 쪽 표시로 정해진다. 결과의 `approxPaints`는 이렇게 비교한 paint 짝의 수다.
- **글자**: 공백 글자를 양쪽에서 뺀 뒤(§8) 개수가 같아야 한다. 순서대로 짝지어 비교한다.
  - `u`, `paint`, `wmode`: 같아야 한다.
  - `x`, `y`, `size`: 허용 오차 안(`tolPt`, 기본 0.05pt).
  - `rgb`: 채널마다 ±1. `null`은 `null`하고만 같다. `alpha`와 `groupAlpha`: ±1/255.
  - `font`: 같아야 한다. 예외 둘. (1) 오라클 이름이 정확히 31바이트(UTF-8)이면 walker 이름의 앞부분이면 된다. MuPDF의 `fz_font.name`이 `char[32]`라서 그 뒤를 잘라 버린다. walker 쪽 이름이 짧으면 차이다. (2) Type 3 글꼴은 이름을 비교하지 않고 문자열인지만 본다(§6).
  - `type3`: 한쪽에만 있으면 차이다.
- **보이지 않는 글자**: 글자와 같게, 공백을 뺀 뒤 개수와 `u`, `x`, `y`, `font`, `type3`을 비교한다. `invisible` 목록이 없는 쪽이 있으면 차이다.
- 빠진 값, 숫자가 아닌 값, 유한하지 않은 숫자(NaN 등)는 언제나 차이다.
- **색은 있는 그대로 비교한다.** CMYK나 ICC 색도 각 엔진이 바꾼 sRGB 값을 그대로 ±1로 비교한다. 따로 봐주지 않고, 다르면 차이로 기록한다. 두 엔진의 CMYK 변환이 달라서 CMYK 파일에서는 차이가 날 수 있다.
- **차이 목록**: 쪽마다 paint, 글자, 보이지 않는 글자 부분에서 각각 50줄까지만 적고, 나머지는 `<쪽> paints: N more diffs not listed` 같은 한 줄로 줄인다. 결과의 `diffTotal`은 줄이기 전의 차이 수다(줄인 한 줄은 세지 않는다).
- 사용 예: M0-2 관문은 0.05pt로 오라클과 비교했다. M0-1은 허용 오차 0으로 브라우저 결과를 Node 결과와 비교했다.

## 13. 알려진 빈틈 모음 (known gaps)

| 빈틈 | 영향 | 언제 다루나 |
|---|---|---|
| walker의 글자 클립 상자는 근사값이다(§5) | `approx`로 표시하고 종류와 순서만 비교한다. 글자 클립 아래나 패턴·그라데이션으로 채운 글자의 `shade`·`pattern` 상자 회귀는 비교가 잡지 못한다 | 정확한 상자를 만들지 않는다. 이런 paint가 tier A(PowerPoint가 내보낸 파일 1,324쪽)에 0개이고, 만들려면 글꼴 프로그램의 글리프 경계가 필요하다 |
| MuPDF 글자 클립(§11) | 글자 0~3으로 끝나는 블록의 클립과 Tr 7 글자. 3으로 끝나면 그 글자가 `invisible`로 간다 | 오라클 한계. 차이가 나면 먼저 이것인지 본다 |
| MuPDF는 글꼴의 폭을 정수로 읽는다 | `/Widths`, `/W`, `/DW`, `/W2`, `/DW2`는 천분율 정수로 반올림한다. Type 3 글꼴은 `/Widths`의 값에 `FontMatrix`를 곱해 천분율로 바꾼 폭의 소수점 아래를 버린다(`/Widths`의 값 자체를 내리는 것이 아니다. 0.001 행렬의 549.8과 1 행렬의 0.5498이 모두 549가 된다). pdf.js와 PDF 규격은 적힌 수 그대로다(pdf.js의 `/DW`만 올림). 글자 하나에 최대 글꼴 크기 × 0.5/1000(Type 3은 1/1000)씩 벌어지므로 한 덩어리가 길면 `glyph:x`(세로쓰기는 `glyph:y`) 차이가 난다. `skia-text.pdf`가 그렇다. Skia의 다음 `Td`가 실수 폭이 끝나는 자리에 있어서 walker가 맞고, `/W`만 정수로 고친 파일에서는 차이가 0이다. PowerPoint는 폭을 언제나 정수로 쓴다(tier A의 폭이 있는 글꼴 216개 전부) | 오라클 한계 |
| ToUnicode의 U+0000(§1) | MuPDF는 먼저 글꼴의 인코딩(글리프 이름, 코드)을 보고 그래도 없을 때만 U+FFFD를 낸다. walker는 인코딩을 볼 수 없어 언제나 U+FFFD다. 글리프 이름이나 코드에 뜻이 있으면 `glyph:u` 차이다 | 드물어서 두었다. Skia의 글리프 이름과 코드에는 뜻이 없어 차이가 없다 |
| ToUnicode에 없는 코드 | pdf.js는 코드 값을 문자로, MuPDF는 인코딩이나 U+FFFD를 준다. `glyph:u` 차이다. tier A에는 없다 | pdf.js 한계 |
| 임베드하지 않은 글꼴의 이름과 세로쓰기 문장 부호 | pdf.js가 임베드하지 않은 글꼴의 이름을 다듬고(`Arial,Bold` → `Arial-Bold`, 공백 제거), 세로 CMap이면 문장 부호를 세로 표현형으로 바꾼다(U+300C → U+FE41). `glyph:font`, `glyph:u` 차이다. PowerPoint는 글꼴을 언제나 임베드한다 | pdf.js 한계 |
| `BaseFont`와 `FontName`이 다른 글꼴 | MuPDF는 `BaseFont`(CID 글꼴은 자손의 것), pdf.js는 글꼴 설명자의 `FontName`을 쓴다. 규격상 둘은 같아야 한다. `glyph:font` 차이다. tier A에는 없다 | 드물어서 두었다 |
| ASCII가 아닌 글꼴 이름 | MuPDF는 이름의 바이트를 UTF-8로 읽고(오라클은 UTF-8이 아닌 바이트를 U+FFFD로 바꾼다), pdf.js는 바이트마다 한 글자로 읽는다. `glyph:font` 차이다. tier A의 이름은 모두 ASCII이고 가장 긴 것이 29바이트다 | 나오면 M3에서 이름을 어떻게 쓸지와 함께 본다 |
| Tr 7 뒤의 `sh` 하나(§6) | 오라클이 패턴으로 채운 글자와 구별하지 못해 `paint`가 `fill`, 알파가 그 `sh`의 값이다. `glyph:paint`, `glyph:alpha` 차이다 | 오라클 한계 |
| walker가 보지 못하는 묶음의 끝(§5) | pdf.js가 `MP`, `DP`, `cs`, `CS`, `OP`·`op`·`OPM`만 있는 `gs`를 넘기지 않아 패턴으로 칠한 글자에서 `shade`·`pattern`이 하나 적다 | pdf.js 한계 |
| `sc` 없는 `cs`, `CS` | MuPDF는 색을 그 색 공간의 처음 값으로 되돌리고(`/Pattern cs`면 다음 글자를 칠하지 않는다), pdf.js는 넘기지 않아 앞의 색이 남는다. `rgb` 차이다. PowerPoint는 언제나 함께 쓴다 | pdf.js 한계 |
| 한 묶음에 Type 3 글꼴과 다른 글꼴이 섞이고 Tr이 0이나 3이 아닐 때(§6) | MuPDF가 묶음 전체를 채우기로 칠한다. 앞 글자의 `paint`와 paint 개수가 다르다 | 드물어서 두었다 |
| 글자 블록 안의 `q`, `Q`, `cm`, 경로, `sh`, 그림, `Do` | PDF가 금지한 것이다(tier A와 Skia 표본 모두 0개). MuPDF는 쌓인 글자를 그때의 상태로 칠한다. 타일로 채운 경로나 폼 안에서 칠하면 칸의 상태로 칠해서 글자 위치까지 달라지고, 클립 방식 글자 뒤의 `cm`은 오류로 멈춘다(오라클이 그 파일을 읽지 못한다). 합성 PDF로 재 보니 `q`와 `Q`를 뺀 경우 800개 중 45개가 달랐다. 금지되지 않은 것만 쓴 PDF 4,000개에서는 위 표에 적은 경우 말고 차이가 없었다 | 규격 위반이라 두었다 |
| 같은 자리 중복 글자(§11) | 오라클 쪽 글자 수가 적다 | 오라클 한계 |
| 타일 패턴으로 채운 이미지 마스크·글자의 알파(§9, §11) | 이미지 마스크 `pattern`과 그 글자의 `alpha` 차이(알파가 1보다 작을 때) | 오라클 한계 |
| MuPDF의 선택적 내용 멤버십(§18) | MuPDF 1.28은 `/P /AllOn`인 OCMD를 숨기지 않고, `/P /AnyOff`인 OCMD를 언제나 숨기고, `/VE`를 읽지 않는다(언제나 보인다). pdf.js와 walker는 PDF 규격대로다. 숨김이 다르면 paint와 글자의 개수가 다르다(`paints:count`, `glyphs:count`). `/P /AnyOn`, `/P /AllOff`와 OCG 하나는 같다 | 오라클 한계. tier A와 다른 실험 파일에 선택적 내용이 없다 |
| 숨긴 폼의 `/OC`(§18) | MuPDF는 자기 `/OC`가 숨긴 폼을 통째로 건너뛴다. 같은 내용을 숨긴 표시 내용 안에서 그리면 Tr 3 글자와 클립 방식(4~7) 글자를 낸다. pdf.js는 폼의 `/OC`도 같은 `OC` 표시 내용으로 넘겨서 walker는 둘을 구별하지 못하고 표시 내용처럼 한다. 숨긴 폼 안의 그런 글자만 `invisible:count`, `glyphs:count` 차이다. 칠하는 것은 어느 쪽이든 없다 | pdf.js 한계(폼의 `/OC`와 숨긴 표시 내용을 하나로 넘긴다) |
| 블렌드 모드 배열(§17) | `/BM [/이름 ...]`에서 MuPDF는 첫 이름만 읽고(모르는 이름이면 normal), pdf.js는 아는 첫 이름을 쓴다. 첫 이름을 모르면 `blend` 차이다. PDF 규격은 pdf.js와 같다 | 오라클 한계 |
| `/S /Transparency`가 없는 `/Group`(§17) | pdf.js는 그런 폼도 그룹으로 넘기고(`beginGroup`), MuPDF는 그룹으로 보지 않는다. walker는 그룹 안을 알파 1에서 시작하므로 `alpha`, `groupAlpha` 차이다. 소프트 마스크 아래라면 안의 경계 있는 `sh`(§10)의 `bbox`도 다르다. PDF 규격에 그룹의 종류는 `/Transparency` 하나뿐이다 | 규격 위반이라 두었다 |
| pdf.js는 `h` 뒤의 현재 점을 옮기지 않는다(§14) | `m`이나 `re` 없이 `h` 바로 뒤에 온 `v`의 첫 제어점이 다르다(`path` 차이). MuPDF가 맞다 | pdf.js 한계 |
| MuPDF는 `re` 뒤의 현재 점을 다르게 둔다(§14) | `m` 없이 `re` 뒤에 온 `l`이 사라지거나 다른 점으로 간다(`path`, `bbox` 차이) | 오라클 한계 |
| MuPDF는 첫 제어점이 현재 점인 `v`에 곡선 하나를 더 남긴다(§14) | 선분 수가 하나 다르다(`path` 차이) | 오라클 한계 |
| 칸 경계에 정확히 놓인, 넓이 없는 타일 채우기(§9) | MuPDF가 칸을 하나도 그리지 않아 `pattern` paint가 없다. walker는 낸다(`paints` 개수 차이) | 드물어서 두었다 |
| 패턴으로 그린 선의 상자 모형(§15) | 행렬식이 0인 CTM, 0이 아닌데 아주 작은 `b`, `c`, `re` 뒤에 이어지는 선분에서 `shade`·`pattern` 상자가 다를 수 있다 | 드물어서 두었다 |
| 축·원형 그라데이션의 좌표와 색 멈춤(§16) | MuPDF의 파이썬 연결이 `fz_shade`의 `u`를 주지 않아 비교하지 못한다. 종류(`shading`)만 비교한다. 좌표가 틀려도 이 비교는 잡지 못한다 | 렌더링한 픽셀로 따로 확인한다 |
| pdf.js가 읽지 못한 그라데이션(§16) | pdf.js는 틀린 그라데이션(`/Coords`가 모자라거나 `/Function`이 없거나 `/ShadingType`을 모르는 것)을 `Dummy`로 두고도 `shade` 명령을 내서, walker의 `shade`에 `shading`이 없다. MuPDF가 그래도 그리면(축의 `/Coords`가 모자라면 빠진 값을 0으로 읽는다) `shade:shading` 차이이고, 못 그리면 `shade`의 개수가 다르다. tier A에는 없다 | pdf.js 한계 |

## 14. 경로 기하 (path geometry)

`fill`과 `stroke`는 `path`를 갖는다. 그린 경로의 선분 목록이고, 모든 점은 CTM을 곱한 슬라이드 좌표계다(§1). 숫자는 소수점 셋째 자리에서 반올림한다. 패턴으로 칠한 `shade`와 `pattern`에는 없다.

- **오라클**: `fz_path`를 `FzPathWalker2`로 걷는다. 콜백을 넷(`moveto`, `lineto`, `curveto`, `closepath`)만 켜면 MuPDF가 `re`, `v`, `y`를 이 넷으로 풀어 준다.
- **walker**: pdf.js가 `constructPath`로 주는 `DrawOPS` 버퍼를 그대로 선분으로 바꾼다(`segmentsOf`). `s`, `b`, `b*`의 닫기는 pdf.js가 버퍼에 넣어 준다. `re`도 pdf.js가 풀어 준다. 네 모서리의 순서는 MuPDF와 같다.
- **`RawOp.path`와 인벤토리의 `path`는 각 엔진이 준 그대로다.** 정리한 값이 아니다.

**둘은 그대로는 같지 않다.** MuPDF는 경로를 만들 때 정리하고(`fz_moveto`, `fz_lineto`, `fz_curveto`, `fz_closepath`), pdf.js는 정리하지 않는다. 그래서 비교하기 전에 양쪽 모두 `canonicalPath`로 같은 꼴을 만든다. 그리는 모양은 바뀌지 않는다. 규칙은 다음과 같고, 합성 PDF로 오라클과 비교해서 찾았다.

1. 첫 `moveTo` 앞의 선분, 곡선, `closePath`는 버린다. 현재 점이 없다.
2. `moveTo` 다음에 `moveTo`가 오면 앞의 것을 버린다. 끝에 남은 `moveTo`도 버린다.
3. 제어점이 아무것도 더하지 않는 곡선은 `lineTo`로 바꾼다. 네 점을 시작 p0, 제어 p1, p2, 끝 p3이라 할 때 (p0 = p1이고 p2 = p3), (p0 = p1 = p2), (p1 = p2 = p3)인 곡선이다. 그 밖의 곡선은 곡선으로 둔다. p0 = p1이나 p2 = p3 하나만 맞는 `v`, `y` 꼴도 그렇다.
4. 현재 점으로 가는 `lineTo`는 버린다. 단 `moveTo` 바로 뒤라면 남긴다. 점 하나를 찍는 경로다. `closePath` 뒤의 현재 점은 그 부분 경로의 시작점이다.
5. `closePath` 바로 뒤의 `closePath`는 버린다.
6. 너비나 높이가 0인 `re`를 한 꼴로 맞춘다. pdf.js는 `M L Z`로 쓰고 MuPDF는 모서리 넷을 모두 걷는다.
   - `moveTo` 바로 뒤의 점 찍는 `lineTo`는 다음에 선분이나 곡선이 이어지면 버린다.
   - `closePath` 바로 앞에서 부분 경로의 시작점으로 돌아가는 `lineTo`는 버린다. 단 `moveTo` 바로 뒤라면 남긴다.

이 판단은 반올림한 값의 정확한 일치로 한다. 그래서 길이가 반올림 단위쯤 되는 아주 짧은 선분은 양쪽의 반올림이 갈리면 선분 수 차이로 나올 수 있다. 실험 파일 1,324쪽에는 이런 경우가 없다.

**MuPDF와 pdf.js가 정말로 다른 경로를 내는 경우**: 개발 중에 무작위로 만든 합성 PDF 2,500개(씨앗 고정)를 오라클과 비교했다. 남은 차이는 아래 넷뿐이다. 실험 파일 1,324쪽에는 하나도 없다. 규칙으로 덮지 않고 §13에 적었다.

- `h` 바로 뒤의 `v`: pdf.js는 `h`에서 현재 점을 시작점으로 옮기지 않아서 `h` 앞의 끝점을 첫 제어점으로 쓴다. MuPDF는 시작점을 쓴다. PDF 규격대로면 MuPDF가 맞다.
- `m` 없이 `re` 뒤에 온 `l`(사이에 `h`가 있어도): MuPDF는 `re` 뒤의 현재 점을 `re`의 시작점이 아니라 앞 부분 경로의 시작점으로 둔다. 그래서 그 점으로 가는 `l`은 사라지고, x나 y가 그 점과 같은 `l`은 다른 점으로 간다. 그 점과 겹치는 제어점을 가진 `c`도 선이 된다.
- 첫 제어점이 현재 점인 `v`(`x y x y x3 y3`의 꼴): MuPDF의 `fz_curvetov`는 `lineTo`를 넣고도 곡선을 하나 더 남긴다. 끝점에서 시작해 끝점으로 돌아오는 곡선이다. 제어점이 끝점과 같은 `v`도 같은 곡선을 남기지만 이쪽은 네 점이 모두 같아서 규칙 3, 4가 지운다.
- 칸 경계에 정확히 놓인, 넓이 없는 타일 채우기: 경로가 아니라 `pattern`의 개수가 달라진다.

## 15. 선 속성 (line style)

`stroke`는 `line`을 갖는다.

- `w`, `dash`, `phase`는 **슬라이드 좌표계의 pt**다. PDF의 값에 `lineScale(ctm)` = √|ad − bc|를 곱한다. 양쪽 모두 그렇다. 축마다 배율이 다른 CTM에서 이 값은 평균이다.
- `cap`, `join`은 PDF의 번호(`J`, `j`)다. `miter`는 PDF의 값(`M`) 그대로다. 비율이라 곱하지 않는다.
- `w`가 0인 선은 `w`가 0이다. 가는 선으로 바꾸지 않는다.
- 연산자(`w`, `J`, `j`, `M`, `d`)와 `gs`(`LW`, `LC`, `LJ`, `ML`, `D`) 둘 다 같은 상태를 바꾼다. `q`/`Q`로 저장하고 되돌린다. 폼 XObject는 부른 쪽의 상태를 이어받는다.
- `J`와 `j`의 값이 0~2 밖이면 MuPDF처럼 소수를 버리고 0~2로 자른다. `gs`의 `LC`, `LJ`는 정수만 받고 다른 수는 무시한다. MuPDF에서 잰 결과다.
- 오라클의 `cap`은 `start_cap`이다. PDF에서는 `J` 하나가 `start_cap`, `dash_cap`, `end_cap`을 모두 정한다.

**패턴으로 그린 선의 상자 (`strokeBounds`)**: MuPDF는 `clip_stroke_path`로 선의 윤곽을 클립하고 그 안에 패턴을 그린다. 오라클은 이 클립의 상자를 `fz_bound_path(path, stroke, ctm)`로 얻는다. walker는 같은 값을 `strokeBounds`로 계산한다. 경로의 상자(§4)를 사방으로 같은 만큼 넓힌다.

```
넓힘 = (PDF 선 두께, 0이면 1) ÷ 2 × max(|a|, |b|, |c|, |d|)
마이터 이음(j = 0)이고 마이터 한계가 0.5보다 크고 아래의 두 예외가 아니면: 넓힘 × 2 × 마이터 한계
```

- 예외 1: 경로의 상자에 너비나 높이가 없다(단정밀도 값으로 같다).
- 예외 2: 경로가 축을 따른다(`axisAligned`). 곡선이 하나도 없고, 닫는 선분까지 모든 선분이 슬라이드 좌표계의 축 방향이다. 축 방향의 기준은 CTM에 달렸다.
  - CTM이 축을 지키면(`b`, `c`가 0이거나 `a`, `d`가 0. C의 `FLT_EPSILON`보다 작으면 0으로 본다) x나 y의 차이가 정확히 0이어야 한다.
  - 그렇지 않으면 x나 y의 차이가 0.001pt보다 작으면 된다.
- 선 끝 모양(`cap`)과 점선(`dash`)은 식에 들어가지 않는다.
- `lineScale`이 아니라 네 값 가운데 가장 큰 값이다. 45° 회전이면 0.7071이다.
- 재는 방법: `fz_bound_path`를 합성 경로마다 직접 불러서 맞췄다. `harness/oracle/test_mupdf_inventory.py`의 `test_stroke_bound_formula`가 이 표를 라이브러리에 대고 확인하므로, MuPDF를 올려서 식이 바뀌면 드러난다. `walker.contract.local.test.ts`는 `strokeBounds`를 오라클과 비교한다.
- 모형이 다른 경우: `line.w`에서 PDF 두께를 되돌리므로 행렬식이 0인 CTM에서는 두께를 0으로 본다. 0이 아니고 `FLT_EPSILON`보다 작은 `b`, `c`는 walker가 정확히 비교한다. MuPDF는 `re` 뒤에 이어지는 선분(§14)을 축 방향이 아닌 것으로 본다. 셋 다 §13에 있다.

**글자의 선**: MuPDF의 `fz_bound_text`도 같은 식으로 넓힌다. 경로와 달리 예외가 없고, 글자 상자는 어림값이다. 그래서 walker는 글자 덩어리의 어림 상자(사방 1pt 여유)에 이 식을 적용하고 `approx`를 단다(§5).

## 16. 그림과 그라데이션 (images and shadings)

`image`는 `ctm`, `px`, `stencil`을, `shade`는 `shading`을 갖는다. 오라클은 `detail`이 있을 때, walker는 언제나 쓴다. 비교는 §12에 있다.

**`ctm`**: PDF의 단위 정사각형을 슬라이드 좌표계로 옮기는 행렬이다. PDF 규격(8.9.5)대로 단위 정사각형의 원점은 그림의 왼쪽 아래 모서리이고 y축은 위로 간다. 쪽의 y축은 아래라서 똑바로 선 그림은 `d`가 음수다. 상자(§1)는 이 행렬로 옮긴 단위 정사각형의 상자다.

- walker: 그림을 칠하는 순간의 CTM 그대로다. pdf.js는 그림을 CTM 아래에서 그린다.
- 오라클: **MuPDF는 장치에 그림의 행렬을 y축을 뒤집어서 준다.** 그 단위 정사각형은 그림의 왼쪽 위 모서리에서 시작해 아래로 간다. (x, y)를 (x, 1 − y)로 옮기는 뒤집기를 PDF의 행렬 앞에 곱한 것이다. 이 뒤집기는 자기 자신의 역이라서 오라클은 `[a, b, −c, −d, c + e, d + f]`로 PDF의 행렬을 되돌린다. 뒤집기는 단위 정사각형을 그 자신으로 보내므로 상자는 어느 쪽이든 같다. 오라클 시험 `test_mupdf_hands_an_image_over_with_its_y_axis_flipped`가 MuPDF가 그렇게 준다는 것을 확인하므로, MuPDF를 올려서 달라지면 드러난다.

**`px`**: 그림의 너비와 높이(픽셀)다.

- 오라클: `fz_image`의 `w`, `h`. 그림이 소프트 마스크(`/SMask`)를 가지면 MuPDF는 마스크를 `clip_image_mask`로 보내고 그림 자신의 크기를 준다.
- walker: 그림 XObject(`paintImageXObject`)는 pdf.js가 명령에 `[객체 id, 너비, 높이]`로 주는 값이다. **그림 객체(`page.obj`)의 `width`, `height`는 쓰지 않는다.** 소프트 마스크가 그림보다 크면 pdf.js는 둘 중 큰 쪽의 크기로 객체를 만든다. 인라인 그림(`paintInlineImageXObject`)과 이미지 마스크(`paintImageMaskXObject`)는 명령이 싣는 그림 데이터의 `width`, `height`다. 칠하는 1×1 이미지 마스크(`paintSolidColorImageMask`)는 `[1, 1]`이다. 크기를 읽지 못하면 `px`를 쓰지 않는다(그러면 차이로 드러난다).

**`stencil`과 `rgb`**: 이미지 마스크(`/ImageMask true`, 인라인은 `/IM true`)를 단색으로 칠하면 `stencil`이 참이고 `rgb`는 그 채우기 색이다. 알파는 채우기 알파다. 이미지 마스크가 아닌 그림은 `stencil`이 거짓이고 `rgb`는 `null`이다. 채우기 색이 패턴이면 `image`가 아니라 `shade`나 `pattern`이다(§5, §9).

- 오라클: `fill_image_mask`의 `colorspace`, `color`를 `fill_path`와 같이 sRGB로 바꾼다.
- `detail=False`는 이 필드를 모두 빼고 이미지 마스크의 `rgb`도 전과 같이 `null`이다. `harness/fidelity`는 `image`의 종류와 상자만 읽는다.

**`shading`**: MuPDF의 종류 1은 `function`, 2는 `axial`, 3은 `radial`, 4~7(자유형, 격자, Coons 패치, 텐서 패치)은 `mesh`다.

- 오라클: `fz_shade.type`.
- walker: pdf.js의 그라데이션 중간 표현에서 읽는다. `RadialAxial`은 `axial`이나 `radial`이다. `Mesh`는 메시와 함수형을 모두 가리키고 둘째 값이 `ShadingType`이라서, 1이면 `function`이고 아니면 `mesh`다. pdf.js가 읽지 못한 그라데이션(`Dummy`)에는 `shading`이 없다(§13).
- `sh`와 그라데이션 패턴으로 칠한 경로, 선, 글자, 이미지 마스크의 `shade`가 모두 가진다. 어림 `shade`(§5)도 비교한다. 종류는 어림이 아니다.
- MuPDF의 파이썬 연결은 축과 원형의 좌표와 색 멈춤을 주지 않는다(`fz_shade`의 `u`). 그래서 이 계약은 종류까지만 비교한다(§13).

## 17. 클립 상자, 그룹, 블렌드, 마스크 (clip, groups, blend, masks)

모든 paint는 `clip`, `groupAlpha`, `blend`, `masked`를 갖고, 글자는 `groupAlpha`를 갖는다. 오라클은 `detail`이 있을 때, walker는 언제나 쓴다. 비교는 §12에 있다. 합성 PDF로 오라클과 비교해 맞췄다(`walker.contract.local.test.ts`의 "0002 §17", 오라클 쪽은 `test_mupdf_inventory.py`의 §17 시험들).

**`clip`**: paint를 칠하는 순간의 클립 상자다. §5의 클립 스택 그대로다. 클립 경로(`W`, `W*`), 글자 클립, 폼과 투명 그룹의 `/BBox`가 좁히고, `Q`와 폼·그룹의 끝이 되돌린다. 쪽 크기로 자른다.

- 소프트 마스크 영역(§10)은 넣지 않는다. 그 영역은 마스크를 받은 물체 자신의 경계이지 클립이 아니다. 오라클은 `end_mask`에서 쌓은 칸을 이 상자에 넣지 않는다.
- 그림 자신의 소프트 마스크(`/SMask`)도 넣지 않는다. MuPDF는 그 마스크를 `clip_image_mask`로 쌓은 다음 그림을 칠한다. 오라클은 `fill_image` 바로 앞의 그 칸을 뺀다.
- 패턴으로 칠한 `shade`와 `pattern`은 칠한 모양까지 든다. MuPDF는 칠할 모양(경로, 선, 글자, 이미지 마스크)을 먼저 클립으로 쌓고 그 안에 패턴을 그린다(§5, §9). 장치는 이 클립을 `q ... re W n /Sh sh Q`의 클립과 구별할 수 없다. 그래서 이런 paint의 `clip`은 `bbox`와 같다. `sh`의 `clip`은 클립 그대로이고, 소프트 마스크 아래의 경계 있는 `sh`(§10)만 `bbox`가 그보다 좁다.
- 글자 클립이 좁힌 클립은 어림값이다(§5). walker는 그 아래의 paint에 `clipApprox: true`를 단다. `shade`와 `pattern`에는 `approx`인 곳에 단다. 비교는 이런 `clip`의 꼴만 본다.
- `re W f`처럼 클립과 칠하기가 한 경로이면 칠한 다음에 클립한다. PDF 규격, MuPDF, walker 모두 그렇다.

**`groupAlpha`**: paint를 감싼 투명 그룹들의 알파를 모두 곱한 값이다. `alpha`는 paint 자신의 알파이고(§1) 둘을 곱하면 칠하는 불투명도다.

- 투명 그룹은 `/Group << /S /Transparency >>`가 있는 폼 XObject다. 그룹의 알파는 그 폼을 그리는(`Do`) 순간의 채우기 알파(`ca`)다. 그룹 안은 알파 1, 블렌드 normal, 소프트 마스크 없음에서 시작한다. 오라클은 `begin_group`의 `alpha`를, walker는 pdf.js `beginGroup` 때의 채우기 알파를 쓴다.
- MuPDF는 폼이 아닌 그룹도 연다. 타일 패턴 채우기의 알파 그룹(§9)은 그 알파가 paint 자신의 `alpha`이므로 넣지 않는다. 오라클은 모양의 클립 바로 앞에 열린 가장 안쪽 그룹을 뺀다. 그 밖의 그룹은 알파가 1이라 곱에 아무것도 하지 않는다. 투명도를 쓰는 쪽 전체를 감싸는 그룹, normal이 아닌 블렌드 모드로 칠하는 paint마다 여는 그룹, 채우기와 선을 한 명령으로 그릴 때(선 알파가 1이 아니거나 블렌드가 있을 때) 여는 knockout 그룹이 그렇다.
- 실험 파일: tier A(atlas)의 쪽에는 투명 그룹 폼이 하나도 없다(pdf.js의 `beginGroup`은 소프트 마스크의 것 넷뿐이다). 그래서 1이 아닌 그룹 알파도, normal이 아닌 블렌드 모드도 없다. Skia 표본(`skia-transparency.pdf`)에는 그룹 알파 0.4~0.7과 그 곱(0.42)이 있고, 블렌드 모드 아홉 가지가 그룹에 걸려 있다.

**`blend`**: 블렌드 모드다. PDF 이름을 소문자로, 하이픈 없이 쓴다. `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `colordodge`, `colorburn`, `hardlight`, `softlight`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`의 열여섯 가지다. `Compatible`은 `normal`이다.

- paint에서 바깥으로 가며 처음 만나는 `normal`이 아닌 모드다. paint 자신의 모드(`gs`의 `/BM`)를 먼저 보고, 다음에 가장 안쪽 그룹부터 바깥으로 본다. 그룹의 모드는 그 폼을 그리는 순간의 모드다.
- 오라클: MuPDF는 `normal`이 아닌 모드로 칠하는 paint마다 알파 1의 그룹을 그 모드로 열어 준다. 그래서 열린 그룹의 모드를 안쪽부터 보면 된다(`fz_blendmode_name`).
- walker: pdf.js는 모드를 캔버스의 합성 연산 이름(`source-over`, `multiply`, `color-dodge`, ...)으로 넘긴다. walker는 PDF 이름으로 바꿔 상태에 두고, 그룹마다 그 순간의 모드를 적는다. 인벤토리를 만들 때 위의 규칙으로 하나를 고른다. RawOp에는 paint 자신의 모드와 그룹들의 모드가 따로 남는다. 장면(Scene)이 둘을 따로 쓰기 때문이다. 인벤토리로는 둘을 구별할 수 없어서, 그룹 안에서 모드가 normal로 돌아가는지는 RawOp를 보는 시험이 따로 확인한다.
- 글자는 `blend`를 갖지 않는다.

**`masked`**: paint 위에 소프트 마스크가 있다.

- paint 자신의 마스크(`gs`의 `/SMask`가 켜고 `/SMask /None`과 `Q`가 끈다. §10)와 paint를 감싼 투명 그룹이 가져간 마스크를 모두 센다. 그룹이 가져간 마스크는 그룹을 합성할 때 걸리므로 그 안의 모든 paint 위에 있다. 그룹 안에서 `/SMask /None`을 해도 그룹의 마스크는 그대로다.
- 그림이 자기 `/SMask`를 가지면 그것이 `gs`의 마스크를 대신한다(PDF 규격). MuPDF는 그 그림에 `gs`의 마스크를 걸지 않고, pdf.js는 그 그림 앞에 `/SMask /None`을 넣어 준다. 그래서 그런 그림은 감싼 그룹이 마스크를 가져가지 않았으면 `masked`가 거짓이다.
- 오라클: 클립 스택에 `end_mask`가 쌓은 칸이 하나라도 있으면 참이다. walker: 상태의 마스크가 그룹의 것이 아니거나(`masked && !maskInGroup`, §10) 감싼 그룹 가운데 하나가 마스크를 가져갔으면 참이다.
- 실험 파일: tier A의 소프트 마스크는 한 쪽의 `shade` 넷에만 걸려 있다(PDF/A 변형에는 없다). Skia 표본에는 마스크가 `fill`과 `shade` 32개에 걸려 있다. 클립은 `atlas_std.pdf`에서 33쪽의 paint 307개가 쪽보다 좁다.

## 18. 선택적 내용 (optional content)

**숨긴 선택적 내용은 칠하지 않는다.** 숨김은 문서의 기본 설정(`/OCProperties /D`의 `/ON`, `/OFF`, `/BaseState`와 `/Usage /View /ViewState`)이 정한다. walker는 pdf.js가 화면에 그리는 판단(`getOptionalContentConfig({ intent: 'display' }).isVisible`)을 쓰고, pdf.js를 부르는 일은 어댑터의 `PageData.isOcVisible`이 한다. 오라클은 MuPDF가 스스로 숨긴 것을 그대로 쓴다.

- 숨기는 자리: 표시 내용 `/OC ... BDC` .. `EMC`(OCG 하나나 멤버십 OCMD), 그리고 자기 `/OC`를 가진 폼 XObject. pdf.js는 폼의 `/OC`도 폼 둘레의 `OC` 표시 내용으로 넘긴다. 숨긴 내용 안의 숨기지 않은 내용도 숨는다.
- 숨긴 내용 안에는 paint가 하나도 없다. 그라데이션 패턴이나 타일 패턴으로 칠한 글자의 `shade`·`pattern`도 없다.
- 상태는 그대로 쌓인다. `q`/`Q`, `cm`, 색, 선 상태, `gs`(소프트 마스크 포함), 클립 경로가 모두 그렇고, 숨긴 내용이 끝난 뒤에도 남는다. 글자의 위치도 진행한다.
- 글자: MuPDF는 숨긴 글자 가운데 Tr 3 글자를 `ignore_text`로, 클립 방식(4~7) 글자를 `clip_text`로 보낸다. walker도 같게 한다. Tr 0~2 글자는 없다. Tr 3 글자는 보이지 않는 글자(`invisible`)다. Tr 4~7 글자는 클립을 좁히고 `ET`에서 `paint`가 `clip`인 글자가 된다(§6의 Tr 7과 같다). Type 3 글꼴은 §6대로 Tr 3과 7만 보이지 않는 글자이고 나머지는 없다. pdf.js의 캔버스는 숨긴 글자로 클립을 만들지 않지만, walker는 MuPDF를 따른다.
- 다른 점 둘은 §13에 있다. MuPDF 1.28은 멤버십의 `/P /AllOn`, `/P /AnyOff`, `/VE`를 PDF 규격과 다르게 판단한다. MuPDF는 자기 `/OC`가 숨긴 폼을 통째로 건너뛰지만 walker는 그것을 숨긴 표시 내용과 구별하지 못한다.
- 측정: 커밋한 PDF(`corpus/generated` 4개)와 관문 세트(`out/atlas` 18개, `out/atlas-win` 2개), 그리고 `out/producers` 6개 모두 선택적 내용이 없다(`/OCProperties`, OCG, OCMD, `/OC` 0개). 오라클은 선택적 내용을 MuPDF에 맡기고 바꾼 것이 없으므로, `detail=False`로 읽는 `harness/fidelity`의 결과도 그대로다.
- 합성 PDF로 오라클과 비교해 맞췄다(`walker.contract.local.test.ts`의 "optional content: hidden OCG, visible OCG, OCMD, form with /OC").

## 19. 장면이 돌려주는 인벤토리 (Scene inventory)

장면(Scene)도 이 계약으로 오라클과 비교한다. `inventoryOfSlide`(`packages/core/src/scene/inventory.ts`)가 슬라이드와 덱의 글꼴(`SceneDeck.fonts`)**만으로** 인벤토리를 다시 만들고, `compareInventories`가 오라클의 인벤토리와 비교한다(§12의 규칙과 허용 오차 그대로). 장면 래칫(`npm run test:corpus`)과 전수 조사의 `scene.ok`(`npm run oracle:sweep`)가 이 비교다. 같으면 장면이 walker가 찾은 것을 잃지 않았다는 뜻이다.

- 도형은 채우기의 paint 다음에 선의 paint를 낸다(`B`처럼). 단색이면 `fill`, `stroke`(경로, 선 속성과 함께), 그라데이션이나 다른 셰이딩이면 `shade`, 타일 패턴이면 `pattern`이다. 그림은 `image`, 글줄은 글자를, 보이지 않는 글자는 `invisible`을 낸다.
- 슬라이드 자신의 요소만 센다. 소프트 마스크와 타일 칸의 요소는 마스크·패턴 데이터다(§9). 대체 요소(fallback)는 paint를 내지 않는다(판정 M2-R17).
- **그라데이션이나 타일 패턴으로 칠한 글자의 `shade`와 `pattern`은 내지 않는다**(판정 M2-R26). 글자 자체(§6)는 낸다.
  - 장면은 채우기의 패턴을 그 글자 덩어리의 `TextRun.fill`에 둔다. 선의 패턴은 두지 않는다(`TextRun.stroke`는 단색일 때만 있다).
  - walker는 채우기의 paint를 덩어리마다가 아니라 글자 묶음(§5)마다 하나씩, 묶음이 끝날 때 낸다. 선도 그라데이션이나 패턴이면 묶음마다 선의 것이 하나 더 나온다(채우기, 선 순서). 묶음을 끝내는 것(같은 색을 다시 고르는 `scn`, 선 상태, 표시 내용, `ET` 등)은 장면에 남지 않는다. 그래서 장면만으로는 이 paint가 몇 개이고 칠한 순서의 어디에 오는지 정확히 알 수 없다. 예: `skia-gradients.pdf`에서 그라데이션이나 타일로 채운 덩어리 10개가 묶음 5개(`shade` 3, `pattern` 2)다.
  - **선을 그라데이션이나 패턴으로 그린 글자**: walker는 위와 같이 선의 `shade`나 `pattern`을 낸다(언제나 `approx`). 장면은 선의 패턴을 두지 않으므로(`TextRun.stroke`가 `null`이다) 장면의 인벤토리에는 이 paint가 없다. 대신 그런 글줄마다 슬라이드에 고정 문구의 메모 `text stroked with a pattern`이 남는다. 그래서 관문 세트의 쪽이라면 전수 조사 관문의 "메모 0개" 규칙(`gateProblems`, 판정 M2-R17)이 이것을 잡는다. 측정한 모든 세트에 이런 글자는 없다.
  - 그래서 이런 글자가 있는 쪽은 장면의 비교에서 그만큼 paint가 모자란다. `paints:count`, `paints:order` 차이와, 그 뒤로 짝이 밀린 `shade`·`pattern`의 값 차이가 나고 `scene.ok`가 거짓이다. walker의 비교에서는 이 paint가 `approx`라 종류와 자리만 본다(§12).
  - 측정(2026-11-10): 관문 세트(`atlas` 1,004쪽, `atlas-win` 320쪽)에는 이런 글자가 없다(`approx` paint 0개). Skia 표본에서는 `skia-gradients.pdf`에 5개(`shade` 3, `pattern` 2), `skia-patterns.pdf`에 4개(`pattern` 4)가 모자라서 이 두 쪽이 `scene.ok`가 아니다. 관문 세트에 이런 글자가 생기면 장면 비교에서 바로 드러난다.
