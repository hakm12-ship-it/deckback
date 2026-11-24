import { readFileSync } from 'node:fs';

/** Set by the build (`define` in vite.config.ts) to the version in package.json. */
declare const __DECKBACK_VERSION__: string | undefined;

/** The CLI's version: the one the build wrote in, or, run from the source (tests), the one in package.json. */
export const VERSION: string =
  typeof __DECKBACK_VERSION__ === 'string' ? __DECKBACK_VERSION__ : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
