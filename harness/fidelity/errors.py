"""The one exception the facts readers raise (pdf_facts.page_facts, pptx_facts.slide_facts).

A FactsError says that the input could not be read, never why in a way that names it: its message is the kind of
problem and a short reason ("missing input: no such file", "not a PDF: ...", "page index out of range: 5 (the PDF
has 3 pages)", "unreadable PPTX (KeyError)"), with no file name and no path, because callers may copy it into
results JSON that is committed. It is raised ``from None``, so no underlying exception (whose text may quote a
path) is chained to it.
"""


class FactsError(ValueError):
    """An input PDF page or PPTX slide could not be read; the message names no file and no path."""
