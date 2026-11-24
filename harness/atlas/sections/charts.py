"""Atlas section `charts`: native charts made by python-pptx -- column and bar (clustered, stacked, 100 %), line (with
and without markers, smoothed), pie, doughnut, area (standard, stacked), XY scatter, radar (markers, filled) and
bubble -- with Korean category labels, series names and axis titles.

Fonts. python-pptx writes chart text without fonts, so PowerPoint would draw it in the theme or a system font.
`style_chart` gives the chart-wide text properties (c:txPr) and every title, legend, axis and data-label text
property an explicit latin/ea/cs font (dml.apply_fonts), so a chart names only the deck's role families."""

import io
import re
import zipfile
from xml.sax.saxutils import quoteattr

from lxml import etree
from pptx.chart.data import BubbleChartData, CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION, XL_MARKER_STYLE
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.oxml.ns import qn
from pptx.util import Pt

from harness.atlas import drawingml as dml

SECTION = "charts"
PALETTE = ("2F5597", "ED7D31", "70AD47", "FFC000", "5B9BD5", "A5A5A5")
REGIONS = ("서울", "부산", "대구", "인천", "광주")
QUARTERS = ("1분기", "2분기", "3분기", "4분기")
LEGEND = {"b": XL_LEGEND_POSITION.BOTTOM, "r": XL_LEGEND_POSITION.RIGHT, "t": XL_LEGEND_POSITION.TOP}
BASE = ["chart:fonts", "chart:korean"]


def category_data(categories, series, number_format=None):
    data = CategoryChartData(number_format=number_format) if number_format else CategoryChartData()
    data.categories = list(categories)
    for name, values in series:
        data.add_series(name, list(values))
    return data


def _has_axes(chart):
    return bool(chart._chartSpace.xpath("./c:chart/c:plotArea/c:catAx | ./c:chart/c:plotArea/c:valAx"))


def workbook_fonts(chart, family):
    """Make the chart's embedded workbook (XlsxWriter's .xlsx) name only `family`: the cell font in xl/styles.xml and
    the theme's major/minor fonts, whose per-script list (MS PGothic, Malgun Gothic, ...) is dropped. PowerPoint never
    draws the workbook, but a deck committed to the public corpus may name only lock-file fonts."""
    part = chart.part.chart_workbook.xlsx_part
    if part is None:
        return
    with zipfile.ZipFile(io.BytesIO(part.blob)) as source:
        entries = [(info, source.read(info)) for info in source.infolist()]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for info, data in entries:
            if info.filename == "xl/styles.xml":
                data = re.sub(rb'<name val="[^"]*"/>', f"<name val={quoteattr(family)}/>".encode("utf-8"), data)
            elif info.filename.startswith("xl/theme/") and info.filename.endswith(".xml"):
                root = etree.fromstring(data)
                for collection in root.iter(qn("a:majorFont"), qn("a:minorFont")):
                    for child in list(collection):
                        if child.tag == qn("a:font"):
                            collection.remove(child)
                        elif child.tag in (qn("a:latin"), qn("a:ea"), qn("a:cs")):
                            child.attrib.clear()
                            child.set("typeface", family)
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            target.writestr(info, data)
    part.blob = out.getvalue()


AXIS_ID_BASE = 50000001


def keep_to_schema(chart):
    """Fix what python-pptx's chart templates write against ECMA-376: negative axis ids (c:axId / c:crossAx are
    xs:unsignedInt) become small positive ids, consistently within the chart, and radar series lose the c:smooth that
    CT_RadarSer does not have."""
    space = chart._chartSpace
    ids = list(dict.fromkeys(space.xpath(".//c:axId/@val")))
    mapping = {old: str(AXIS_ID_BASE + i) for i, old in enumerate(ids)}
    for element in space.xpath(".//c:axId | .//c:crossAx"):
        element.set("val", mapping[element.get("val")])
    for smooth in space.xpath("./c:chart/c:plotArea/c:radarChart/c:ser/c:smooth"):
        smooth.getparent().remove(smooth)


