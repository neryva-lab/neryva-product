import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
      exclude: ['**/node_modules/**', 'tests/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'contract',
      include: [
        'tests/contract/**/*.test.ts',
        'packages/*/tests/contract.test.ts',
        'packages/neryva-mcp-client/tests/**/*.test.ts',
      ],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'workflow',
      include: [
        'tests/temporal/**/*.test.ts',
        'packages/workflows/tests/**/*.test.ts',
        'packages/activities/tests/**/*.test.ts',
      ],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'isolation',
      include: ['tests/isolation/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'security',
      include: ['tests/security/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'property',
      include: ['tests/property/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'load',
      include: ['tests/load/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'chaos',
      include: ['tests/chaos/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
    },
  },
]);
