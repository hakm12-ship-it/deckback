"""The CI workflow (.github/workflows/ci.yml): what runs on GitHub's runner without Office.

- Ruling M1-R76: the local vitest project runs too (`npm run test:local`), with the harness Python as the oracle, so
  the fixture-free walker-vs-oracle contract cases (synthetic pages, Task 1's pattern and approx cases) guard every
  PR; its cases that need a private fixture skip themselves.
- The checkout keeps no credentials in the working copy (`persist-credentials: false`): no later step needs them.
- Ruling M1-R68: the CI log lists every skipped harness test on a line of its own, with its reason
  (`-rs --no-fold-skipped`; plain `-rs` folds skips that share a reason into one line).
"""

from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "ci.yml"


def steps():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]["ci"]["steps"]


def index_of(predicate):
    found = [i for i, step in enumerate(steps()) if predicate(step)]
    assert len(found) == 1, found
    return found[0]


def runs(command):
    return lambda step: str(step.get("run", "")).strip() == command


def test_ci_runs_the_local_vitest_project_with_the_harness_python():
    local = index_of(runs("npm run test:local"))
    step = steps()[local]
    assert step.get("env") == {"DECKBACK_PY": "python"}
    # after the harness dependencies (the oracle needs PyMuPDF), like the corpus ratchet
    assert local > index_of(runs("pip install -r harness/requirements-ci.txt"))
    assert steps()[index_of(runs("npm run test:corpus"))].get("env") == {"DECKBACK_PY": "python"}


def test_checkout_does_not_persist_credentials():
    checkouts = [step for step in steps() if str(step.get("uses", "")).startswith("actions/checkout@")]
    assert len(checkouts) == 1
    assert checkouts[0].get("with", {}).get("persist-credentials") is False


def test_harness_tests_list_every_skipped_test_on_its_own_line():
    command = steps()[index_of(lambda step: str(step.get("run", "")).startswith("python -m pytest harness"))]["run"]
    flags = command.split()
    assert "-rs" in flags and "--no-fold-skipped" in flags
    assert "--run-powerpoint" not in flags


def test_the_corpus_ratchets_run_after_the_validator_is_built():
    # M3 Task 11: the PPTX ratchet (packages/core/test/corpus/pptx-ratchet.corpus.test.ts) validates every committed
    # PDF's PPTX with harness.ooxml.validate, so the corpus step comes after the validator's build step
    corpus = index_of(runs("npm run test:corpus"))
    build = index_of(lambda step: "ensure_built" in str(step.get("run", "")))
    assert corpus > build
    assert "PPTX" in steps()[corpus]["name"]


def test_the_playwright_browser_is_cached_and_installed_without_apt():
    """M2-R32, M5 Task 6: a run lost 8 minutes in the browser step and hit the 15-minute limit. The slow part was apt
    (`--with-deps` fetched 32 MB of fonts at 74 kB/s; the runner image already has Chromium's libraries). So the
    browser is cached, keyed on the installed Playwright's version, installed only on a cache miss, and never through
    apt: the e2e compares bytes and renders no text, so it needs no system fonts."""
    version = index_of(lambda step: step.get("id") == "playwright")
    assert "@playwright/test/package.json" in steps()[version]["run"] and "GITHUB_OUTPUT" in steps()[version]["run"]
    cache = index_of(lambda step: step.get("id") == "playwright-cache")
    cached = steps()[cache]
    assert str(cached["uses"]).startswith("actions/cache@")
    assert cached["with"]["path"] == "~/.cache/ms-playwright"
    assert "${{ steps.playwright.outputs.version }}" in cached["with"]["key"]
    install = index_of(lambda step: "playwright install" in str(step.get("run", "")))
    step = steps()[install]
    assert step["run"].split() == ["npx", "playwright", "install", "chromium"]  # no --with-deps: no apt
    assert step.get("if") == "steps.playwright-cache.outputs.cache-hit != 'true'"
    assert version < cache < install < index_of(runs("npm run e2e"))
    assert index_of(runs("npm ci")) < version
