// Guard: refuses binary, office and font files, whatever they are called.
// Local-only fixtures embed font subsets (some of them Microsoft's) and must never reach the repository.
//
//   node scripts/check-no-binaries.mjs         checks what is staged (this is the pre-commit hook)
//   node scripts/check-no-binaries.mjs --all   checks every tracked file (CI, and a one-off audit)
//
// Both modes judge what git holds (the index), never the working-tree copy: a commit contains the index, and
// the working tree can differ from it (an edit after `git add`, `git add -p`, a deleted or overwritten file).
//
// A file is refused when
//   1. its extension is on the list below, or
//   2. its first bytes are the signature of a PDF, ZIP/Office/OLE2, image or font file, whatever the name, or
//   3. it sits under corpus/generated/ and is over 3 MB, or the directory is over 12 MB in total.
// corpus/generated/ may hold .pdf, .pptx, .png (only if the bytes really are that type), .md and .json (plain
// text, no binary signature). Every other file there is refused.
// One exception to 1 and 2, by path and content: the comparison pictures of the README (IMAGE_ALLOWLIST below, from
// scripts/make-comparison-images.py: our own CC0 atlas deck, never a tier-B or private deck). A listed path passes
// only when the SHA-256 of its whole content is the listed one; any other .png, anywhere, is refused as before.
//
// The check fails closed: a file whose content or size cannot be read is refused, and if git cannot deliver an
// object the script exits 1 with the reason instead of passing.
//
// Exit 0 = fine, 1 = something refused (one file path per line on stdout, every reason on stderr),
// 2 = bad usage. Over the 12 MB total is a fact about the directory, not a file: stderr only, exit 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REJECTED_EXTENSIONS = new Set([
  '.pdf',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.fntdata',
  '.eot',
  '.ttc',
  '.otc',
  '.pfb',
  '.pfa',
  '.cff',
  '.ppt',
  '.ppsx',
  '.potx',
  '.pps',
  '.key',
  '.gif',
  '.bmp',
  '.webp',
  '.tif',
  '.tiff',
  '.emf',
  '.wmf',
  '.zip',
  '.docx',
  '.xlsx',
  '.hwp',
  '.hwpx',
]);

/**
 * The only images the repository may hold: path -> SHA-256 of the file. Make them with scripts/make-comparison-images.py,
 * which prints both. Each is under 300 KB and shows only the generated, CC0 atlas deck.
 */
export const IMAGE_ALLOWLIST = new Map([
  ['docs/images/compare-fills.png', 'afaa34161abad1cc8ba878b6719f75e6038f56f40fe1e0c897949ab78a75cda4'],
  ['docs/images/compare-shapes.png', 'fb4671fd8c352d1fab9a3d20fbeb5359826fca2c22a50cdb0115a56b767a9553'],
  ['docs/images/compare-table.png', 'cee543f209220aa3689a9facb078afb77af6440c00ad8927c8b01cbaddc9f4d1'],
  ['docs/images/compare-text.png', 'd576e1a8b5f54306b5378db882dd34d70afa1d3074385ec800c9093b418a34b3'],
]);

/** How many leading bytes `readHead` hands over. The furthest signature byte is the EOT magic at 34-35. */
export const HEAD_BYTES = 36;

// --- signatures: opening bytes that identify a binary format at any file name ---------------------

const at = (offset, ...bytes) => (head) => bytes.every((byte, i) => head[offset + i] === byte);
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const startsWith = (...bytes) => at(0, ...bytes);
const all = (...tests) => (head) => tests.every((test) => test(head));
const u32le = (head, offset) =>
  head.length >= offset + 4 ? (head[offset] | (head[offset + 1] << 8) | (head[offset + 2] << 16) | (head[offset + 3] << 24)) >>> 0 : null;

// A bare "true" or "BM" is also how ordinary text can start ("true story", "BM25 results"), so those two need more:
// sfnt = signature + numTables (u16 at byte 4) of at least 1; BMP = "BM" + a known DIB header size (u32 at byte 14).
const SFNT_TABLES = (head) => head[4] === 0 && head[5] >= 1;
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

