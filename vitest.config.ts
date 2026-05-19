import { defineConfig } from 'vitest/config';

/**
 * Root vitest config. Discovers tests in all workspace packages.
 *
 * Per-package overrides (e.g. jsdom for UI tests) land in
 * `packages/<name>/vitest.config.ts` later when needed.
 */
export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/test-utils/**',
      ],
    },
  },
});
