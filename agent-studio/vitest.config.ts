import { defineConfig } from 'vitest/config';

/**
 * Studio test projects.
 *
 * Previously defined in a deprecated `vitest.workspace.ts` (vitest 3 silently
 * ignores per-project `include` overrides from workspace files — every
 * `--project=X` run executed the union of all test files, so `test:integration`
 * etc. never actually scoped). Projects now live here per vitest 3's
 * `test.projects` so each `test:*` script runs exactly its own file set.
 */
const projectExclude = ['**/node_modules/**', '**/dist/**', '**/gen/**', '**/.opencode/**', '**/.agents/**'];

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: projectExclude,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: ['node_modules/**', 'dist/**', 'gen/**', '**/*.test.ts'],
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'tests/**', '**/dist/**', '**/gen/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'contract',
          include: [
            'tests/contract/**/*.test.ts',
            'packages/*/tests/contract.test.ts',
            'packages/neryva-mcp-client/tests/**/*.test.ts',
          ],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'workflow',
          include: [
            'tests/temporal/**/*.test.ts',
            'packages/workflows/tests/**/*.test.ts',
            'packages/activities/tests/**/*.test.ts',
          ],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'property',
          include: ['tests/property/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'load',
          include: ['tests/load/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'chaos',
          include: ['tests/chaos/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
      {
        // tests/evaluation has no dedicated test:* script (pre-existing); keep
        // it runnable under plain `pnpm test` so coverage is not silently dropped.
        test: {
          name: 'evaluation',
          include: ['tests/evaluation/**/*.test.ts'],
          exclude: projectExclude,
          environment: 'node',
        },
      },
    ],
  },
  esbuild: {
    target: 'es2022',
  },
});
