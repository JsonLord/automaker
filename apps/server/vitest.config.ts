import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Keep test and coverage globs stable from both repository and workspace scripts.
  root: path.resolve(__dirname, '../..'),
  test: {
    name: 'server',
    reporters: ['verbose'],
    globals: true,
    environment: 'node',
    setupFiles: ['./apps/server/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'apps/server/coverage',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['apps/server/src/**/*.ts'],
      exclude: [
        'apps/server/src/**/*.d.ts',
        'apps/server/src/index.ts',
        'apps/server/src/routes/**', // Routes are better tested with integration tests
        'apps/server/src/types/**', // Type re-exports don't need coverage
        'apps/server/src/middleware/**', // Middleware needs integration tests
        'apps/server/src/lib/enhancement-prompts.ts', // Prompt templates don't need unit tests
        'apps/server/src/services/claude-usage-service.ts', // TODO: Add tests for usage tracking
        'apps/server/src/services/mcp-test-service.ts', // Needs MCP SDK integration tests
        'apps/server/src/providers/index.ts', // Just exports
        'apps/server/src/providers/types.ts', // Type definitions
        'apps/server/src/providers/cli-provider.ts', // CLI integration - needs integration tests
        'apps/server/src/providers/cursor-provider.ts', // Cursor CLI integration - needs integration tests
      ],
      thresholds: {
        // Coverage thresholds
        lines: 60,
        functions: 75,
        branches: 55,
        statements: 60,
      },
    },
    include: [
      'apps/server/tests/**/*.test.ts',
      'apps/server/tests/**/*.spec.ts',
      'apps/server/src/tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve shared packages to source files for proper mocking in tests
      '@automaker/utils': path.resolve(__dirname, '../../libs/utils/src/index.ts'),
      '@automaker/platform': path.resolve(__dirname, '../../libs/platform/src/index.ts'),
      '@automaker/types': path.resolve(__dirname, '../../libs/types/src/index.ts'),
      '@automaker/model-resolver': path.resolve(
        __dirname,
        '../../libs/model-resolver/src/index.ts'
      ),
      '@automaker/dependency-resolver': path.resolve(
        __dirname,
        '../../libs/dependency-resolver/src/index.ts'
      ),
      '@automaker/git-utils': path.resolve(__dirname, '../../libs/git-utils/src/index.ts'),
    },
  },
});
