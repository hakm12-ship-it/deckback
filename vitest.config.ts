import { defineConfig } from 'vitest/config';

/**
 * The atlas sweep is a heavy local run (every page of the sweep sets under out/, walked and converted to a Scene, against
 * the oracle), so it is opt-in: its project exists only in the mode `sweep`, which `npm run oracle:sweep` passes
 * (`vitest run --mode sweep --project sweep`). It writes out/sweep/ (git-ignored); only DECKBACK_SWEEP_RECORD=1 also
 * writes the committed fidelity/results/<date>-oracle-sweep.json. A bare `vitest run` (mode `test`) runs the other
 * projects and never the sweep (packages/core/test/vitest-projects.test.ts).
 */
const SWEEP_MODE = 'sweep';

export default defineConfig(({ mode }) => ({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          // Ruling M1-R64: the corpus ratchets and the atlas sweep run Python and are projects of their own.
          exclude: ['**/node_modules/**', '**/*.local.test.ts', '**/*.corpus.test.ts', '**/*.sweep.test.ts'],
        },
      },
      {
        test: {
          name: 'local',
          include: ['packages/*/test/**/*.local.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        // The committed corpus (corpus/generated) against the PyMuPDF oracle, the walker's and the Scene's (the oracle
        // and Scene ratchets), its op-list contract, and its PPTX (the PPTX ratchet: hash, validator, S1-S6): runs in CI.
        test: {
          name: 'corpus',
          include: ['packages/*/test/corpus/**/*.corpus.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      ...(mode === SWEEP_MODE
        ? [
            {
              // The sweep sets (out/atlas, out/atlas-win, out/producers; local only) against the oracle, the walker's
              // and the Scene's; writes out/sweep/<date>-oracle-sweep.json. Opt-in: see SWEEP_MODE.
              test: {
                name: 'sweep',
                include: ['packages/*/test/sweep/**/*.sweep.test.ts'],
                exclude: ['**/node_modules/**'],
              },
            },
          ]
        : []),
    ],
  },
}));
