"""The harness's Python layout (global constraints): importable packages run from the repository root, one
`__init__.py` per package (minor m23: harness/spikes, harness/oracle and harness/census were namespace packages)."""

from pathlib import Path

HARNESS = Path(__file__).resolve().parent


def test_every_harness_directory_with_python_code_is_a_package():
    directories = {path.parent for path in HARNESS.rglob("*.py")
                   if ".venv" not in path.parts and "__pycache__" not in path.parts}
    missing = sorted(str(d.relative_to(HARNESS.parent)).replace("\\", "/") for d in directories
                     if not (d / "__init__.py").is_file())
    assert missing == []


def test_the_spike_and_census_tests_import_their_modules_through_the_package():
    # A test module of a package is imported as harness.<pkg>.test_x, so its directory is not on sys.path: a bare
    # sibling import (`import pptx_xml`) would only work by accident.
    for name in ("spikes/test_pptx_xml.py", "spikes/test_regiondiff.py", "spikes/test_m0_5_fillrule.py",
                 "spikes/test_m0_6_gradient.py", "census/test_producers.py"):
        text = (HARNESS / name).read_text(encoding="utf-8")
        assert "sys.path.insert" not in text, name
        assert "from harness." in text, name
