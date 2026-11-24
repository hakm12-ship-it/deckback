"""Tests for regiondiff.diff_ratio on synthetic images."""

import numpy as np
import pytest
from PIL import Image

from harness.spikes import regiondiff


def save(tmp_path, name, pixels):
    path = tmp_path / name
    Image.fromarray(pixels.astype(np.uint8), "RGB").save(path)
    return path


@pytest.fixture
def base():
    return np.full((40, 40, 3), 200, dtype=np.uint8)


def test_identical_images_have_zero_ratio(tmp_path, base):
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", base)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20)) == 0.0


def test_one_changed_pixel_in_a_10x10_box_is_one_percent(tmp_path, base):
    changed = base.copy()
    changed[15, 12] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20)) == pytest.approx(0.01)


def test_changed_pixel_inside_an_exclude_box_is_ignored(tmp_path, base):
    changed = base.copy()
    changed[15, 12] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20), exclude_boxes_px=[(11, 14, 14, 17)]) == 0.0


def test_pixels_outside_the_box_do_not_count(tmp_path, base):
    changed = base.copy()
    changed[5, 5] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20)) == 0.0


def test_difference_must_exceed_the_threshold_in_some_channel(tmp_path, base):
    changed = base.copy()
    changed[12, 12] = (200 + 32, 200, 200)   # exactly thr: not counted
    changed[13, 13] = (200, 200, 200 - 33)   # thr + 1: counted
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20)) == pytest.approx(0.01)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20), thr=31) == pytest.approx(0.02)


def test_exclude_boxes_shrink_the_denominator_too(tmp_path, base):
    # 100-pixel box, 50 pixels excluded, 1 changed pixel left over: 1 / 50.
    changed = base.copy()
    changed[10, 10] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    assert regiondiff.diff_ratio(a, b, (10, 10, 20, 20), exclude_boxes_px=[(10, 15, 20, 20)]) == pytest.approx(0.02)


def test_box_is_clipped_to_the_image(tmp_path, base):
    changed = base.copy()
    changed[39, 39] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    # box 30..50 is clipped to 30..40: 100 pixels, one changed.
    assert regiondiff.diff_ratio(a, b, (30, 30, 50, 50)) == pytest.approx(0.01)


def test_images_of_different_size_are_rejected(tmp_path, base):
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", np.full((40, 41, 3), 200, dtype=np.uint8))
    with pytest.raises(ValueError, match="size"):
        regiondiff.diff_ratio(a, b, (10, 10, 20, 20))


def test_fully_excluded_box_is_rejected(tmp_path, base):
    a = save(tmp_path, "a.png", base)
    with pytest.raises(ValueError, match="no pixels"):
        regiondiff.diff_ratio(a, a, (10, 10, 20, 20), exclude_boxes_px=[(0, 0, 40, 40)])


# --- diff_stats: the numbers behind a ratio -------------------------------------------------------

def test_diff_stats_reports_max_mean_and_ratios_at_several_thresholds(tmp_path, base):
    changed = base.copy()
    changed[10, 10] = (200 + 40, 200, 200)        # diff 40
    changed[11, 10:12] = (200, 200 - 30, 200)     # two pixels, diff 30
    changed[12, 10:13] = (200, 200, 200 + 20)     # three pixels, diff 20
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    stats = regiondiff.diff_stats(a, b, (10, 10, 20, 20), thresholds=(32, 24, 16))
    assert stats["pixels"] == 100
    assert stats["max_diff"] == 40
    assert stats["mean_diff"] == pytest.approx((40 + 2 * 30 + 3 * 20) / 100)
    assert stats["ratios"] == {32: pytest.approx(0.01), 24: pytest.approx(0.03), 16: pytest.approx(0.06)}


def test_diff_stats_ratio_matches_diff_ratio(tmp_path, base):
    changed = base.copy()
    changed[15, 12] = (0, 0, 0)
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    stats = regiondiff.diff_stats(a, b, (10, 10, 20, 20), thresholds=(32,))
    assert stats["ratios"][32] == regiondiff.diff_ratio(a, b, (10, 10, 20, 20))


def test_diff_stats_ignores_excluded_pixels_for_max_and_mean(tmp_path, base):
    changed = base.copy()
    changed[15, 12] = (0, 0, 0)       # diff 200, inside the exclude box
    changed[10, 10] = (200, 200, 190)  # diff 10, counted
    a = save(tmp_path, "a.png", base)
    b = save(tmp_path, "b.png", changed)
    stats = regiondiff.diff_stats(a, b, (10, 10, 20, 20), exclude_boxes_px=[(11, 14, 14, 17)])
    assert stats["max_diff"] == 10
    assert stats["pixels"] == 100 - 9
    assert stats["mean_diff"] == pytest.approx(10 / 91)
