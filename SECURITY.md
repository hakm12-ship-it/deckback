# Security policy

## Reporting a vulnerability

Please report a security problem **privately**, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Nobody else can see a report made there until it is published. Please do not send decks that contain private text; a description, or a small PDF that you generated yourself, is enough.

We look at every report and answer through the same private thread. This is a small project without a service level, but a report about unsafe handling of an input file is the kind of thing we take first.

## What counts

deckback reads PDFs that someone else made, so the interesting problems are in how it reads them:

- a crafted PDF that makes the converter run for very long, use unbounded memory, or crash the page, the worker or the command line;
- a crafted PDF that makes the converter write a PPTX that is unsafe to open (for example a link or a file reference that should not be there) or that escapes the output path;
- a way to make the converter, the site or the command line send data over the network (the conversion is designed to make no network request);
- a problem in the packaged `deckback` npm package or the site's service worker.

Other bugs, such as a slide that converts badly, are welcome as normal issues; see the known limits in the README first.

## Supported versions

Only the latest release.
