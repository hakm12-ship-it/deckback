"""Shared pytest options for the harness.

Tests that drive the desktop PowerPoint are marked `@pytest.mark.powerpoint`. They open PowerPoint through COM,
take minutes and need a Windows PC with Office, so they are skipped unless `--run-powerpoint` is given. CI never
passes it.
"""

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--run-powerpoint",
        action="store_true",
        default=False,
        help="also run the tests marked 'powerpoint' (they drive the desktop PowerPoint through COM)",
    )


def pytest_collection_modifyitems(config, items):
    if config.getoption("--run-powerpoint"):
        return
    skip = pytest.mark.skip(reason="drives PowerPoint through COM: pass --run-powerpoint to run it")
    for item in items:
        if "powerpoint" in item.keywords:
            item.add_marker(skip)
