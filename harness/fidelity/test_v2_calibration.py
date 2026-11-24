"""Tests for `python -m harness.fidelity.v2_calibration` (M3 Task 12): our V2 next to the renderer noise floor, and
the proposed V2 limits, on synthetic results JSON."""

import json

import numpy as np
import pytest

from harness.fidelity import metrics, v2_calibration


def gate(residual5, shift1_percent):
    shift1 = shift1_percent / 100
    return {"raw_px32": shift1, "px32_shift1": shift1, "residual5": residual5,
            "pass": residual5 <= metrics.V2_MAX_RESIDUAL and shift1 <= metrics.V2_MAX_SHIFT1}


def record(deck_id, set_name, slides, variant="std", public=True):
    """`slides`: (our V2 (residual5, shift1 %), the noise floor (residual5, shift1 %) or None) per slide."""
    return {"id": deck_id, "public": public, "set": set_name, "variant": variant, "pages": len(slides),
            "slides": [{"index": i, "label": None, "v1": None, "v2": gate(*ours),
                        "noise": None if noise is None else gate(*noise), "s": {}, "known": [], "pass": False,
                        "heatmaps": {}} for i, (ours, noise) in enumerate(slides)]}


ATLAS_NOISE = [(0, 0.1), (10, 0.2), (40, 0.5), (60, 0.9), (437, 1.53)]


def results():
    atlas = record("atlas", "atlas", [((r + 5, s + 0.05), (r, s)) for r, s in ATLAS_NOISE])
    probe = record("probe", "public", [((20, 0.3), (5, 0.2)), ((80, 0.7), (30, 0.4))])
    private = record("0123456789ab", "private", [((900, 4.0), None)], variant="pdf", public=False)
    return {"schema": "deckback.fidelity/1", "date": "2026-11-11", "converter": "deckback",
            "decks": [atlas, probe, private]}


# ---- round values -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value, step, expected", [
    (437, 1, 500), (500, 1, 600), (12345, 1, 20000), (9.5, 1, 10), (49, 1, 50), (0, 1, 1),
    (1.53, 0.01, 2), (0.86, 0.01, 0.9), (0.6, 0.01, 0.7), (0.0042, 0.01, 0.01), (0, 0.01, 0.01)])
def test_round_above_is_the_smallest_one_digit_value_above(value, step, expected):
    assert v2_calibration.round_above(value, step) == pytest.approx(expected)


# ---- the proposal and the table ---------------------------------------------------------------------------------


def test_the_noise_floor_is_the_atlas_slides_with_a_ground_truth():
    report = v2_calibration.calibrate(results())
    floor = report["noiseFloor"]
    assert floor["slides"] == len(ATLAS_NOISE)
    residuals = [r for r, _ in ATLAS_NOISE]
    shifts = [s for _, s in ATLAS_NOISE]
    assert floor["residual5"] == pytest.approx({"median": np.median(residuals), "p95": np.percentile(residuals, 95),
                                                "p99": np.percentile(residuals, 99), "max": 437})
    assert floor["px32_shift1"] == pytest.approx({"median": np.median(shifts), "p95": np.percentile(shifts, 95),
                                                  "p99": np.percentile(shifts, 99), "max": 1.53})


def test_the_proposal_is_the_smallest_round_values_above_the_p99():
    report = v2_calibration.calibrate(results())
    p99_residual = np.percentile([r for r, _ in ATLAS_NOISE], 99)  # 60 + 0.96 x 377 = 421.92
    p99_shift = np.percentile([s for _, s in ATLAS_NOISE], 99)  # 0.9 + 0.96 x 0.63 = 1.5048 %
    assert p99_residual == pytest.approx(421.92) and p99_shift == pytest.approx(1.5048)
    assert report["limits"]["spec"] == {"residual5": 50, "px32_shift1": 0.6}
    assert report["limits"]["proposal"] == {"residual5": 500, "px32_shift1": 2}


