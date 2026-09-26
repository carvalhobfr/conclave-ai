import { defineConfig } from "vitest/config";

/**
 * Suites that shell out to real Git or spawn the built CLI. Each test here drives several
 * child processes and often a full repository index, so its cost is dominated by process and
 * filesystem contention rather than by the code under test.
 *
 * Adding a file to this list is a deliberate act: a new suite starts under the tight unit
 * budget and has to justify moving.
 */
const PROCESS_HEAVY_TESTS = [
  "tests/agent-skill.test.ts",
  "tests/cli-smoke.test.ts",
  "tests/git-change-set.test.ts",
  "tests/mcp-server.test.ts",
  "tests/reasoning-change-context.test.ts",
  "tests/repository-inspector.test.ts",
  "tests/validation-web.test.ts",
  "tests/web-server.test.ts",
];

export default defineConfig({
  test: {
    globalSetup: ["tests/setup/temporary-root.ts"],
    coverage: {
      reporter: ["text", "html"],
      // Vitest 4 reports every file matching `include`, imported by a test or not, so a
      // module cannot stay above the floor simply by never being loaded.
      include: ["src/**/*.ts"],
      exclude: [
        // Driven end to end by tests/cli-smoke.test.ts, which spawns the built bundle in a
        // child process; V8 cannot attribute that execution back to the TypeScript source.
        "src/cli.ts",
        // Barrel of re-exports and process entry points with no branches of their own.
        "src/index.ts",
        "src/mcp/server.ts",
      ],
    },
    // Two classes of test with genuinely different cost, so they get different deadlines
    // instead of one budget wide enough for the slowest. A single 30s ceiling let a unit
    // test regress from milliseconds to seconds without failing anything.
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: PROCESS_HEAVY_TESTS,
          // The slowest test here is ~270ms alone and ~720ms under full parallel load, so
          // this still leaves an order of magnitude of headroom for slower CI runners.
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        test: {
          name: "integration",
          include: PROCESS_HEAVY_TESTS,
          // Measured worst case is ~8.6s under contention; Windows runners spawn processes
          // far more slowly, so the ceiling stays generous. The product enforces its own
          // 15s Git timeout, which trips first on a genuinely stuck command.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