// `kind` ties a signature to what the corpus/generated/ exception allows. Not covered on purpose: a bare CFF
// (no container) has no usable signature of its own; the .cff extension catches it by name.
const SIGNATURES = [
  { kind: 'pdf', label: 'a PDF', test: startsWith(...ascii('%PDF-')) },
  { kind: 'zip', label: 'a ZIP/Office archive', test: startsWith(0x50, 0x4b, 0x03, 0x04) },
  { kind: 'ole2', label: 'an OLE2 file (.doc/.xls/.ppt/.hwp)', test: startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) },
  { kind: 'png', label: 'a PNG image', test: startsWith(0x89, 0x50, 0x4e, 0x47) },
  { kind: 'jpeg', label: 'a JPEG image', test: startsWith(0xff, 0xd8, 0xff) },
  { kind: 'gif', label: 'a GIF image', test: startsWith(...ascii('GIF8')) },
  { kind: 'webp', label: 'a WebP image', test: all(startsWith(...ascii('RIFF')), at(8, ...ascii('WEBP'))) },
  {
    kind: 'tiff',
    label: 'a TIFF image',
    test: (head) => startsWith(0x49, 0x49, 0x2a, 0x00)(head) || startsWith(0x4d, 0x4d, 0x00, 0x2a)(head),
  },
  {
    kind: 'bmp',
    label: 'a BMP image',
    test: all(startsWith(...ascii('BM')), (head) => BMP_DIB_SIZES.has(u32le(head, 14))),
  },
  { kind: 'sfnt', label: 'a TrueType/OpenType font', test: all(startsWith(0x00, 0x01, 0x00, 0x00), SFNT_TABLES) },
  { kind: 'sfnt', label: 'an OpenType font', test: all(startsWith(...ascii('OTTO')), SFNT_TABLES) },
  { kind: 'sfnt', label: 'a TrueType font', test: all(startsWith(...ascii('true')), SFNT_TABLES) },
  { kind: 'ttc', label: 'a font collection', test: startsWith(...ascii('ttcf')) },
  { kind: 'woff', label: 'a WOFF font', test: startsWith(...ascii('wOFF')) },
  { kind: 'woff2', label: 'a WOFF2 font', test: startsWith(...ascii('wOF2')) },
  { kind: 'pfb', label: 'a Type 1 (PFB) font', test: startsWith(0x80, 0x01) },
  { kind: 'pfa', label: 'a Type 1 (PFA) font', test: startsWith(...ascii('%!PS-AdobeFont')) },
  { kind: 'eot', label: 'an EOT font', test: at(34, 0x4c, 0x50) }, // "LP" magic number in the EOT header
];

// Files generated from source by the test corpus builders live here. Sizes are binary megabytes (MiB).
// extension -> the signature kind the bytes must have; null = plain text, no signature is acceptable.
export const GENERATED_DIR = 'corpus/generated/';
export const MAX_GENERATED_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_GENERATED_TOTAL_BYTES = 12 * 1024 * 1024;
const GENERATED_ALLOWED = new Map([
  ['.pdf', 'pdf'],
  ['.pptx', 'zip'],
  ['.png', 'png'],
  ['.md', null],
  ['.json', null],
]);

