import { fileURLToPath } from 'node:url';

/**
 * Where the e2e finds the site. By default global-setup.ts builds it and serves the build (`dist/`) on PORT with the rules
 * of its `_headers` (pages-server.ts); a second build made with a fake beacon token is served on BEACON_PORT, for the
 * privacy test. Set E2E_BASE_URL (and E2E_BEACON_URL) to run the same specs against a server that is already up, such
 * as `wrangler pages dev apps/web/dist` (M6 Task 4): then those two are not built or served here. The test page is
 * another build (`dist-e2e/`, made with VITE_E2E=1, served on TEST_PORT; E2E_TEST_URL for another server): the specs that
 * need the worker's raw replies (m0, scene, convert, perf, memory) read it, and always build it.
 */
export const PORT = 4317;
export const BEACON_PORT = 4318;
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
/** The e2e build: the site plus the test page (test.html), which the production build does not have (ruling M6-R3). */
export const TEST_PORT = 4319;
export const TEST_URL = process.env.E2E_TEST_URL ?? `http://127.0.0.1:${TEST_PORT}`;
/** The address of the test page for `search` (`?request=convert&pages=0`). */
export const testPage = (search: string): string => `${TEST_URL}/test.html${search}`;
export const BEACON_URL = process.env.E2E_BEACON_URL ?? `http://127.0.0.1:${BEACON_PORT}`;
export const EXTERNAL_SERVER = process.env.E2E_BASE_URL !== undefined;

export const WEB_DIR = fileURLToPath(new URL('../', import.meta.url));
export const DIST_DIR = `${WEB_DIR}dist`;
export const E2E_DIST_DIR = `${WEB_DIR}dist-e2e`;
export const BEACON_DIST_DIR = `${WEB_DIR}dist-beacon`;
/** A made-up token for the beacon build. The real one lives in the author's `.env` only. */
export const FAKE_BEACON_TOKEN = 'e2e-fake-beacon-token-0000';
