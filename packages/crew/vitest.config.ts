import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The run tests drive real Git in temporary repositories.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
