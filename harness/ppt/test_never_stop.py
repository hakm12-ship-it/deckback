"""The never-stop rule on the Python side (minor m6): nothing in the harness ends a process, and a Python caller of a
script that drives PowerPoint never lets subprocess end it when a time limit passes.

harness/ppt/test_com_module.ps1 checks this for every harness file, but only when it is run by hand on Windows. The
checks for Python files run here, also on CI (no PowerPoint, no PowerShell):

- check (d) of test_com_module.ps1 for Python files: none of its process-ending calls or commands in the code (comment
  lines are skipped, strings are not);
- subprocess.run / call / check_call / check_output with a ``timeout=`` (which kills the child when it passes) never runs
  a script that drives PowerPoint (a harness .ps1 that loads DeckbackCom.psm1) or a PowerShell script it cannot name:
  such callers use never_stop.run_script (Popen.communicate with a limit; the script is left running).
"""

import ast
import re
import subprocess
import sys
from pathlib import Path

import pytest

from harness.ppt import never_stop

HARNESS = Path(__file__).resolve().parents[1]
KW, TM = "ki" + "ll", "termi" + "nate"  # built from pieces, so that this file does not match its own patterns
END_PATTERNS = (
    rf"(?i)(?<![\w.]){KW}\s*\(",
    rf"(?i)\.\s*({KW}|{TM})\s*\(",
    rf"(?i)(?<![\w-])(task{KW}|ps{KW}|ts{KW}|sp" + rf"ps|Stop-Pro" + rf"cess)(?![\w-])",
    rf"(?i)Invoke-(Cim|Wmi)Method\b[^\r\n]*\b{TM}\b",
    rf"(?i){TM}Process",
)
RUN_CALLS = {"run", "call", "check_call", "check_output"}


def code_text(text):
    """Python code without its comment lines (as check (d) reads it: strings stay)."""
    return re.sub(r"(?m)^[ \t]*#.*$", "", text)


def python_files():
    return sorted(p for p in HARNESS.rglob("*.py") if not {".venv", "__pycache__"} & set(p.parts))


def powerpoint_scripts(harness=HARNESS):
    """File names (lower case) of the harness scripts that drive PowerPoint: every .ps1 that loads DeckbackCom.psm1."""
    return {p.name.lower() for p in harness.rglob("*.ps1")
            if ".venv" not in p.parts and "DeckbackCom.psm1" in p.read_text(encoding="utf-8", errors="replace")}


def script_names(trees):
    """Module-level name -> the .ps1 file names (lower case) it is bound to, over every given module."""
    names = {}
    for tree in trees:
        for node in tree.body:
            if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
                continue
            scripts = {Path(c.value).name.lower() for c in ast.walk(node.value)
                       if isinstance(c, ast.Constant) and isinstance(c.value, str) and c.value.lower().endswith(".ps1")}
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and scripts:
                    names.setdefault(target.id, set()).update(scripts)
    return names


def end_problems(source):
    text = code_text(source)
    return [f"ends a process ({match.group(0)!r})" for pattern in END_PATTERNS
            for match in [re.search(pattern, text)] if match]


def timeout_problems(tree, names, driving):
    """subprocess.run / call / check_call / check_output calls with timeout= on a PowerPoint-driving script, or on a
    PowerShell script whose name cannot be resolved."""
    problems = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in RUN_CALLS
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"
                and any(keyword.arg == "timeout" for keyword in node.keywords)):
            continue
        constants = [c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)]
        idents = ({c.id for c in ast.walk(node) if isinstance(c, ast.Name)}
                  | {c.attr for c in ast.walk(node) if isinstance(c, ast.Attribute)})
        scripts = {Path(c).name.lower() for c in constants if c.lower().endswith(".ps1")}
        for ident in idents:
            scripts |= names.get(ident, set())
        powershell = any("powershell" in c.lower() for c in constants)
        if scripts & driving or (powershell and not scripts):
            problems.append(f"line {node.lineno}: subprocess.{node.func.attr}(..., timeout=...) runs a script that "
                            "drives PowerPoint (or one it cannot name) and would end it when the limit passes; use "
                            "harness.ppt.never_stop.run_script")
    return problems


