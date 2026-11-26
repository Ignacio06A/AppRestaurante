import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: './tests/globalSetup.js', fileParallelism: false, testTimeout: 30000, hookTimeout: 120000 },
});
