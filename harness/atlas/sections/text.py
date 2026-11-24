"""Atlas section `text`: the four font roles at 8-54 pt and the weight roles; bold, italic, every underline type,
strike, superscript and subscript; character spacing -1/0/3/6 pt and kerning; caps; colours, highlight, hyperlinks,
gradient and outline-only text; alignment; vertical (eaVert, vert, vert270, wordArtVert) and rotated text;
normAutofit, columns; bullets, numbering and indent levels 0-4; line and paragraph spacing; anchors, insets, wrapping,
line breaks and tabs; mixed scripts, symbols, extreme sizes, text in shapes and text effects.

Every run names its font for latin, ea and cs, and uses only characters its OFL family has (checked by the tests):
NanumGothic lacks the check mark and circled digits, Gowun Batang the check mark, Pretendard the archaic jamo, and
none of the families has Hanja, so the symbol lines below use only characters all seven families share. All of them
are static TrueType, which PowerPoint embeds in a PDF (the one CFF sample is the `fonts` section). The
`--fonts windows` build adds one emoji slide (Segoe UI Emoji); the OFL lock has no emoji font, so `--fonts ofl` lists
emoji as excluded."""

from harness.atlas import drawingml as dml

SECTION = "text"
ROLES4 = ("HEAD", "BODY", "SERIF", "ALT")
SIZES = (8, 12, 18, 24, 36, 54)
KO = "다람쥐 헌 쳇바퀴에 타고파"
SAMPLE = "가나다 한글 Hangul 0123"
LATIN = "The quick brown fox jumps over the lazy dog"
PARA_KO = (
    "디지털 문서 변환은 글자와 도형, 표와 그림을 원래 모습 그대로 옮기는 일이다. 줄 바꿈과 자간, 정렬이 조금만 "
    "달라져도 결과물은 쉽게 어긋나므로 기준이 되는 원본이 꼭 필요하다."
)
PARA_EN = (
    "Converting a document means carrying every letter, shape, table and picture across unchanged. A small change in "
    "line breaks, letter spacing or alignment is enough to make the result drift from its source."
)
SYMBOLS = (
    "₩ € £ ¥ ¢ © ® ™ ° ± × ÷ √ ∞ ≈ ≠ ≤ ≥ % ‰",
    "「 」 『 』 《 》 〈 〉 “ ” ‘ ’ « » ‹ › § ¶ † ‡",
    "• – — … · ※ ■ □ ◆ ◇ ○ ● ▶ ▷ ◁ ▲ △ ▼ ▽ ★ ☆ ♥ ♪",
    "→ ← ↑ ↓ ⇒ ㄱ ㄴ ㄷ ㅏ ㅑ ¹ ² ³ ½ ¼ ～ ~ ^ | \\",
)
BULLETS = ("•", "–", "■", "◆", "○", "▶", "※", "→", "★")
INK = "262626"
FRAME = dml.ln(0.75, color="A6A6A6")  # outline of boxes whose edges matter (wrapping, autofit, anchors, columns)
LINK = "https://example.com/deckback/atlas"
EMOJI_FONT = "Segoe UI Emoji"  # --fonts windows only


def _faces(deck, *roles):
    return list(dict.fromkeys(f"typeface:{deck.font(role).family}" for role in roles))


def _line_height(size):
    return size * 1.5


def _stack(deck, slide, rows, *, x=24, y=None, w=None, gap=6, name="Line"):
    """One unwrapped text box per row, top to bottom; rows = [(paragraph XML or [XML, ...], height pt)]."""
    y = deck.content[1] if y is None else y
    w = deck.width - x - 24 if w is None else w
    body = dml.body_pr(wrap=False, anchor="t", insets=(0, 0, 0, 0))
    for i, (paragraphs, height) in enumerate(rows):
        paragraphs = [paragraphs] if isinstance(paragraphs, str) else paragraphs
        deck.textbox(slide.shapes, x, y, w, height, paragraphs, name=f"{name} {i + 1}", body=body)
        y += height + gap
    return y


def _framed(deck, slide, x, y, w, h, paragraphs, *, name, body=None):
    """A text box with a visible grey outline, so its edges are measurable in a render."""
    sppr = dml.sp_pr(x, y, w, h, fill=dml.no_fill(), line=FRAME)
    return dml.add_sp(slide.shapes, sppr, name=name, textbox=True, txbody=dml.tx_body(paragraphs, body=body))


def _cells(deck, cols, rows, caption_h=16):
    """Grid cells with room for a caption line at the top: [(x, y, w, h, caption y), ...]."""
    return [(x + 6, y + caption_h, w - 12, h - caption_h - 8, y) for x, y, w, h in deck.grid(cols, rows)]


# --- fonts and sizes ------------------------------------------------------------------------------------------------


def _role_sizes(deck):
    for role in ROLES4:
        family = deck.font(role).family
        slide = deck.slide(SECTION, [f"typeface:{family}"] + [f"fontSize:{s}" for s in SIZES],
                           smoke=role in ("HEAD", "BODY"), title=f"글꼴 역할 {role}: {family} 8–54 pt")
        y = deck.content[1]
        for size in SIZES:
            height = _line_height(size)
            deck.caption(slide.shapes, 24, y + (height - 14) / 2, 50, f"{size} pt", align="r")
            body = dml.body_pr(wrap=False, anchor="ctr", insets=(0, 0, 0, 0))
            deck.textbox(slide.shapes, 84, y, deck.width - 108, height, [deck.para(SAMPLE, role, size, color=INK)],
                         name=f"{role} {size} pt", body=body)
            y += height + 8


WEIGHTS = (("HEAD", False), ("HEAD", True), ("BODY_LIGHT", False), ("BODY", False), ("BODY", True),
           ("BODY_BLACK", False), ("SERIF", False), ("SERIF", True), ("ALT", False), ("ALT", True),
           ("ALT_XBOLD", False))