def test_pass_counts_under_the_spec_and_the_proposal():
    report = v2_calibration.calibrate(results())
    rows = {(row["deck"], row["variant"]): row for row in report["table"]}
    atlas = rows[("atlas", "std")]
    # ours: (5, .15) (15, .25) (45, .55) (65, .95) (442, 1.58); noise: ATLAS_NOISE
    assert atlas == {"deck": "atlas", "set": "atlas", "variant": "std", "slides": 5,
                     "ours": {"spec": 3, "proposal": 5}, "groundTruth": 5, "noise": {"spec": 3, "proposal": 5}}
    probe = rows[("probe", "std")]
    assert probe["ours"] == {"spec": 1, "proposal": 2} and probe["noise"] == {"spec": 2, "proposal": 2}
    private = rows[("0123456789ab", "pdf")]
    assert private == {"deck": "0123456789ab", "set": "private", "variant": "pdf", "slides": 1,
                       "ours": {"spec": 0, "proposal": 0}, "groundTruth": 0, "noise": {"spec": 0, "proposal": 0}}
    total = report["total"]
    assert total["slides"] == 8 and total["groundTruth"] == 7
    assert total["ours"] == {"spec": 4, "proposal": 7} and total["noise"] == {"spec": 5, "proposal": 7}
    sets = {row["set"]: row for row in report["bySet"]}
    assert sets["atlas"]["ours"] == {"spec": 3, "proposal": 5} and sets["private"]["slides"] == 1


def test_noise_floor_per_deck_is_given():
    report = v2_calibration.calibrate(results())
    per_deck = {(row["deck"], row["variant"]): row for row in report["noiseByDeck"]}
    assert set(per_deck) == {("atlas", "std"), ("probe", "std")}
    assert per_deck[("probe", "std")]["slides"] == 2
    assert per_deck[("probe", "std")]["residual5"]["max"] == 30
    assert per_deck[("probe", "std")]["px32_shift1"]["max"] == pytest.approx(0.4)


def test_error_records_and_slides_without_a_ground_truth_are_left_out():
    data = results()
    data["decks"][0]["slides"][0]["noise"] = {"pass": False, "error": "no ground truth"}
    data["decks"][0]["slides"][1]["v2"] = {"pass": False, "error": "no render"}
    report = v2_calibration.calibrate(data)
    assert report["noiseFloor"]["slides"] == 4
    atlas = [row for row in report["table"] if row["deck"] == "atlas"][0]
    assert atlas["slides"] == 4 and atlas["groundTruth"] == 4
    assert report["total"]["errors"] == 2


def test_the_population_can_be_another_deck():
    report = v2_calibration.calibrate(results(), population="probe")
    assert report["noiseFloor"]["deck"] == "probe" and report["noiseFloor"]["slides"] == 2


def test_no_population_slides_is_an_error():
    data = results()
    data["decks"] = data["decks"][1:]
    with pytest.raises(v2_calibration.CalibrationError, match="no slide of atlas has a noise floor"):
        v2_calibration.calibrate(data)


# ---- the command ------------------------------------------------------------------------------------------------


def test_main_prints_the_table_and_changes_nothing(tmp_path, capsys):
    path = tmp_path / "results.json"
    text = json.dumps(results())
    path.write_text(text, encoding="utf-8")
    limits = (metrics.V2_MAX_RESIDUAL, metrics.V2_MAX_SHIFT1)
    out_json = tmp_path / "calibration.json"
    assert v2_calibration.main(["--results", str(path), "--json", str(out_json)]) == 0
    out, err = capsys.readouterr()
    assert err == ""
    assert path.read_text(encoding="utf-8") == text
    assert (metrics.V2_MAX_RESIDUAL, metrics.V2_MAX_SHIFT1) == limits
    assert "residual5 <= 50 px, px32_shift1 <= 0.6 %" in out
    assert "residual5 <= 500 px, px32_shift1 <= 2 %" in out
    assert "0123456789ab" in out and str(tmp_path) not in out
    assert json.loads(out_json.read_text(encoding="utf-8")) == json.loads(json.dumps(v2_calibration.calibrate(
        results())))


def test_main_exit_3_without_a_population(tmp_path, capsys):
    data = results()
    data["decks"] = data["decks"][1:]
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert v2_calibration.main(["--results", str(path)]) == 3
    assert "no slide of atlas" in capsys.readouterr().err
