"""Prints e2e/jpx-sample.ts for apps/web: a 16 x 16 JPEG 2000 image (JP2, lossless) as base64 text.

apps/web/e2e/site-fixtures.ts embeds it in a PDF (`jpxPdf`) to check, under the real Content-Security-Policy, that a deck
with a JPXDecode image converts to Node's bytes with 0 violations. Pillow (OpenJPEG) is needed, so the output is
committed as text and CI needs no Python:

    harness/.venv/Scripts/python harness/producers/make_jpx_sample.py > apps/web/e2e/jpx-sample.ts
"""
import base64
import io

from PIL import Image

image = Image.new("RGB", (16, 16))
for x in range(16):
    for y in range(16):
        image.putpixel((x, y), (x * 16, y * 16, 128))
out = io.BytesIO()
image.save(out, "JPEG2000", irreversible=False, num_resolutions=1)
data = out.getvalue()
print("/** A 16 x 16 JPEG 2000 (JP2) image, as base64. Made by harness/producers/make_jpx_sample.py: do not edit. */")
print(f"export const JPX_SAMPLE_BASE64 = '{base64.b64encode(data).decode()}';")
