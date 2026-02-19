import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      include: ['client/**/*.js', 'server/**/*.js', 'shared/**/*.js'],
      exclude: [
        'client/vite.config.js',
        'client/main.js',           // orchestration entry point (DOM + WebGL)
        'client/dist/**',           // build artifacts
        'server/index.js',          // Express/WS bootstrap (boots HTTP on import)
      ],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 60,
        statements: 80,
      },
    },
  },
});
