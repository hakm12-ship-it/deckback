"""The PowerPoint module's default time limit, for the Python code that waits for a PowerPoint script (minor m18).

harness/ppt/DeckbackCom.psm1 (`Get-DeckbackTimeout`) gives every PowerPoint run 120 s plus 4 s per slide unless the
caller passes -TimeoutSec. harness/atlas/export.py and harness/fidelity/run.py wait for their scripts longer than that
(a run may first wait for another deckback run's lock), and take the numbers from here; harness/ppt/test_limits.py
checks that they are the module's.
"""

BASE_SEC = 120
PER_SLIDE_SEC = 4


def module_time_limit(slides):
    """The module's default limit of one PowerPoint run over a deck of `slides` slides, in seconds."""
    return BASE_SEC + PER_SLIDE_SEC * slides
