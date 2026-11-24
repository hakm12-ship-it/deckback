// Which requests a producer page may make while make_skia.mjs prints it (scripts/producer-pages.test.mjs tests it).

/**
 * Whether a producer page may load `url`: `data:` and `about:`, and `file:` only on this machine. A `file:` URL that
 * names another host is read over the network, over SMB on Windows, which offers the user's credentials to that host:
 * - one with a host (`file://host/share/...`, also what a protocol-relative `//host/...` becomes in a `file:` page);
 * - one whose host is empty but whose path still reads as a UNC path on Windows: a path that starts with `//`
 *   (`file:////host/...`, `file://///host/...`, `////host/...` in a `file:` page), or that holds a backslash or an
 *   encoded `\` or `/` (`%5C`, `%2F`, any case: `file:///%5C%5Chost/...`).
 * The committed pages load nothing but data: URIs, and a page's own URL (`pathToFileURL`) has none of these.
 */
export function allowedRequest(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'about:') {
    return true;
  }
  if (parsed.protocol !== 'file:' || parsed.host !== '') {
    return false;
  }
  const path = parsed.pathname;
  return !path.startsWith('//') && !/\\|%5c|%2f/i.test(path) && !url.includes('\\');
}