def _weights(deck):
    # smoke (M1-R31): the one slide that uses every role face, so the published smoke deck embeds every lock TrueType
    # font (Pretendard Light/Black, NanumGothic and ExtraBold, Gowun Batang Bold, ...)
    slide = deck.slide(SECTION, _faces(deck, *dict.fromkeys(r for r, _ in WEIGHTS)) + ["rPr:b"], smoke=True,
                       title="굵기 역할 (Light, Regular, Bold, Black, ExtraBold)")
    rows = []
    for role, bold in WEIGHTS:
        label = f"{deck.font(role).family}{' Bold' if bold else ''}"
        rows.append((deck.para(f"{label} — {KO} 123", role, 20, bold=bold, color=INK), 30))
    _stack(deck, slide, rows, gap=4, name="Weight")


# --- run properties -------------------------------------------------------------------------------------------------


def _styles(deck):
    slide = deck.slide(SECTION, ["rPr:b", "rPr:i", "rPr:b+i", "u:sng", "strike:sngStrike", "strike:dblStrike",
                                 "baseline:super", "baseline:sub"], smoke=True, title="굵게, 기울임, 밑줄, 취소선, 첨자")
    size = 24
    rows = [
        deck.para("굵게 Bold 다람쥐 123", "BODY", size, bold=True),
        deck.para("기울임 Italic 다람쥐 123", "BODY", size, italic=True),
        deck.para("굵게 기울임 Bold Italic 다람쥐", "BODY", size, bold=True, italic=True),
        deck.para("밑줄 Underline 다람쥐 123", "BODY", size, underline="sng"),
        deck.para("취소선 Strikethrough 다람쥐", "BODY", size, strike="sngStrike"),
        deck.para("이중 취소선 Double strikethrough", "BODY", size, strike="dblStrike"),
        deck.rich([("위 첨자 Superscript: E = mc", "BODY", size), ("2", "BODY", size, {"baseline": 30})]),
        deck.rich([("아래 첨자 Subscript: H", "BODY", size), ("2", "BODY", size, {"baseline": -25}),
                   ("O", "BODY", size)]),
    ]
    _stack(deck, slide, [(row, _line_height(size)) for row in rows], name="Style")


