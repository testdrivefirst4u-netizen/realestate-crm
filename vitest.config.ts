import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // Each test file stops its in-memory MongoDB in afterAll. Fire-and-forget background writes started by the code
    // under test (index creation, after-response work) can still be in flight and are then interrupted with
    // MongoClientClosedError. That is teardown noise, not a test result: only that exact error class is ignored.
    // Any other unhandled error still fails the run.
    onUnhandledError(error) {
      if ((error as { name?: string })?.name === 'MongoClientClosedError') return false;
    },
  },
});