const mb = (bytes) => `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
// Exact bytes too: 12 MB plus a few bytes would otherwise read as "12 MB is over 12 MB".
const sized = (bytes) => `${mb(bytes)} (${bytes} bytes)`;

/** @param {Uint8Array} head @returns {{kind: string, label: string} | null} */
function matchSignature(head) {
  return SIGNATURES.find(({ test }) => test(head)) ?? null;
}

// --- default readers: the working-tree file, for callers of findRejected that bring none ---------

/** Null for anything that is not a plain existing file (gone, a directory, a link). */
function workingTreeReaders(root) {
  const stat = (p) => {
    try {
      const info = lstatSync(path.join(root, p)); // lstat: a link is never followed out of the repository
      return info.isFile() ? info : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  return {
    readHead(p) {
      if (!stat(p)) return null;
      const fd = openSync(path.join(root, p), 'r');
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
      } finally {
        closeSync(fd);
      }
    },
    sizeOf: (p) => stat(p)?.size ?? null,
    hashOf(p) {
      return stat(p) ? createHash('sha256').update(readFileSync(path.join(root, p))).digest('hex') : null;
    },
  };
}

const cwdReaders = workingTreeReaders('.');

const normalize = (p) => path.posix.normalize(p);
const inGeneratedDir = (normalized) => normalized.startsWith(GENERATED_DIR);
const extensionOf = (normalized) => path.posix.extname(normalized).toLowerCase();

/** Why the name alone refuses this path, or null. */
function extensionProblem(normalized) {
  const ext = extensionOf(normalized);
  if (inGeneratedDir(normalized)) {
    return GENERATED_ALLOWED.has(ext) ? null : `only .pdf, .pptx, .png, .md and .json files may be in ${GENERATED_DIR}`;
  }
  return REJECTED_EXTENSIONS.has(ext) ? `${ext} files are not allowed` : null;
}

/** False for a path the name alone already refuses, so its content need not be fetched. */
export function needsContentCheck(p) {
  return extensionProblem(normalize(p)) === null;
}

/**
 * @typedef {{ path: string, reason: string, directory?: true }} Violation
 *   `directory` marks a fact about corpus/generated/ as a whole (the 12 MB total), which is not a file path.
 *
 * @typedef {object} CheckOptions
 * @property {(path: string) => number | null} [sizeOf]
 *   size in bytes, null when unknown (default: the working-tree file). Unknown is refused for files in corpus/generated/.
 * @property {string[]} [generatedPaths]
 *   every file the repository holds under corpus/generated/, for the 12 MB total (default: those among `paths`).
 * @property {ReadonlyMap<string, string>} [allowlist]
 *   path -> SHA-256 of the whole file that may be committed whatever its type (default: IMAGE_ALLOWLIST).
 * @property {(path: string) => string | null} [hashOf]
 *   SHA-256 (hex) of the whole content of a path, null when it cannot be read (default: the working-tree file). Asked only for allowlisted paths.
 * @property {(path: string) => boolean} [contentless]
 *   paths with no file content to inspect (a symlink holds its target text, a submodule is a commit): only the
 *   name is checked.
 */

/**
 * Everything wrong with `paths`, with the reason, then the 12 MB total if exceeded. Fails closed: a path whose
 * content (or, in corpus/generated/, size) is unknown is a violation, not a pass.
 * @param {string[]} paths git-style (forward slash, repo-relative) paths
 * @param {(path: string) => Uint8Array | null} [readHead] first HEAD_BYTES of a file; null = could not be read
 * @param {CheckOptions} [options]
 * @returns {Violation[]}
 */
export function findViolations(paths, readHead = cwdReaders.readHead, options = {}) {
  const sizeOf = options.sizeOf ?? cwdReaders.sizeOf;
  const contentless = options.contentless ?? (() => false);
  const allowlist = options.allowlist ?? IMAGE_ALLOWLIST;
  const hashOf = options.hashOf ?? cwdReaders.hashOf;
  const violations = [];

  for (const p of paths) {
    const listed = allowlist.get(p); // exact path only: no normalising, so no other spelling of it gets in
    if (listed !== undefined && !contentless(p)) {
      const actual = hashOf(p);
      if (actual === null) violations.push({ path: p, reason: 'it is on the image allowlist but its content could not be read' });
      else if (actual !== listed) violations.push({ path: p, reason: `it is on the image allowlist but its content differs (SHA-256 ${actual})` });
      continue;
    }
    const reason = refusalReason(p, readHead, sizeOf, contentless(p));
    if (reason) violations.push({ path: p, reason });
  }

  const generated = new Set((options.generatedPaths ?? paths).map(normalize).filter(inGeneratedDir));
  let total = 0;
  for (const p of generated) total += sizeOf(p) ?? 0;
  if (total > MAX_GENERATED_TOTAL_BYTES) {
    violations.push({
      path: GENERATED_DIR,
      reason: `holds ${sized(total)} in total, over the ${sized(MAX_GENERATED_TOTAL_BYTES)} limit`,
      directory: true,
    });
  }
  return violations;
}

/**
 * The files among `paths` that must not be committed. The 12 MB directory total is not a file, so it is not
 * listed here; findViolations reports it (and so does the command line, on stderr).
 * @param {string[]} paths git-style (forward slash, repo-relative) paths
 * @param {(path: string) => Uint8Array | null} [readHead] first HEAD_BYTES of a file (default: the working-tree file); null = could not be read, which is a rejection
 * @param {CheckOptions} [options]
 */
export function findRejected(paths, readHead, options) {
  return findViolations(paths, readHead, options)
    .filter((violation) => !violation.directory)
    .map(({ path: p }) => p);
}

function refusalReason(p, readHead, sizeOf, contentless) {
  const normalized = normalize(p);
  const byName = extensionProblem(normalized);
  if (byName) return byName;
  if (contentless) return null;

  if (inGeneratedDir(normalized)) {
    const size = sizeOf(p);
    if (size === null) return 'its size could not be read';
    if (size > MAX_GENERATED_FILE_BYTES) {
      return `${sized(size)} is over the ${mb(MAX_GENERATED_FILE_BYTES)} limit for a file in ${GENERATED_DIR}`;
    }
  }

  const head = readHead(p);
  if (!head) return 'its content could not be read';
  const found = matchSignature(head);
  const allowed = inGeneratedDir(normalized) ? GENERATED_ALLOWED.get(extensionOf(normalized)) : null;
  if (!found || found.kind === allowed) return null;
  return `the content is ${found.label}, whatever its name`;
}

// --- where the paths and their content come from ----------------------------------------

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// -z everywhere: raw NUL-separated paths. Without it git quotes unusual names ("a\"b.pdf"), which would hide the extension.
const nulList = (text) => text.split('\0').filter(Boolean);

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

/** Staged additions, copies, modifications, renames and type changes (not deletions), as root-relative paths. */
function stagedPaths(root) {
  return nulList(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']));
}

/** The index: path -> { mode, oid } of what git holds. Unmerged entries are ignored. */
function indexEntries(root) {
  const entries = new Map();
  for (const record of nulList(git(root, ['ls-files', '-s', '-z']))) {
    const tab = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (stage === '0') entries.set(record.slice(tab + 1), { mode, oid });
  }
  return entries;
}

/**
 * Size and first bytes of the given blobs, from one `git cat-file --batch`. The content streams past and
 * is dropped: only HEAD_BYTES per blob are kept, so a huge file costs time, not memory. An oid git cannot
 * deliver as a blob is simply absent from the result; the caller must check.
 * @param {string} root
 * @param {string[]} oids
 * @returns {Promise<Map<string, { size: number, head: Buffer }>>}
 */
function readBlobs(root, oids) {
  return new Promise((resolve, reject) => {
    const blobs = new Map();
    if (oids.length === 0) {
      resolve(blobs);
      return;
    }
    const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    child.stdin.on('error', () => {}); // a git that died early shows up as a non-zero exit below
    child.stdin.end(`${oids.join('\n')}\n`);

    let headerBytes = Buffer.alloc(0); // a header line split across chunks
    /** @type {{ oid: string, isBlob: boolean, size: number, seen: number, left: number, head: Buffer[], headLength: number } | null} */
    let current = null;

    child.stdout.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (current === null) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline === -1) {
            headerBytes = Buffer.concat([headerBytes, chunk.subarray(offset)]);
            return;
          }
          const line = Buffer.concat([headerBytes, chunk.subarray(offset, newline)]).toString('latin1');
          headerBytes = Buffer.alloc(0);
          offset = newline + 1;
          const [oid, type, size] = line.split(' ');
          if (type === 'missing') continue; // nothing follows a "missing" line
          // header "<oid> <type> <size>", then <size> bytes of content, then one LF
          current = { oid, isBlob: type === 'blob', size: Number(size), seen: 0, left: Number(size) + 1, head: [], headLength: 0 };
        }
        const take = Math.min(current.left, chunk.length - offset);
        const content = Math.min(take, current.size - current.seen); // the last byte of a record is the LF
        const keep = Math.min(content, HEAD_BYTES - current.headLength);
        if (keep > 0) {
          current.head.push(chunk.subarray(offset, offset + keep));
          current.headLength += keep;
        }
        current.seen += content;
        current.left -= take;
        offset += take;
        if (current.left === 0) {
          if (current.isBlob) blobs.set(current.oid, { size: current.size, head: Buffer.concat(current.head) });
          current = null;
        }
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || current !== null) {
        reject(new Error(`git cat-file --batch failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ''}`));
      } else {
        resolve(blobs);
      }
    });
  });
}

// --- command line ----------------------------------------------------------------

/**
 * Checks `selectPaths(index)` against the blobs git holds for them (never the working tree). The 12 MB total is
 * taken over the whole index under corpus/generated/, so files committed earlier count.
 * Symlinks (120000) and submodules (160000) have no file content to inspect: only their names are checked.
 * Throws when git cannot deliver the object of a path that needs inspecting.
 * @param {string} root
 * @param {(index: Map<string, { mode: string, oid: string }>) => string[]} selectPaths
 */
async function checkIndex(root, selectPaths) {
  const index = indexEntries(root);
  const entryOf = (p) => {
    const entry = index.get(p);
    if (!entry) throw new Error(`${p} is not in the index`);
    return entry;
  };
  const contentless = (p) => entryOf(p).mode === '120000' || entryOf(p).mode === '160000';

  const paths = selectPaths(index);
  const generated = [...index.keys()].filter((p) => inGeneratedDir(normalize(p)));
  const wanted = [...new Set([...paths.filter(needsContentCheck), ...generated])].filter((p) => !contentless(p));
  const blobs = await readBlobs(root, [...new Set(wanted.map((p) => entryOf(p).oid))]);
  for (const p of wanted) {
    if (!blobs.has(entryOf(p).oid)) throw new Error(`cannot read ${p} (object ${entryOf(p).oid} is missing from the repository)`);
  }
  const blobOf = (p) => blobs.get(entryOf(p).oid) ?? null;
  // the whole blob of an allowlisted picture is hashed (a few hundred KB at most); null = git could not deliver it
  const hashOf = (p) => {
    try {
      const data = execFileSync('git', ['cat-file', 'blob', entryOf(p).oid], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      return createHash('sha256').update(data).digest('hex');
    } catch {
      return null;
    }
  };
  return findViolations(paths, (p) => blobOf(p)?.head ?? null, {
    hashOf,
    sizeOf: (p) => blobOf(p)?.size ?? null,
    generatedPaths: generated,
    contentless,
  });
}

async function main(args) {
  const unknown = args.filter((arg) => arg !== '--all');
  if (unknown.length > 0) {
    console.error(`check-no-binaries: unknown argument ${unknown.join(' ')}\nusage: node scripts/check-no-binaries.mjs [--all]`);
    return 2;
  }
  const all = args.includes('--all');
  const root = repoRoot();
  const violations = await checkIndex(root, all ? (index) => [...index.keys()] : () => stagedPaths(root));
  if (violations.length === 0) return 0;

  for (const { path: p, directory } of violations) if (!directory) console.log(p);
  const what = all ? 'tracked' : 'staged';
  console.error(`\ncheck-no-binaries: ${violations.length} ${what} problem(s) cannot be committed:`);
  for (const { path: p, reason } of violations) console.error(`  ${p}: ${reason}`);
  console.error(
    `Keep local fixtures in corpus/private/ (gitignored); only ${GENERATED_DIR} may hold generated .pdf, .pptx and .png files (plus .md and .json), ` +
      `up to ${mb(MAX_GENERATED_FILE_BYTES)} each and ${mb(MAX_GENERATED_TOTAL_BYTES)} in total.`,
  );
  return 1;
}

/**
 * True when the module at `selfUrl` is the program being run (`entry` is process.argv[1]).
 * The URLs are compared first. Node resolves symlinks and junctions in import.meta.url but not in
 * process.argv[1], so otherwise the real paths are compared; without that main() would silently never
 * run when the script is reached through a link. An entry that is not a file (node -e, a REPL) is
 * simply not main. Any other error is rethrown: this must never answer "not main" by accident and exit 0.
 */
export function isMainModule(entry, selfUrl, realpath = realpathSync) {
  if (!entry) return false;
  if (pathToFileURL(entry).href === selfUrl) return true;
  const real = (p) => {
    try {
      return realpath(p);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const entryReal = real(entry);
  return entryReal !== null && entryReal === real(fileURLToPath(selfUrl));
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Fail closed: if the check cannot run, the commit does not go through.
    console.error(`check-no-binaries: could not complete the check: ${error.message}`);
    process.exitCode = 1;
  }
}
