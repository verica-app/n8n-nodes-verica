import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['nodes/**/*.test.ts', 'credentials/**/*.test.ts'],
  },
});