def _axis_title(axis, text, size):
    axis.has_title = True
    frame = axis.axis_title.text_frame
    frame.text = text
    frame.paragraphs[0].runs[0].font.size = Pt(size)


def style_chart(deck, chart, *, role="BODY", size=12, title=None, title_role="HEAD", legend="b", axis_titles=None,
                gridlines=True):
    """Fonts, title, legend, axis titles and gridlines of a python-pptx chart. Every text property in the chart
    ends up naming `role`'s family (the title `title_role`'s) for latin, ea and cs; the chart XML is then made
    schema-valid (keep_to_schema). Call it last, after series colours and data labels."""
    chart.font.size = Pt(size)
    if title:
        chart.has_title = True
        frame = chart.chart_title.text_frame
        frame.text = title
        run = frame.paragraphs[0].runs[0]
        run.font.size = Pt(size + 4)
        run.font.bold = True
    else:
        chart.has_title = False  # also stops PowerPoint from titling a one-series chart with the series name
    if legend:
        chart.has_legend = True
        chart.legend.position = LEGEND[legend]
        chart.legend.include_in_layout = False
        chart.legend.font.size = Pt(size)
    else:
        chart.has_legend = False
    if _has_axes(chart):
        for axis in (chart.category_axis, chart.value_axis):
            axis.tick_labels.font.size = Pt(size)
        chart.value_axis.has_major_gridlines = gridlines
        if axis_titles:
            _axis_title(chart.category_axis, axis_titles[0], size)
            _axis_title(chart.value_axis, axis_titles[1], size)
    dml.apply_fonts(chart._chartSpace, deck.font(role).family)
    if title:
        dml.apply_fonts(chart._chartSpace.find(qn("c:chart")).find(qn("c:title")), deck.font(title_role).family)
    keep_to_schema(chart)
    workbook_fonts(chart, deck.font(role).family)
    return chart


def colour_series(chart, colours=PALETTE, *, line=False, alpha=None):
    """Solid series fills (or line colours) from `colours`; alpha: opacity % of the fills."""
    for series, colour in zip(chart.plots[0].series, colours):
        if line:
            series.format.line.color.rgb = RGBColor.from_string(colour)
            series.format.line.width = Pt(2.25)
            continue
        series.format.fill.solid()
        series.format.fill.fore_color.rgb = RGBColor.from_string(colour)
        if alpha is not None:
            srgb = series._element.find(qn("c:spPr")).find(qn("a:solidFill")).find(qn("a:srgbClr"))
            srgb.append(srgb.makeelement(qn("a:alpha"), {"val": str(dml.pct(alpha))}))


def data_labels(chart, *, size=10, position=None, number_format=None, percent=False, category=False):
    plot = chart.plots[0]
    plot.has_data_labels = True
    labels = plot.data_labels
    labels.font.size = Pt(size)
    if number_format:
        labels.number_format = number_format
        labels.number_format_is_linked = False
    labels.show_value = not percent
    labels.show_percentage = percent
    labels.show_category_name = category
    if position is not None:
        labels.position = position
    return labels


def add_chart(deck, slide, chart_type, data, area=None):
    x, y, w, h = area or deck.content
    frame = slide.shapes.add_chart(chart_type, Pt(x), Pt(y), Pt(w), Pt(h), data)
    frame.name = f"Chart {chart_type.name}"
    return frame.chart


def _explode_point(chart, index, amount):
    """Pull one pie slice out by `amount` % (c:dPt/c:explosion, before the point's spPr)."""
    series = chart.plots[0].series[0]
    point = series.points[index]
    point.format.fill.solid()
    point.format.fill.fore_color.rgb = RGBColor.from_string("C00000")
    dpt = next(d for d in series._element.findall(qn("c:dPt")) if d.find(qn("c:idx")).get("val") == str(index))
    explosion = etree.SubElement(dpt, qn("c:explosion"), val=str(amount))
    dpt.find(qn("c:spPr")).addprevious(explosion)


# --- column and bar -------------------------------------------------------------------------------------------------


