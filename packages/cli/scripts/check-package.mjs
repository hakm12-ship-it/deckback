// Run by `npm pack` / `npm publish` through "prepack" (after the build): the tarball must not be made without the bundle,
// LICENSE and NOTICE, which are generated and not in git. `node packages/cli/scripts/check-package.mjs` checks only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const missing = ['dist/deckback.mjs', 'dist/cmaps/UniKS-UCS2-H.bcmap', 'LICENSE', 'NOTICE'].filter((file) => !existsSync(join(cli, ...file.split('/'))));
if (missing.length > 0) {
  console.error(`deckback: cannot pack, missing: ${missing.join(', ')}`);
  process.exit(1);
}
