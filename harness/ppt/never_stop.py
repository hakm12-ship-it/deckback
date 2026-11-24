"""Running a harness script that drives PowerPoint from Python without ever ending it (minor m6).

subprocess.run(..., timeout=...) kills the child when the limit passes, and a script ended in the middle cannot close
the presentation it opened or quit the PowerPoint it started (harness/README.md). ``run_script`` waits with
Popen.communicate(timeout=...) instead: when the limit passes it leaves the script running, keeps a reference to it
(ABANDONED, so that Python does not warn about it) and raises LeftRunning. Nothing here ends a process.
harness/ppt/test_never_stop.py checks that no harness Python file runs such a script with subprocess.run / call /
check_call / check_output and a timeout.

    run_script(command, limit) -> subprocess.CompletedProcess (text stdout and stderr)
"""

import subprocess

ABANDONED = []


class LeftRunning(RuntimeError):
    """The script did not finish within the limit; it was left running."""


def run_script(command, limit):
    """Run `command` (stdin empty, stdout and stderr read as text) and wait at most `limit` seconds for it."""
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, errors="replace")
    try:
        stdout, stderr = process.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        ABANDONED.append(process)
        raise LeftRunning(f"the script (process {process.pid}) did not finish within {limit} s; it was left running, "
                          "nothing was stopped") from None
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