SALES = (("매출", (1250, 830, 540, 620, 410)), ("영업이익", (310, 190, 120, 150, 95)), ("순이익", (220, 140, 80, 105, 60)))
CHANNELS = (("국내", (420, 450, 480, 530)), ("해외", (210, 240, 260, 300)), ("온라인", (120, 150, 190, 240)))
DEPARTMENTS = ("영업부", "개발부", "인사부", "재무부", "마케팅부")
AGES = ("20대", "30대", "40대", "50대", "60대 이상")
ANSWERS = (("매우 만족", (30, 25, 20, 18, 15)), ("만족", (40, 42, 38, 35, 30)), ("보통", (20, 23, 30, 32, 35)),
           ("불만족", (10, 10, 12, 15, 20)))


def _column_clustered(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:col", "chart:grouping:clustered",
                                        "chart:title", "chart:legend", "chart:dLbls", "chart:axisTitle",
                                        "chart:gridlines", "chart:korean-categories", "chart:ser:solidFill"],
                       smoke=True, title="묶은 세로 막대형 (clustered column)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.COLUMN_CLUSTERED, category_data(REGIONS, SALES))
    colour_series(chart)
    data_labels(chart, size=9, position=XL_LABEL_POSITION.OUTSIDE_END, number_format="#,##0")
    style_chart(deck, chart, title="지역별 실적 (억 원)", axis_titles=("지역", "억 원"))


def _column_stacked(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:col", "chart:grouping:stacked",
                                        "chart:dLbls", "chart:korean-categories"], title="누적 세로 막대형 (stacked)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.COLUMN_STACKED, category_data(QUARTERS, CHANNELS))
    colour_series(chart, PALETTE[2:])
    data_labels(chart, size=10, position=XL_LABEL_POSITION.CENTER)
    style_chart(deck, chart, legend="r")


def _column_percent(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:col", "chart:grouping:percentStacked",
                                        "chart:korean-categories"],
                       title="100% 기준 누적 세로 막대형 (나눔고딕)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.COLUMN_STACKED_100, category_data(QUARTERS, CHANNELS))
    style_chart(deck, chart, role="ALT", title="채널별 비중", title_role="ALT_XBOLD")


def _bar_clustered(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:bar", "chart:grouping:clustered",
                                        "chart:dLbls", "chart:korean-categories", "chart:ser:solidFill"],
                       smoke=True, title="묶은 가로 막대형 (세리프)")
    data = category_data(DEPARTMENTS, (("2025년", (82, 64, 31, 45, 58)), ("2026년", (95, 71, 33, 47, 66))))
    chart = add_chart(deck, slide, XL_CHART_TYPE.BAR_CLUSTERED, data)
    colour_series(chart, ("A5A5A5", "C00000"))
    data_labels(chart, size=10, position=XL_LABEL_POSITION.OUTSIDE_END)
    style_chart(deck, chart, role="SERIF", size=13)


def _bar_stacked(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:bar", "chart:grouping:stacked",
                                        "chart:korean-categories"], title="누적 가로 막대형")
    chart = add_chart(deck, slide, XL_CHART_TYPE.BAR_STACKED, category_data(AGES, ANSWERS))
    colour_series(chart)
    style_chart(deck, chart, title="연령대별 응답 수", axis_titles=("연령대", "응답 수 (명)"))


def _bar_percent(deck):
    slide = deck.slide(SECTION, BASE + ["chart:barChart", "chart:barDir:bar", "chart:grouping:percentStacked",
                                        "chart:dLbls", "chart:korean-categories"], title="100% 기준 누적 가로 막대형")
    chart = add_chart(deck, slide, XL_CHART_TYPE.BAR_STACKED_100, category_data(AGES, ANSWERS))
    colour_series(chart, ("1F3864", "2F5597", "9DC3E6", "F4B183"))
    data_labels(chart, size=9, position=XL_LABEL_POSITION.CENTER)
    style_chart(deck, chart, legend="t")


# --- line -----------------------------------------------------------------------------------------------------------


