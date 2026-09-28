import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The stdio test starts the real server, which lists processes through PowerShell on Windows.
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
