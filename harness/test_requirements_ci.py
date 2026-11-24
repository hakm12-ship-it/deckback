"""harness/requirements-ci.txt (Linux CI) against harness/requirements.lock.txt (ruling M1-R67).

The oracle ratchet's ground truth depends on the MuPDF version, so every package the CI file lists is pinned to exactly
the locked version. The CI file holds the packages the global constraints name, everything else the lock has (so pip
on CI cannot pick a newer dependency), and no PowerPoint pieces.
"""

import re
from pathlib import Path

HARNESS = Path(__file__).resolve().parent
REQUIRED = {"pymupdf", "python-pptx", "numpy", "scipy", "pillow", "fonttools", "pytest"}
NOT_ON_LINUX = {"colorama"}  # pytest's Windows-only dependency
POWERPOINT_PIECES = {"pywin32", "comtypes", "pywinauto"}


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()  # PEP 503


def pins(path):
    """{canonical name: version} of a requirements file whose every entry is an exact `name==version` pin."""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)", line)
        assert match, f"{path.name}: not an exact pin: {line!r}"
        name = canonical(match.group(1))
        assert name not in out, f"{path.name}: {name} is listed twice"
        out[name] = match.group(2)
    return out


def test_ci_requirements_pin_exactly_the_locked_versions():
    lock = pins(HARNESS / "requirements.lock.txt")
    ci = pins(HARNESS / "requirements-ci.txt")
    assert REQUIRED <= set(ci)
    assert {name: (version, lock.get(name)) for name, version in ci.items() if lock.get(name) != version} == {}
    assert set(lock) - set(ci) <= NOT_ON_LINUX
    assert not set(ci) & POWERPOINT_PIECES


def readme_install_problems(text):
    """The venv setup of harness/README.md installs the lock (minor m17): pip install -r the lock file, never the
    unpinned requirements.txt."""
    installs = [line for line in text.splitlines() if "pip install -r" in line]
    problems = [] if installs else ["no `pip install -r` line"]
    problems += [f"installs something else than the lock: {line.strip()}" for line in installs
                 if "harness/requirements.lock.txt" not in line]
    return problems


def test_the_readme_sets_the_venv_up_from_the_lock():
    assert readme_install_problems((HARNESS / "README.md").read_text(encoding="utf-8")) == []
    assert readme_install_problems("python -m pip install -r harness/requirements.txt") != []