MONTHS = tuple(f"{m}월" for m in range(1, 13))
TEMPERATURES = (("서울", (-2.4, 0.4, 5.7, 12.5, 17.8, 22.2, 24.9, 25.7, 21.2, 14.8, 7.2, 0.4)),
                ("부산", (3.2, 5.0, 8.9, 13.6, 17.5, 20.7, 24.4, 25.8, 22.5, 17.8, 11.6, 5.6)),
                ("제주", (6.1, 7.0, 9.9, 14.1, 17.9, 21.3, 25.6, 26.8, 23.3, 18.6, 13.2, 8.4)))


def _line_markers(deck):
    slide = deck.slide(SECTION, BASE + ["chart:lineChart", "chart:marker", "chart:marker:symbol", "chart:legend",
                                        "chart:korean-categories", "chart:axisTitle"], smoke=True,
                       title="꺾은선형 (표식 있음)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.LINE_MARKERS, category_data(MONTHS, TEMPERATURES, "0.0"))
    colour_series(chart, line=True)
    for series, style, colour in zip(chart.plots[0].series, (XL_MARKER_STYLE.CIRCLE, XL_MARKER_STYLE.SQUARE,
                                                             XL_MARKER_STYLE.TRIANGLE), PALETTE):
        series.marker.style = style
        series.marker.size = 8
        series.marker.format.fill.solid()
        series.marker.format.fill.fore_color.rgb = RGBColor.from_string(colour)
    style_chart(deck, chart, legend="r", title="월별 평균 기온", axis_titles=("월", "기온 (°C)"))


def _line_plain(deck):
    slide = deck.slide(SECTION, BASE + ["chart:lineChart", "chart:smooth", "chart:korean-categories"],
                       title="꺾은선형 (표식 없음, 곡선, 점선)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.LINE, category_data(MONTHS, TEMPERATURES, "0.0"))
    colour_series(chart, line=True)
    series = chart.plots[0].series
    series[0].smooth = True
    series[1].format.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    series[2].format.line.width = Pt(4)
    style_chart(deck, chart, size=11)


# --- pie and doughnut -----------------------------------------------------------------------------------------------


SHARES = ("국내 판매", "해외 판매", "온라인", "대리점", "기타")


def _pie(deck):
    slide = deck.slide(SECTION, BASE + ["chart:pieChart", "chart:dLbls", "chart:explosion", "chart:varyColors",
                                        "chart:dPt", "chart:korean-categories"], smoke=True, title="원형 (조각 분리)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.PIE, category_data(SHARES, (("점유율", (42, 27, 18, 9, 4)),)))
    chart.plots[0].vary_by_categories = True
    _explode_point(chart, 0, 12)
    data_labels(chart, size=12, position=XL_LABEL_POSITION.BEST_FIT, number_format="0%", percent=True, category=True)
    style_chart(deck, chart, size=12, title="판매 경로별 점유율", legend="r")


def _doughnut(deck):
    slide = deck.slide(SECTION, BASE + ["chart:doughnutChart", "chart:holeSize", "chart:dLbls",
                                        "chart:korean-categories"], title="도넛형")
    data = category_data(("인건비", "재료비", "임차료", "마케팅", "기타"),
                         (("2025년", (45, 25, 12, 10, 8)), ("2026년", (43, 24, 13, 13, 7))))
    chart = add_chart(deck, slide, XL_CHART_TYPE.DOUGHNUT, data)
    data_labels(chart, size=10, number_format="0%", percent=True)
    style_chart(deck, chart, legend="r", title="비용 구성 (안쪽 2025, 바깥 2026)")


# --- area -----------------------------------------------------------------------------------------------------------


YEARS = tuple(f"{y}년" for y in range(2019, 2027))
USERS = (("모바일", (120, 180, 260, 330, 420, 510, 600, 680)), ("PC", (300, 310, 305, 290, 280, 265, 250, 240)))


def _area(deck):
    slide = deck.slide(SECTION, BASE + ["chart:areaChart", "chart:grouping:standard", "chart:korean-categories",
                                        "chart:ser:solidFill"], title="영역형 (반투명)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.AREA, category_data(YEARS, USERS))
    colour_series(chart, ("ED7D31", "2F5597"), alpha=60)
    style_chart(deck, chart, axis_titles=("연도", "이용자 (만 명)"))


def _area_stacked(deck):
    slide = deck.slide(SECTION, BASE + ["chart:areaChart", "chart:grouping:stacked", "chart:korean-categories"],
                       title="누적 영역형")
    data = category_data(YEARS, USERS + (("태블릿", (40, 45, 60, 70, 80, 85, 95, 100)),))
    chart = add_chart(deck, slide, XL_CHART_TYPE.AREA_STACKED, data)
    colour_series(chart, PALETTE[2:])
    style_chart(deck, chart, legend="t")


# --- scatter, radar, bubble -----------------------------------------------------------------------------------------


def _scatter(deck):
    slide = deck.slide(SECTION, BASE + ["chart:scatterChart", "chart:scatterStyle:lineMarker", "chart:axisTitle",
                                        "chart:legend"], title="분산형 (XY)")
    data = XyChartData()
    for name, points in (("남성", ((165, 62), (170, 68), (174, 72), (178, 77), (182, 83), (176, 70))),
                         ("여성", ((152, 47), (158, 52), (161, 55), (165, 58), (168, 61), (163, 54)))):
        series = data.add_series(name)
        for x, y in points:
            series.add_data_point(x, y)
    chart = add_chart(deck, slide, XL_CHART_TYPE.XY_SCATTER, data)
    for series, style in zip(chart.plots[0].series, (XL_MARKER_STYLE.DIAMOND, XL_MARKER_STYLE.CIRCLE)):
        series.marker.style = style
        series.marker.size = 9
    style_chart(deck, chart, title="키와 몸무게", axis_titles=("키 (cm)", "몸무게 (kg)"))


SKILLS = ("기획", "개발", "디자인", "소통", "리더십", "분석")
PEOPLE = (("김대리", (4, 5, 3, 4, 2, 5)), ("이과장", (5, 3, 4, 5, 4, 3)))


def _radar(deck):
    slide = deck.slide(SECTION, BASE + ["chart:radarChart", "chart:radarStyle:marker", "chart:korean-categories"],
                       title="방사형 (표식)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.RADAR_MARKERS, category_data(SKILLS, PEOPLE))
    colour_series(chart, line=True)
    style_chart(deck, chart, legend="r", size=13)


def _radar_filled(deck):
    slide = deck.slide(SECTION, BASE + ["chart:radarChart", "chart:radarStyle:filled", "chart:korean-categories"],
                       title="방사형 (채움)")
    chart = add_chart(deck, slide, XL_CHART_TYPE.RADAR_FILLED, category_data(SKILLS, PEOPLE))
    colour_series(chart, ("5B9BD5", "ED7D31"), alpha=55)
    style_chart(deck, chart, role="SERIF", legend="r", size=13)


def _bubble(deck):
    slide = deck.slide(SECTION, BASE + ["chart:bubbleChart", "chart:axisTitle", "chart:legend"],
                       title="거품형 (bubble)")
    data = BubbleChartData()
    for name, points in (("제품 가", ((12, 70, 30), (18, 64, 45))), ("제품 나", ((25, 82, 60), (30, 75, 25))),
                         ("제품 다", ((40, 58, 80), (8, 90, 15)))):
        series = data.add_series(name)
        for x, y, size in points:
            series.add_data_point(x, y, size)
    chart = add_chart(deck, slide, XL_CHART_TYPE.BUBBLE, data)
    colour_series(chart, alpha=75)
    style_chart(deck, chart, title="가격·만족도·판매량", axis_titles=("가격 (만 원)", "만족도 (점)"))


def build(deck):
    _column_clustered(deck)
    _column_stacked(deck)
    _column_percent(deck)
    _bar_clustered(deck)
    _bar_stacked(deck)
    _bar_percent(deck)
    _line_markers(deck)
    _line_plain(deck)
    _pie(deck)
    _doughnut(deck)
    _area(deck)
    _area_stacked(deck)
    _scatter(deck)
    _radar(deck)
    _radar_filled(deck)
    _bubble(deck)
