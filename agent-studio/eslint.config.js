// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'gen/**',
      '.opencode/**',
      '.agents/**',
      'apps/**/dist/**',
      'packages/**/dist/**',
      '**/*.d.ts',
      'contracts/**/dist/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'log'] }],
      'prefer-const': 'warn',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'Agent Studio has no Engine DB credentials. Use neryva-mcp-client claim-check refs. See agent_studio_implementation_plan.md:493.',
            },
            {
              name: 'drizzle-orm',
              message: 'Engine-only SQL builder. Studio must use MCP client.',
            },
          ],
          patterns: [
            {
              group: ['**/workflows/**'],
              importNames: ['fetch'],
              message:
                'Workflow code deterministic only — use activities for network. See 491-503.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'vitest.config.ts',
      'vitest.workspace.ts',
      'eslint.config.js',
      'prettier.config.js',
      'tests/**/*.ts',
      'apps/**/tests/**/*.ts',
      'packages/**/tests/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Workflow determinism — forbid non-deterministic and provider SDKs in workflows
    files: ['packages/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@temporalio/client',
              message: 'Workflows use @temporalio/workflow APIs only.',
            },
            {
              name: 'ai',
              message: 'Provider SDKs forbidden in workflows. Use activities via model-gateway.',
            },
            { name: '@ai-sdk/openai', message: 'Provider SDK forbidden in workflows.' },
            { name: '@ai-sdk/anthropic', message: 'Provider SDK forbidden in workflows.' },
          ],
          patterns: [
            { group: ['node:fs*'], message: 'fs forbidden in workflows — deterministic only.' },
            {
              group: ['node:process'],
              message: 'process.env forbidden in workflows — use Temporal APIs.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message: 'setTimeout forbidden in workflows — use Temporal sleep/timers.',
        },
        { name: 'setInterval', message: 'setInterval forbidden in workflows.' },
      ],
    },
  },
  {
    // Model Gateway — provider types must not leak
    files: ['packages/model-gateway/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