def _underlines(deck):
    kinds = [u for u in dml.UNDERLINE_TYPES if u != "none"]
    slide = deck.slide(SECTION, [f"u:{u}" for u in kinds], title=f"밑줄 종류 {len(kinds)}가지")
    half = -(-len(kinds) // 2)
    for column, chunk in enumerate((kinds[:half], kinds[half:])):
        rows = [(deck.para(f"{u}: 밑줄 Underline 123", "BODY", 20, underline=u, color=INK), 30) for u in chunk]
        _stack(deck, slide, rows, x=24 + column * 456, w=432, gap=8, name=f"Underline {column + 1}")


def _baselines(deck):
    slide = deck.slide(SECTION, ["baseline:super", "baseline:sub"] + _faces(deck, *ROLES4),
                       title="위 첨자와 아래 첨자 (네 가지 글꼴)")
    sup, sub = {"baseline": 30}, {"baseline": -25}
    rows = [
        deck.rich([("면적 10 m", "BODY", 24), ("2", "BODY", 24, sup), (" · 부피 5 cm", "BODY", 24),
                   ("3", "BODY", 24, sup)]),
        deck.rich([("CO", "SERIF", 24), ("2", "SERIF", 24, sub), (" 배출량과 H", "SERIF", 24),
                   ("2", "SERIF", 24, sub), ("O 사용량", "SERIF", 24)]),
        deck.rich([("각주", "ALT", 24), ("1)", "ALT", 24, sup), (" 참고 문헌", "ALT", 24), ("[2]", "ALT", 24, sup)]),
        deck.rich([("x", "HEAD", 28), ("n", "HEAD", 28, sub), (" + y", "HEAD", 28), ("2", "HEAD", 28, sup),
                   (" = z", "HEAD", 28), ("n+1", "HEAD", 28, sup)]),
        deck.rich([("기준선 baseline ", "BODY", 24), ("+50%", "BODY", 24, {"baseline": 50}), (" 0 ", "BODY", 24),
                   ("-50%", "BODY", 24, {"baseline": -50})]),
    ]
    _stack(deck, slide, [(row, 48) for row in rows], gap=10, name="Baseline")


def _styles_in_roles(deck):
    styles = (("굵게", {"bold": True}), ("기울임", {"italic": True}), ("밑줄", {"underline": "sng"}),
              ("취소선", {"strike": "sngStrike"}), ("모두", {"bold": True, "italic": True, "underline": "sng"}))
    slide = deck.slide(SECTION, _faces(deck, *ROLES4) + ["rPr:b", "rPr:i", "rPr:b+i", "u:sng", "strike:sngStrike"],
                       title="글꼴 역할별 굵게·기울임·밑줄·취소선")
    cells = deck.grid(len(styles), len(ROLES4))
    for row, role in enumerate(ROLES4):
        for col, (label, kwargs) in enumerate(styles):
            x, y, w, h = cells[row * len(styles) + col]
            deck.text(slide.shapes, x, y + 8, w, h - 30, "가나 Ab", role, 28, name=f"{role} {label}", align="ctr",
                      anchor="ctr", wrap=False, color=INK, **kwargs)
            deck.caption(slide.shapes, x, y + h - 22, w, f"{role} {label}")


def _spacing(deck):
    values = (-1, 0, 3, 6)
    slide = deck.slide(SECTION, [f"spc:{v}" for v in values], smoke=True, title="자간 -1 / 0 / 3 / 6 pt")
    rows = []
    for value in values:
        rows.append((deck.para(f"자간 {value:+d} pt  {KO}", "BODY", 24, spc=value, color=INK), 36))
        rows.append((deck.para(f"spc {value:+d} pt  {LATIN}", "BODY", 18, spc=value, color=INK), 28))
    _stack(deck, slide, rows, gap=8, name="Spacing")


def _spacing_large(deck):
    slide = deck.slide(SECTION, ["spc:-1", "spc:3", "spc:6", "kern"] + _faces(deck, "HEAD", "SERIF"),
                       title="큰 글자의 자간과 커닝")
    rows = [(deck.para(f"자간 AVATAR {v:+d}", "HEAD", 40, spc=v, color=INK), 60) for v in (-1, 3, 6)]
    rows += [
        (deck.para("WAVE Tower AV 커닝 없음 (no kerning)", "SERIF", 32, color=INK), 50),
        (deck.para("WAVE Tower AV 커닝 12 pt 이상 (kern)", "SERIF", 32, kern=12, color=INK), 50),
    ]
    _stack(deck, slide, rows, gap=12, name="Large spacing")


def _caps(deck):
    slide = deck.slide(SECTION, ["cap:all", "cap:small"] + _faces(deck, "BODY", "SERIF"), title="대문자, 작은 대문자")
    rows = []
    for role in ("BODY", "SERIF"):
        rows.append((deck.para("보통 Normal Text: Hello World 안녕하세요", role, 24, color=INK), 36))
        rows.append((deck.para("cap=all: Hello World 안녕하세요", role, 24, cap="all", color=INK), 36))
        rows.append((deck.para("cap=small: Small Caps Text 안녕", role, 24, cap="small", color=INK), 36))
    _stack(deck, slide, rows, gap=12, name="Caps")


SRGB_TEXT = ("C00000", "FF0000", "FFC000", "92D050", "00B050", "00B0F0", "0070C0", "002060", "7030A0", "808080")


def _colours(deck):
    slide = deck.slide(SECTION, ["text:solidFill:srgb", "text:solidFill:scheme", "color:lumMod"],
                       title="글자 색 (RGB, 테마 색)")
    samples = [(f"글자색 {c}", {"color": c}) for c in SRGB_TEXT]
    samples += [(f"테마 {a}", {"color": a}) for a in ("accent1", "accent2", "accent3", "accent4", "accent5",
                                                       "accent6")]
    samples += [("accent1 lumMod 50", {"fill": dml.solid_fill("accent1", lum_mod=50)}),
                ("accent2 lumMod 60 lumOff 40", {"fill": dml.solid_fill("accent2", lum_mod=60, lum_off=40)})]
    for (x, y, w, h), (label, kwargs) in zip(deck.grid(3, 6), samples):
        deck.text(slide.shapes, x, y, w, h, label, "BODY", 18, name=f"Colour {label}", anchor="ctr", wrap=False,
                  bold=True, **kwargs)


def _highlight_and_links(deck):
    slide = deck.slide(SECTION, ["highlight", "hlinkClick", "u:sng"] + _faces(deck, "BODY", "SERIF", "ALT"),
                       title="형광펜과 하이퍼링크")
    rid = dml.hyperlink_rid(slide, LINK)
    rid_root = dml.hyperlink_rid(slide, "https://example.com/")
    size = 24
    rows = [
        deck.rich([("형광펜 ", "BODY", size), ("노란색 highlight", "BODY", size, {"highlight": "FFFF00"}),
                   (" 보통 ", "BODY", size), ("초록색", "BODY", size, {"highlight": "00FF00"}), (" ", "BODY", size),
                   ("하늘색", "BODY", size, {"highlight": "00FFFF"})]),
        deck.rich([("세리프 ", "SERIF", size), ("분홍 형광펜", "SERIF", size, {"highlight": "FF99CC"}),
                   (" 나눔 ", "ALT", size), ("회색 형광펜", "ALT", size, {"highlight": "D9D9D9"})]),
        deck.rich([("하이퍼링크: ", "BODY", size), ("deckback 기능 지도 예시", "BODY", size, {"hlink_rid": rid})]),
        deck.rich([("Hyperlink: ", "BODY", size), ("example.com", "BODY", size,
                                                   {"hlink_rid": rid_root, "underline": "sng"})]),
        deck.rich([("세리프 링크 ", "SERIF", size), ("문서 원본 보기", "SERIF", size, {"hlink_rid": rid})]),
        deck.rich([("링크와 형광펜 ", "ALT", size), ("함께 쓰기", "ALT", size, {"hlink_rid": rid,
                                                                              "highlight": "FFFF00"})]),
    ]
    _stack(deck, slide, [(row, 40) for row in rows], gap=14, name="Highlight and link")


def _gradient_text(deck):
    slide = deck.slide(SECTION, ["text:gradFill"] + _faces(deck, "HEAD"), title="그라데이션 글자")
    fills = (
        ("lin 0°", dml.grad_fill([(0, "0070C0"), (100, "00B0F0")], angle=0)),
        ("lin 90°", dml.grad_fill([(0, "FFC000"), (100, "C00000")], angle=90)),
        ("다중 정지점", dml.grad_fill([(0, "FF0000"), (25, "FFC000"), (50, "00B050"), (75, "0070C0"),
                                            (100, "7030A0")], angle=0)),
        ("path circle", dml.grad_fill([(0, "FFFFFF"), (100, "1F3864")], path="circle")),
    )
    rows = [(deck.para(f"그라데이션 Gradient {label}", "HEAD", 44, fill=fill), 70) for label, fill in fills]
    _stack(deck, slide, rows, gap=24, name="Gradient text")


def _outline_text(deck):
    slide = deck.slide(SECTION, ["text:noFill", "text:ln", "text:outline-only", "text:gradFill"]
                       + _faces(deck, "HEAD"), title="윤곽선 글자")
    samples = (
        ("윤곽선만 1 pt Outline", {"fill": dml.no_fill(), "line": dml.ln(1, color="2F5597")}),
        ("윤곽선만 2.25 pt Outline", {"fill": dml.no_fill(), "line": dml.ln(2.25, color="C00000")}),
        ("채우기 + 윤곽선 Fill+Line", {"fill": dml.solid_fill("FFC000"), "line": dml.ln(1.5, color="000000")}),
        ("점선 윤곽선 Dashed", {"fill": dml.no_fill(), "line": dml.ln(1.5, color="7030A0", dash="dash")}),
        ("그라데이션 + 윤곽선", {"fill": dml.grad_fill([(0, "00B0F0"), (100, "002060")], angle=90),
                              "line": dml.ln(0.75, color="000000")}),
    )
    rows = [(deck.para(text, "HEAD", 44, **kwargs), 64) for text, kwargs in samples]
    _stack(deck, slide, rows, gap=12, name="Outline text")


# --- paragraphs: alignment, direction, rotation ---------------------------------------------------------------------


def _alignment(deck, *, english=False):
    if english:
        aligns, role, text, title = ("l", "ctr", "r", "just"), "SERIF", PARA_EN, "문단 정렬 (영문, 세리프)"
    else:
        aligns, role, text, title = ("l", "ctr", "r", "just", "dist"), "BODY", PARA_KO, "문단 정렬 (한글)"
    slide = deck.slide(SECTION, [f"algn:{a}" for a in aligns] + _faces(deck, role), smoke=not english, title=title)
    for (x, y, w, h, cap_y), align in zip(_cells(deck, 3, 2), aligns):
        deck.caption(slide.shapes, x, cap_y, w, f"algn={align}")
        body = dml.body_pr(wrap=True, anchor="t")
        _framed(deck, slide, x, y, w, h, [deck.para(text, role, 15, ppr=dml.p_pr(align=align), color=INK)],
                name=f"Align {align}", body=body)
    if english:  # a right-aligned column of numbers
        x, y, w, h, cap_y = _cells(deck, 3, 2)[5]
        deck.caption(slide.shapes, x, cap_y, w, "algn=r (numbers)")
        numbers = ("1,234,567", "89,012", "3,456.78", "-12.5%", "₩ 1,000")
        _framed(deck, slide, x, y, w, h, [deck.para(n, "BODY", 18, ppr=dml.p_pr(align="r"), color=INK)
                                          for n in numbers], name="Align numbers", body=dml.body_pr())


def _vertical(deck):
    kinds = ("vert", "vert270", "eaVert", "wordArtVert")
    slide = deck.slide(SECTION, [f"vert:{v}" for v in kinds], smoke=True, title="세로 쓰기 (vert, vert270, eaVert)")
    x0, y0, w0, h0 = deck.content
    for i, vert in enumerate(kinds):
        x = x0 + 20 + i * (w0 / len(kinds))
        deck.caption(slide.shapes, x, y0, 150, f"vert={vert}", align="l")
        body = dml.body_pr(wrap=True, anchor="t", vert=vert)
        paragraphs = [deck.para("세로 쓰기 한글 문장", "BODY", 20, color=INK),
                      deck.para("가나다라 123", "BODY", 20, color="2F5597")]
        if vert == "wordArtVert":
            paragraphs = [deck.para("세로쓰기", "HEAD", 24, color=INK)]
        _framed(deck, slide, x, y0 + 20, 150, h0 - 24, paragraphs, name=f"Vertical {vert}", body=body)


def _vertical_mixed(deck):
    slide = deck.slide(SECTION, ["vert:eaVert", "vert:vert270", "vert:vert", "txBody:in-shape"]
                       + _faces(deck, "BODY", "SERIF", "HEAD"), title="세로 쓰기: 한글, 영문, 숫자 섞기")
    x0, y0, _, h0 = deck.content
    samples = (
        ("eaVert", "BODY", ["2026년 11월 PDF 변환 Test 123", "두 번째 문단입니다"]),
        ("eaVert", "HEAD", ["제목 세로 Title"]),
        ("vert270", "SERIF", ["아래에서 위로 읽는 글자 Bottom to top", "둘째 줄"]),
        ("vert", "BODY", ["위에서 아래로 Top to bottom 2026"]),
    )
    for i, (vert, role, texts) in enumerate(samples):
        x = x0 + 10 + i * 228
        body = dml.body_pr(wrap=True, anchor="ctr", vert=vert)
        sppr = dml.sp_pr(x, y0 + 20, 190, h0 - 24, prst="roundRect", fill=dml.solid_fill("DEEBF7"), line=FRAME)
        dml.add_sp(slide.shapes, sppr, name=f"Vertical {vert} {role}",
                   txbody=dml.tx_body([deck.para(t, role, 20, color=INK, ppr=dml.p_pr(align="ctr")) for t in texts],
                                      body=body))
        deck.caption(slide.shapes, x, y0, 190, f"vert={vert} ({role})", align="l")


ANGLES = (15, 30, 45, 90, 135, 270)


def _rotated_boxes(deck):
    slide = deck.slide(SECTION, [f"textbox:rot:{a}" for a in ANGLES],
                       title="회전한 글상자 15 / 30 / 45 / 90 / 135 / 270°")
    for (x, y, w, h), angle in zip(deck.grid(3, 2), ANGLES):
        bw, bh = 180, 36
        sppr = dml.sp_pr(x + (w - bw) / 2, y + (h - bh) / 2 - 8, bw, bh, fill=dml.no_fill(), line=FRAME, rot=angle)
        body = dml.body_pr(wrap=False, anchor="ctr")
        dml.add_sp(slide.shapes, sppr, name=f"Rotated text {angle}", textbox=True,
                   txbody=dml.tx_body([deck.para(f"회전 {angle}° 글자 Text", "BODY", 18, align="ctr", color=INK)],
                                      body=body))
        deck.caption(slide.shapes, x, y + h - 20, w, f"rot={angle}")


def _rotated_body(deck):
    slide = deck.slide(SECTION, [f"bodyPr:rot:{a}" for a in ANGLES] + ["txBody:in-shape"],
                       title="도형 안 글자만 회전 (bodyPr rot)")
    for (x, y, w, h), angle in zip(deck.grid(3, 2), ANGLES):
        body = dml.body_pr(wrap=False, anchor="ctr", rot=angle)
        sppr = dml.sp_pr(x + (w - 170) / 2, y + (h - 110) / 2 - 8, 170, 110, prst="roundRect",
                         fill=dml.solid_fill("FFF2CC"), line=FRAME)
        dml.add_sp(slide.shapes, sppr, name=f"Body rotation {angle}",
                   txbody=dml.tx_body([deck.para(f"본문 회전 {angle}°", "BODY", 18, align="ctr", color=INK)],
                                      body=body))
        deck.caption(slide.shapes, x, y + h - 20, w, f"bodyPr rot={angle}")


# --- text bodies: fitting, columns ----------------------------------------------------------------------------------


def _autofit(deck):
    slide = deck.slide(SECTION, ["normAutofit:70", "noAutofit", "spAutoFit"], title="자동 맞춤 (normAutofit 70%)")
    cells = _cells(deck, 3, 1, caption_h=20)
    long_text = [deck.para(PARA_KO, "BODY", 18, color=INK), deck.para(PARA_KO, "BODY", 18, color=INK)]
    samples = (
        ("normAutofit fontScale=70%", dml.body_pr(autofit="norm", font_scale=70, ln_spc_reduction=20), long_text),
        ("noAutofit (넘침 overflow)", dml.body_pr(autofit="none"), long_text),
        ("spAutoFit (상자 맞춤)", dml.body_pr(autofit="sp"), [deck.para(PARA_KO, "BODY", 18, color=INK)]),
    )
    for (x, y, w, _, cap_y), (label, body, paragraphs) in zip(cells, samples):
        deck.caption(slide.shapes, x, cap_y, w, label)
        height = 190 if label.startswith("spAutoFit") else 200
        _framed(deck, slide, x, y, w, height, paragraphs, name=f"Autofit {label}", body=body)


def _columns(deck):
    slide = deck.slide(SECTION, ["numCol:2", "numCol:3"] + _faces(deck, "BODY", "SERIF"), smoke=True,
                       title="단 나누기 (2단, 3단)")
    x, y, w, _ = deck.content
    deck.caption(slide.shapes, x, y, 200, "numCol=2, spcCol=24 pt", align="l")
    _framed(deck, slide, x, y + 18, w, 190, [deck.para(PARA_KO, "BODY", 14, color=INK) for _ in range(3)],
            name="Two columns", body=dml.body_pr(num_col=2, spc_col=24))
    deck.caption(slide.shapes, x, y + 222, 200, "numCol=3, spcCol=18 pt", align="l")
    _framed(deck, slide, x, y + 240, w, 200, [deck.para(PARA_EN, "SERIF", 12, color=INK) for _ in range(3)],
            name="Three columns", body=dml.body_pr(num_col=3, spc_col=18))


# --- bullets, numbering, indents ------------------------------------------------------------------------------------


def _bullets(deck):
    slide = deck.slide(SECTION, ["buChar", "buClr", "buSzPct", "marL+indent"], smoke=True, title="글머리 기호")
    paragraphs = []
    for i, char in enumerate(BULLETS):
        extra = {}
        if i % 3 == 1:
            extra = {"bu_color": "C00000"}
        elif i % 3 == 2:
            extra = {"bu_size": 120 if i < 6 else 75, "bu_color": "2F5597"}
        ppr = deck.bullet_ppr("BODY", char=char, mar_l=27, indent=-27, **extra)
        paragraphs.append(deck.para(f"글머리 기호 {char} 항목 Bullet item {i + 1}", "BODY", 20, ppr=ppr, color=INK))
    x, y, w, h = deck.content
    _framed(deck, slide, x, y, w * 0.7, h, paragraphs, name="Bullets", body=dml.body_pr())


LEVEL_BULLETS = ("•", "–", "■", "○", "▶")


def _bullet_levels(deck):
    slide = deck.slide(SECTION, [f"lvl:{n}" for n in range(5)] + ["buChar", "marL+indent"]
                       + _faces(deck, "BODY", "ALT"), title="글머리 기호 수준 0–4")
    x, y, w, h = deck.content
    for column, role in enumerate(("BODY", "ALT")):
        paragraphs = []
        for _ in range(2):
            for level in range(5):
                size = 20 - 2 * level
                ppr = deck.bullet_ppr(role, char=LEVEL_BULLETS[level], lvl=level, mar_l=27 * (level + 1), indent=-20)
                paragraphs.append(deck.para(f"수준 {level} 항목 Level {level}", role, size, ppr=ppr, color=INK))
        _framed(deck, slide, x + column * (w / 2 + 6), y, w / 2 - 6, h, paragraphs, name=f"Levels {role}",
                body=dml.body_pr())


NUMBERINGS = (("arabicPeriod", None), ("arabicParenR", None), ("arabicParenBoth", None), ("arabicPlain", None),
              ("romanUcPeriod", None), ("romanLcPeriod", None), ("alphaUcPeriod", None), ("alphaLcParenR", 5))


def _numbering(deck):
    slide = deck.slide(SECTION, [f"buAutoNum:{scheme}" for scheme, _ in NUMBERINGS], title="번호 매기기")
    for (x, y, w, h, cap_y), (scheme, start) in zip(_cells(deck, 4, 2), NUMBERINGS):
        deck.caption(slide.shapes, x, cap_y, w, scheme + (f" startAt={start}" if start else ""))
        bullet = ("autonum", scheme, start) if start else ("autonum", scheme)
        ppr = dml.p_pr(bullet=bullet, bu_font=deck.font("BODY").family, mar_l=30, indent=-30)
        paragraphs = [deck.para(f"번호 항목 {i}", "BODY", 18, ppr=ppr, color=INK) for i in range(1, 4)]
        _framed(deck, slide, x, y, w, h, paragraphs, name=f"Numbering {scheme}", body=dml.body_pr())


OUTLINE = ((0, "arabicPeriod"), (1, "alphaLcParenR"), (1, "alphaLcParenR"), (2, "romanLcPeriod"),
           (3, "arabicParenBoth"), (4, "alphaUcPeriod"), (4, "alphaUcPeriod"), (0, "arabicPeriod"),
           (1, "alphaLcParenR"))


def _numbered_levels(deck):
    schemes = list(dict.fromkeys(scheme for _, scheme in OUTLINE))
    slide = deck.slide(SECTION, [f"lvl:{n}" for n in range(5)] + [f"buAutoNum:{s}" for s in schemes],
                       title="번호 매기기 수준 0–4 (개요)")
    paragraphs = []
    for level, scheme in OUTLINE:
        ppr = dml.p_pr(lvl=level, bullet=("autonum", scheme), bu_font=deck.font("SERIF").family,
                       mar_l=32 * (level + 1), indent=-28)
        paragraphs.append(deck.para(f"개요 수준 {level} — Outline level {level}", "SERIF", 20 - 2 * level, ppr=ppr,
                                    color=INK))
    x, y, w, h = deck.content
    _framed(deck, slide, x, y, w * 0.75, h, paragraphs, name="Outline numbering", body=dml.body_pr())


def _indents(deck):
    slide = deck.slide(SECTION, [f"lvl:{n}" for n in range(5)] + ["marL+indent", "buNone"], title="들여쓰기 수준 0–4")
    x, y, w, h = deck.content
    paragraphs = [
        deck.para("첫 줄 들여쓰기 First-line indent: " + PARA_KO, "BODY", 14,
                  ppr=dml.p_pr(bullet="none", mar_l=0, indent=36), color=INK),
        deck.para("내어쓰기 Hanging indent: " + PARA_KO, "BODY", 14,
                  ppr=dml.p_pr(bullet="none", mar_l=48, indent=-48), color=INK),
    ]
    for level in range(5):
        paragraphs.append(deck.para(f"수준 {level} 왼쪽 여백 {36 * level} pt — {KO}", "BODY", 16,
                                    ppr=dml.p_pr(bullet="none", lvl=level, mar_l=36 * level, indent=0), color=INK))
    _framed(deck, slide, x, y, w, h, paragraphs, name="Indents", body=dml.body_pr())


# --- spacing, anchors, wrapping, breaks, tabs -----------------------------------------------------------------------


def _line_spacing(deck):
    samples = ((("pct", 80), "줄 간격 80%"), (("pct", 100), "줄 간격 100%"), (("pct", 150), "줄 간격 150%"),
               (("pct", 200), "줄 간격 200%"), (("pts", 30), "줄 간격 30 pt 고정"))
    slide = deck.slide(SECTION, ["lnSpc:pct", "lnSpc:pts"], title="줄 간격")
    x0, y0, w0, h0 = deck.content
    width = w0 / len(samples)
    for i, (spacing, label) in enumerate(samples):
        x = x0 + i * width
        deck.caption(slide.shapes, x, y0, width - 8, label)
        _framed(deck, slide, x, y0 + 18, width - 8, h0 - 18,
                [deck.para(PARA_KO, "BODY", 14, ppr=dml.p_pr(ln_spc=spacing), color=INK)],
                name=f"Line spacing {label}", body=dml.body_pr())


def _paragraph_spacing(deck):
    slide = deck.slide(SECTION, ["spcBef", "spcAft"], title="문단 앞뒤 간격")
    x0, y0, w0, h0 = deck.content
    boxes = (
        ("spcBef 0 / 6 / 12 / 24 pt", [dml.p_pr(spc_bef=("pts", v)) for v in (0, 6, 12, 24)]),
        ("spcAft 0 / 6 / 12 / 24 pt", [dml.p_pr(spc_aft=("pts", v)) for v in (0, 6, 12, 24)]),
        ("spcBef 50% / spcAft 100%", [dml.p_pr(spc_bef=("pct", 50), spc_aft=("pct", 100)) for _ in range(4)]),
    )
    width = w0 / len(boxes)
    for i, (label, pprs) in enumerate(boxes):
        x = x0 + i * width
        deck.caption(slide.shapes, x, y0, width - 10, label)
        paragraphs = [deck.para(f"문단 {n + 1}: 간격을 잰다 Spacing", "BODY", 16, ppr=ppr, color=INK)
                      for n, ppr in enumerate(pprs)]
        _framed(deck, slide, x, y0 + 18, width - 10, h0 - 18, paragraphs, name=f"Paragraph spacing {i + 1}",
                body=dml.body_pr())


def _anchors(deck):
    slide = deck.slide(SECTION, ["anchor:t", "anchor:ctr", "anchor:b", "anchorCtr", "insets:wide"],
                       title="세로 맞춤과 안쪽 여백")
    samples = (
        ("anchor=t", dml.body_pr(anchor="t")),
        ("anchor=ctr", dml.body_pr(anchor="ctr")),
        ("anchor=b", dml.body_pr(anchor="b")),
        ("anchor=t, anchorCtr=1", dml.body_pr(anchor="t", anchor_ctr=True)),
        ("insets 24 pt", dml.body_pr(anchor="t", insets=(24, 24, 24, 24))),
        ("insets 0", dml.body_pr(anchor="t", insets=(0, 0, 0, 0))),
    )
    for (x, y, w, h, cap_y), (label, body) in zip(_cells(deck, 3, 2), samples):
        deck.caption(slide.shapes, x, cap_y, w, label)
        sppr = dml.sp_pr(x, y, w, h, fill=dml.solid_fill("F2F2F2"), line=FRAME)
        dml.add_sp(slide.shapes, sppr, name=f"Anchor {label}",
                   txbody=dml.tx_body([deck.para("맞춤 Anchor 가나다", "BODY", 18, color=INK)], body=body))


def _wrapping(deck):
    slide = deck.slide(SECTION, ["wrap:none", "wrap:square", "spAutoFit"], title="줄 바꿈 설정 (wrap)")
    x0, y0, _, _ = deck.content
    text = "자동 줄 바꿈을 끄면 글자가 상자 밖으로 이어진다 Text runs past the box"
    samples = (("wrap=none", dml.body_pr(wrap=False)), ("wrap=square", dml.body_pr(wrap=True)),
               ("wrap=square + spAutoFit", dml.body_pr(wrap=True, autofit="sp")))
    for i, (label, body) in enumerate(samples):
        y = y0 + i * 140
        deck.caption(slide.shapes, x0, y, 300, label, align="l")
        _framed(deck, slide, x0, y + 18, 300, 80, [deck.para(text, "BODY", 18, color=INK)], name=f"Wrap {label}",
                body=body)


def _breaks(deck):
    slide = deck.slide(SECTION, ["br", "eaLnBrk:off", "latinLnBrk:on"], title="줄 바꿈 (a:br, 한글·영문 단어 나눔)")
    cells = _cells(deck, 2, 2)
    run = ("BODY", 18)
    samples = (
        ("a:br 줄 바꿈", [deck.rich([("첫째 줄", *run), ("\n", *run), ("둘째 줄 (줄 바꿈 Line break)", *run),
                                    ("\n", *run), ("셋째 줄", *run)])]),
        ("eaLnBrk=1 (기본: 음절 단위)", [deck.para(PARA_KO, "BODY", 16, color=INK)]),
        ("eaLnBrk=0 (어절 단위)", [deck.para(PARA_KO, "BODY", 16, ppr=dml.p_pr(ea_ln_brk=False), color=INK)]),
        ("latinLnBrk=1 (영단어 나눔)", [deck.para("Internationalization supercalifragilistic "
                                                "electroencephalography " + PARA_EN, "BODY", 16,
                                                ppr=dml.p_pr(latin_ln_brk=True), color=INK)]),
    )
    for (x, y, w, h, cap_y), (label, paragraphs) in zip(cells, samples):
        deck.caption(slide.shapes, x, cap_y, w, label)
        _framed(deck, slide, x, y, w * 0.8, h, paragraphs, name=f"Breaks {label}", body=dml.body_pr())


def _tabs(deck):
    slide = deck.slide(SECTION, ["tab:l", "tab:ctr", "tab:r", "tab:dec", "rPr:b"],
                       title="탭 정지 위치 (왼쪽, 가운데, 오른쪽, 소수점)")
    tabs = [(150, "l"), (330, "ctr"), (520, "r"), (700, "dec")]
    rows = (("품목\t수량\t단가\t금액", True), ("사과\t12\t1,500\t18,000.00", False), ("배\t3\t2,750\t8,250.5", False),
            ("Watermelon\t1\t15,000\t15,000", False), ("합계 Total\t16\t—\t41,250.50", True))
    x, y, w, _ = deck.content
    paragraphs = [deck.para(text, "BODY", 18, ppr=dml.p_pr(tabs=tabs), bold=bold, color=INK) for text, bold in rows]
    _framed(deck, slide, x, y, w, 220, paragraphs, name="Tabs", body=dml.body_pr())
    for pos, align in tabs:
        deck.caption(slide.shapes, x + pos - 30, y + 230, 60, f"tab {align}")


# --- scripts, symbols, sizes, shapes, effects -----------------------------------------------------------------------


def _mixed_scripts(deck):
    slide = deck.slide(SECTION, _faces(deck, *ROLES4), title="한글·영문·숫자·문장 부호 섞기")
    text = "2026년 11월 4일(화) 오후 3:30 — Q3 매출 12.5% ↑, 고객 1,240명 (Japan·Vietnam)"
    rows = [(deck.para(text, role, 20, color=INK), 32) for role in ROLES4]
    rows += [(deck.para("“따옴표”와 ‘작은따옴표’, 「낫표」 그리고 《책 이름》… 끝.", role, 20, color=INK), 32)
             for role in ROLES4]
    _stack(deck, slide, rows, gap=14, name="Mixed scripts")


def _symbols(deck):
    slide = deck.slide(SECTION, _faces(deck, *ROLES4), title="기호와 문장 부호 (모든 글꼴에 있는 글자만)")
    rows = []
    for role in ROLES4:
        rows += [(deck.para(line, role, 15, color=INK), 21) for line in SYMBOLS]
    _stack(deck, slide, rows, gap=4, name="Symbols")


def _extreme_sizes(deck):
    slide = deck.slide(SECTION, ["fontSize:6", "fontSize:7", "fontSize:72", "fontSize:96", "fontSize:120"]
                       + _faces(deck, "BODY", "HEAD", "SERIF", "ALT"), title="아주 작은 글자와 아주 큰 글자")
    x0, y0, _, _ = deck.content
    _stack(deck, slide, [(deck.para(f"6 pt: {KO} {LATIN} 0123456789", "BODY", 6, color=INK), 10),
                         (deck.para(f"7 pt: {KO} {LATIN} 0123456789", "BODY", 7, color=INK), 11)], gap=6, name="Small")
    for i, (size, role, text, width) in enumerate(((72, "HEAD", "가A", 200), (96, "SERIF", "한글", 240),
                                                   (120, "ALT", "글", 180))):
        x = x0 + (0, 230, 520)[i]
        deck.text(slide.shapes, x, y0 + 60, width, size * 1.6, text, role, size, name=f"Size {size}", wrap=False,
                  color=INK)
        deck.caption(slide.shapes, x, y0 + 60 + size * 1.6 + 4, width, f"{size} pt {role}")


def _text_in_shapes(deck):
    presets = ("ellipse", "triangle", "chevron", "wedgeRoundRectCallout", "cloud", "hexagon")
    slide = deck.slide(SECTION, ["txBody:in-shape"], title="도형 안의 글자")
    for (x, y, w, h), prst in zip(deck.grid(3, 2), presets):
        sppr = dml.sp_pr(x + (w - 220) / 2, y + 16, 220, h - 56, prst=prst, fill=dml.solid_fill("DEEBF7"),
                         line=dml.ln(1.25, color="2F5597"))
        dml.add_sp(slide.shapes, sppr, name=f"Text in {prst}",
                   txbody=dml.tx_body([deck.para("도형 속 글자 Text in shape", "BODY", 16, align="ctr", color=INK)],
                                      body=dml.body_pr(anchor="ctr")))
        deck.caption(slide.shapes, x, y + h - 22, w, prst)


def _text_effects(deck):
    slide = deck.slide(SECTION, ["text:gradFill", "text:ln", "effect:outerShdw:text", "effect:glow:text",
                                 "effect:reflection:text"], title="글자 효과 조합")
    gradient = dml.grad_fill([(0, "FFC000"), (100, "C00000")], angle=90)
    samples = (
        ("그림자 + 그라데이션", {"fill": gradient, "effects": dml.effect_lst(dml.outer_shdw(blur=4, dist=4))}),
        ("네온 + 윤곽선", {"color": "FFFFFF", "line": dml.ln(1, color="2F5597"),
                       "effects": dml.effect_lst(dml.glow(6, "00B0F0", 70))}),
        ("반사 Reflection", {"color": "2F5597", "effects": dml.effect_lst(dml.reflection(end_pos=50, dist=2))}),
        ("윤곽선 + 그림자", {"fill": dml.no_fill(), "line": dml.ln(1.5, color="000000"),
                        "effects": dml.effect_lst(dml.outer_shdw(blur=3, dist=3, alpha=50))}),
    )
    for (x, y, w, h), (label, kwargs) in zip(deck.grid(2, 2), samples):
        deck.text(slide.shapes, x, y + 10, w, h - 40, f"효과 {label}", "HEAD", 36, name=f"Effect {label}",
                  align="ctr", anchor="ctr", wrap=False, **kwargs)


def _mixed_sizes(deck):
    aligns = ("base", "ctr", "t", "b")
    slide = deck.slide(SECTION, ["fontAlgn", "fontSize:12", "fontSize:24", "fontSize:36"],
                       title="한 줄 안의 여러 글자 크기 (fontAlgn)")
    for (x, y, w, h, cap_y), align in zip(_cells(deck, 2, 2), aligns):
        deck.caption(slide.shapes, x, cap_y, w, f"fontAlgn={align}")
        paragraph = deck.rich([("작은 12 ", "BODY", 12), ("중간 24 ", "BODY", 24), ("큰 36 ", "HEAD", 36),
                               ("Mixed 18", "SERIF", 18)], ppr=dml.p_pr(font_algn=align))
        _framed(deck, slide, x, y, w, h * 0.6, [paragraph], name=f"Mixed sizes {align}",
                body=dml.body_pr(anchor="ctr"))


def _report_page(deck):
    slide = deck.slide(SECTION, _faces(deck, "HEAD", "BODY", "SERIF") + ["buChar", "rPr:i", "fontSize:14"],
                       title="보고서 슬라이드 (제목, 본문, 목록)")
    x, y, w, _ = deck.content
    _stack(deck, slide, [(deck.para("3분기 사업 보고 — 요약", "HEAD", 28, color="1F3864"), 42)], y=y, name="Heading")
    body = [deck.para(PARA_KO, "BODY", 14, color=INK)]
    body += [deck.para(item, "BODY", 14, ppr=deck.bullet_ppr("BODY", mar_l=22, indent=-16), color=INK)
             for item in ("매출 성장률 12% 달성, 해외 비중 31%", "신규 고객 1,240명 (전 분기 대비 +18%)",
                          "다음 분기 목표: 변환 정확도와 처리 속도 개선")]
    body.append(deck.para("※ 수치는 예시이며 실제 실적과 관계없다. Figures are illustrative.", "SERIF", 12,
                          italic=True, color="595959"))
    _framed(deck, slide, x, y + 52, w * 0.8, 300, body, name="Report body", body=dml.body_pr())


def _emoji(deck):
    """--fonts windows only: emoji need an emoji font, and the OFL lock has none."""
    slide = deck.slide(SECTION, ["text:emoji"] + _faces(deck, "BODY"), title="이모지 (Windows 글꼴 빌드 전용)")
    emoji = dml.rpr(EMOJI_FONT, 40)
    label = deck.rpr("BODY", 24, color=INK)
    end = deck.rpr("BODY", 24, tag="a:endParaRPr")
    rows = [
        dml.paragraph([("이모지 Emoji: ", label), ("😀 🎉 👍 🚀 🌏 ✅", emoji)], end_rpr=end),
        dml.paragraph([("글자 사이 ", label), ("📊", emoji), (" 차트, ", label), ("📄", emoji), (" 문서", label)],
                      end_rpr=end),
    ]
    _stack(deck, slide, [(row, 64) for row in rows], gap=20, name="Emoji")


def build(deck):
    _role_sizes(deck)
    _weights(deck)
    _styles(deck)
    _underlines(deck)
    _baselines(deck)
    _styles_in_roles(deck)
    _spacing(deck)
    _spacing_large(deck)
    _caps(deck)
    _colours(deck)
    _highlight_and_links(deck)
    _gradient_text(deck)
    _outline_text(deck)
    _alignment(deck)
    _alignment(deck, english=True)
    _vertical(deck)
    _vertical_mixed(deck)
    _rotated_boxes(deck)
    _rotated_body(deck)
    _autofit(deck)
    _columns(deck)
    _bullets(deck)
    _bullet_levels(deck)
    _numbering(deck)
    _numbered_levels(deck)
    _indents(deck)
    _line_spacing(deck)
    _paragraph_spacing(deck)
    _anchors(deck)
    _wrapping(deck)
    _breaks(deck)
    _tabs(deck)
    _mixed_scripts(deck)
    _symbols(deck)
    _extreme_sizes(deck)
    _text_in_shapes(deck)
    _text_effects(deck)
    _mixed_sizes(deck)
    _report_page(deck)
    if deck.fonts == "windows":
        _emoji(deck)