def test_no_harness_python_file_ends_a_process_or_a_powerpoint_script():
    files = python_files()
    trees = {path: ast.parse(path.read_text(encoding="utf-8"), filename=str(path)) for path in files}
    names, driving = script_names(trees.values()), powerpoint_scripts()
    assert {"render.ps1", "export.ps1", "m0_7_make_deck.ps1"} <= driving
    assert names.get("RENDER") == {"render.ps1"} and "export.ps1" in names.get("EXPORT_PS1", set())
    problems = []
    for path in files:
        rel = path.relative_to(HARNESS.parent).as_posix()
        problems += [f"{rel}: {p}" for p in end_problems(path.read_text(encoding="utf-8"))]
        problems += [f"{rel}: {p}" for p in timeout_problems(trees[path], names, driving)]
    assert problems == []


@pytest.mark.parametrize("source, flagged", [
    (f"import subprocess\nproc = subprocess.Popen(['x'])\nproc.{KW}()\n", True),
    (f"import os\nos.{KW}(1, 9)\n", True),
    (f"import subprocess\nsubprocess.run(['task{KW}', '/im', 'x.exe'])\n", True),
    (f"# never call proc.{KW}() or .{TM}() here\nprint('not {KW}ed')\n", False),
    (f"skill = 3\nprint(skill)\n", False),
])
def test_the_end_rule_itself(source, flagged):
    assert bool(end_problems(source)) is flagged


DRIVING = {"render.ps1", "export.ps1"}


@pytest.mark.parametrize("source, flagged", [
    # a PowerPoint-driving script run with a time limit: subprocess kills it when the limit passes
    ('RENDER = REPO / "harness" / "ppt" / "render.ps1"\n'
     'subprocess.run(["powershell.exe", "-File", str(RENDER)], capture_output=True, timeout=600)\n', True),
    ('subprocess.check_output(["powershell", "-File", str(export.EXPORT_PS1)], timeout=5)\n', True),
    ('subprocess.call(["powershell.exe", "-File", "harness/atlas/export.ps1"], timeout=5)\n', True),
    ('subprocess.run(["powershell.exe", "-File", str(script)], timeout=5)\n', True),  # cannot tell: flagged
    # no limit, a limit kept by Popen.communicate, a script that does not drive PowerPoint, no PowerShell at all
    ('RENDER = REPO / "harness" / "ppt" / "render.ps1"\nsubprocess.run(["powershell.exe", "-File", str(RENDER)])\n',
     False),
    ('process = subprocess.Popen(["powershell.exe", "-File", str(RENDER)])\nprocess.communicate(timeout=600)\n', False),
    ('SCRIPT = Path(__file__).with_name("install-fonts.ps1")\n'
     'subprocess.run(["powershell.exe", "-File", str(SCRIPT)], timeout=180)\n', False),
    ('subprocess.run(["node", "--version"], capture_output=True, timeout=30)\n', False),
])
def test_the_timeout_rule_itself(source, flagged):
    tree = ast.parse(source)
    names = script_names([tree, ast.parse('EXPORT_PS1 = Path(__file__).with_name("export.ps1")\n')])
    assert bool(timeout_problems(tree, names, DRIVING)) is flagged


def test_run_script_returns_the_scripts_output():
    done = never_stop.run_script([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); "
                                                        "sys.exit(3)"], 60)
    assert (done.returncode, done.stdout.strip(), done.stderr.strip()) == (3, "out", "err")


def test_run_script_leaves_a_script_that_overruns_running(monkeypatch):
    class Overrun:
        def __init__(self, command, **kwargs):
            self.command, self.pid, self.calls = command, 4242, []

        def communicate(self, timeout=None):
            raise subprocess.TimeoutExpired(self.command, timeout)

        def __getattr__(self, name):  # any other method (the ones that end a process among them) is recorded
            return lambda *args, **kwargs: self.calls.append(name)

    monkeypatch.setattr(never_stop.subprocess, "Popen", Overrun)
    before = list(never_stop.ABANDONED)
    with pytest.raises(never_stop.LeftRunning, match="left running, nothing was stopped"):
        never_stop.run_script(["powershell.exe", "-File", "render.ps1"], 5)
    child = never_stop.ABANDONED[-1]
    assert isinstance(child, Overrun) and child.calls == []
    never_stop.ABANDONED[:] = before
