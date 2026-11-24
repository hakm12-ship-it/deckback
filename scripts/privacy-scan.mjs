// What must not reach a public repository: absolute paths on a PC, user names, names of private decks, tokens and
// e-mail addresses. Used by scripts/release-check.mjs on the tree and on the history.
//
// Names are kept as SHA-256 hashes (PRIVATE_NAME_HASHES), never as words: the list itself is public. A name is
// lower-cased and stripped of everything but letters and digits before it is hashed, and the scan hashes every run
// of one to three words of a line the same way. To add a name:
//
//   node scripts/privacy-scan.mjs --hash "Some Name"      prints the hash to put in the list
//
// A finding never repeats the text it found: only its line, column, kind and an 8-hex fingerprint.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const normalise = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The hash a list entry has: SHA-256 of the name, lower-cased, letters and digits only. */
export const hashName = (name) => sha256(normalise(name));

/**
 * Names from the author's private test decks (fonts that only they use) and the name of the user folder on the
 * author's PC. Hashes only.
 */
export const PRIVATE_NAME_HASHES = new Set([
  'b5deadd803269432096f0b9a8c80719b9af1313a27d262214ff62c4e64e59412', // a font of a private deck
  'a7ae7574e613ad0ccf18b3089206089294bc87feadabad6b202bc74eb58be616', // a font of a private deck (PostScript name)
  '42e680c53c24ceb9d948e829e6a0a22edb8cfad6ac8431edb230d872b9c5d479', // the user folder name of the author's PC
]);

// A Windows drive path (not a URL: the letter must not follow a letter or digit) or a user folder of Linux or macOS.
// Paths that are only made-up examples (tests and docs spell out C:/x/..., /home/x/... to check that such text is
// hidden) are not findings: see isExamplePath.
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?]{2,}/g;
const HOME_PATH = /(?<![\w.])\/(?:Users|home)\/[A-Za-z0-9._-]+/g;

// The first folder of an example path, and the user names of example user folders.
const EXAMPLE_ROOTS = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'abs', 'x', 'fonts', 'docs', 'private', 'secret', 'fakepath', 'py', 'pages', 'slides']);
const EXAMPLE_USERS = new Set(['someone', 'x', 'u', 'user', 'username', 'you', 'me', 'name', 'runner', 'public', 'default', 'all users']);

/** True for a path that is plainly an example: a root folder from EXAMPLE_ROOTS, a user folder of EXAMPLE_USERS, or one bare file or folder at the root. */
function isExamplePath(matched) {
  const parts = matched
    .replace(/^[A-Za-z]:/, '')
    .split(/[\\/]+/)
    .map((part) => part.replace(/[.,;:)\]}]+$/, ''))
    .filter(Boolean);
  const [first = '', second = ''] = parts.map((part) => part.toLowerCase());
  if (parts.length < 2) return true; // "C:/x.css", "C:/deck.pdf", "C:/Users"
  if (first === 'users' || first === 'home') return EXAMPLE_USERS.has(second) || /^\.+$/.test(second);
  return EXAMPLE_ROOTS.has(first);
}

const TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bsbp_[0-9a-f]{40}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// the GitHub noreply addresses, the example domains reserved by RFC 2606, and the address of the co-author line
const ALLOWED_EMAIL = /(?:@users\.noreply\.github\.com|@example\.(?:com|org|net)|^noreply@(?:anthropic|github)\.com)$/i;

// Most words of a text come again and again (JSON keys, code): their verdicts are remembered, which makes a scan of a
// long history several times faster. Bounded, so a very long history cannot grow it without end.
const verdicts = new Map();
const isPrivateName = (joined, nameHashes) => {
  if (nameHashes !== PRIVATE_NAME_HASHES) return nameHashes.has(sha256(joined));
  let verdict = verdicts.get(joined);
  if (verdict === undefined) {
    verdict = nameHashes.has(sha256(joined));
    if (verdicts.size >= 200_000) verdicts.clear();
    verdicts.set(joined, verdict);
  }
  return verdict;
};

const fingerprint = (kind, matched) => sha256(`${kind}\0${matched}`).slice(0, 8);

function* matches(line, pattern) {
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) yield match;
}

function scanLine(line, lineNumber, nameHashes) {
  const found = [];
  const add = (kind, matched, column) => found.push({ line: lineNumber, column: column + 1, kind, fingerprint: fingerprint(kind, matched) });
  for (const pattern of [WINDOWS_PATH, HOME_PATH]) for (const m of matches(line, pattern)) if (!isExamplePath(m[0])) add('absolute-path', m[0], m.index);
  for (const pattern of TOKENS) for (const m of matches(line, pattern)) add('token', m[0], m.index);
  for (const m of matches(line, EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) add('email', m[0], m.index);

  if (nameHashes.size > 0) {
    const words = [...line.matchAll(/[\p{L}\p{N}]+/gu)];
    for (let i = 0; i < words.length; i += 1) {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
        const run = words.slice(i, i + n);
        const joined = run.map((w) => w[0]).join('').toLowerCase();
        if (isPrivateName(joined, nameHashes)) add('private-name', joined, run[0].index);
      }
    }
  }
  return found;
}

/**
 * @param {string} text
 * @param {{ nameHashes?: ReadonlySet<string> }} [options]
 * @returns {{ line: number, column: number, kind: string, fingerprint: string }[]}
 */
export function scanText(text, options = {}) {
  const nameHashes = options.nameHashes ?? PRIVATE_NAME_HASHES;
  return text.split('\n').flatMap((line, index) => scanLine(line, index + 1, nameHashes));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [flag, name] = process.argv.slice(2);
  if (flag !== '--hash' || !name) {
    console.error('usage: node scripts/privacy-scan.mjs --hash "<name>"');
    process.exitCode = 2;
  } else {
    console.log(hashName(name));
  }
}
