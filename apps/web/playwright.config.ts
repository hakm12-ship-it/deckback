import { defineConfig, devices } from '@playwright/test';
import { BASE_URL as baseURL } from './e2e/servers';

const ci = !!process.env.CI;

const chromium = { name: 'chromium', use: { ...devices['Desktop Chrome'] } };
/** Spike M0-7 (performance and memory) is measured in chromium only: its memory numbers use the DevTools Protocol. */
/** M6 Task 1's m6-memory.spec.ts (worker peak memory at the budget caps) is the same kind: local, chromium only. */
const perfSpec = /m(0-perf|6-memory)\.spec\.ts$/;

/**
 * Spike M0-1: the built app (vite build, served with the rules of its _headers) in four engines. msedge is the installed Microsoft Edge;
 * the others are Playwright's builds (`npx playwright install chromium firefox webkit`).
 *
 * With `CI` set (GitHub Actions sets it; `CI=1 npm run e2e` locally) only chromium runs, without the M0-7 perf spec:
 * its 51-slide deck is made by PowerPoint (local only) and its numbers are not gated. The other engines and the perf
 * measurement stay local (global constraints: CI budget).
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  reporter: 'list',
  timeout: 120_000,
  forbidOnly: ci,
  // The service worker is off unless a spec turns it on (site-hardening.spec.ts): it would cache across the other specs' pages.
  use: { baseURL, serviceWorkers: 'block' },
  // No webServer: global-setup.ts builds the site afresh and serves it with the rules of its _headers (e2e/servers.ts).
  projects: ci
    ? [{ ...chromium, testIgnore: perfSpec }]
    : [
        chromium,
        { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' }, testIgnore: perfSpec },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: perfSpec },
        { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: perfSpec },
      ],
});
