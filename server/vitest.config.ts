import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';

const env = loadEnv({ path: '.env.test', override: true }).parsed ?? {};

export default defineConfig({
  test: {
    env,
    globalSetup: './tests/globalSetup.ts',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
