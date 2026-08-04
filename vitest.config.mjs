import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['background.js', 'sidepanel.js', 'lib/**/*.js'],
      thresholds: {
        statements: 55,
        branches: 50,
        functions: 55,
        lines: 55
      }
    }
  }
});

