"""Make a saved .pptx byte-stable: the same deck content always gives the same file bytes.

python-pptx stamps every zip entry with the current time and keeps the template's core-properties dates. Rewriting
the container with fixed entry dates (1980-01-01, the earliest zip date), sorted entries ([Content_Types].xml first),
fixed `docProps/core.xml` dates and fixed per-entry metadata removes every volatile value.

Embedded OOXML packages are normalized the same way, recursively: python-pptx embeds each chart's data as an .xlsx
written by XlsxWriter, whose `docProps/core.xml` carries the build time.
"""

import io
import os
import zipfile
from pathlib import Path

from lxml import etree

FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
FIXED_W3CDTF = "1980-01-01T00:00:00Z"
CONTENT_TYPES = "[Content_Types].xml"
CORE = "docProps/core.xml"
COMPRESS_LEVEL = 6
EMBEDDED_PACKAGES = (".xlsx", ".xlsm", ".docx", ".pptx")
ZIP_SIGNATURE = b"PK\x03\x04"
_DATE_TAGS = (
    "{http://purl.org/dc/terms/}created",
    "{http://purl.org/dc/terms/}modified",
    "{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastPrinted",
)


def _fixed_core(xml):
    root = etree.fromstring(xml)
    for element in root:
        if element.tag in _DATE_TAGS:
            element.text = FIXED_W3CDTF
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _is_embedded_package(name, data):
    return name.lower().endswith(EMBEDDED_PACKAGES) and data[:4] == ZIP_SIGNATURE


def normalized_package(data, label="package"):
    """The bytes of an OOXML zip package rewritten with fixed dates, entry order and metadata (recursively for the
    packages embedded in it)."""
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        entries = [(info.filename, source.read(info)) for info in source.infolist()]
    names = [name for name, _ in entries]
    if len(set(names)) != len(names):
        raise ValueError(f"{label}: duplicate zip entries")
    entries.sort(key=lambda entry: (entry[0] != CONTENT_TYPES, entry[0]))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as target:
        for name, content in entries:
            if name == CORE:
                content = _fixed_core(content)
            elif _is_embedded_package(name, content):
                content = normalized_package(content, f"{label}/{name}")
            info = zipfile.ZipInfo(name, FIXED_DATE_TIME)
            info.create_system = 0  # the default depends on the OS that writes the file
            info.external_attr = 0
            target.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=COMPRESS_LEVEL)
    return buf.getvalue()


def normalize_pptx(path):
    """Rewrite the .pptx at `path` in place with fixed dates and entry order; return the path."""
    path = Path(path)
    data = normalized_package(path.read_bytes(), path.name)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return path
