import { execSync } from "node:child_process";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vitest/config";

const gitCommit = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
}).trim();

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  // https://github.com/Menci/vite-plugin-wasm#usage
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // https://github.com/juliusmarminge/t3-complete/blob/main/vitest.config.ts
      "~/": join(__dirname, "./src/"),
      "tooling/": join(__dirname, "./tooling/"),
    },
  },
  test: {
    coverage: {
      exclude: ["src/components/reui/**"],
    },
    projects: [
      {
        // will inherit options from this config like plugins and pool
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
        },
      },
      {
        // will inherit options from this config like plugins and pool
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["**/*.unit.test.tsx"],
          setupFiles: ["./tooling/ui-test-setup.ts"],
        },
      },
      {
        // won't inherit any options from this config
        // this is the default behaviour
        extends: true,
        test: {
          globalSetup: ["./tooling/test-setup.ts"],
          // File-scoped `afterAll` that returns this file's database to
          // IntegreSQL. Must be a setupFile, not something `withTestDb()`
          // registers — see `closeTestDb` in tooling/test-setup.ts.
          setupFiles: ["./tooling/integration-teardown.ts"],
          name: "integration",
          include: ["**/*.integration.test.ts"],
          testTimeout: 10000, // Increase timeout for integration tests
          // The `beforeEach` still does real work, so this stays above the 10s
          // default. `withTestDb()` now provisions one database per file and
          // resets between tests, but the reset is not free — measured across
          // the full parallel suite: terminate-backends ~19ms mean, TRUNCATE of
          // 40 tables **266ms mean / 1.0s p99**, seed ~20ms, and the whole hook
          // p99 11.5s / max 16.9s once the first-test-in-file provision is
          // included. 10s was tried and still timed out under load.
          hookTimeout: 30000,
          //
          // NB: raising IntegreSQL's pool size does NOT help — measured with
          // INTEGRESQL_TEST_INITIAL_POOL_SIZE 8 -> 32 (pool grew 8 -> 64 dbs)
          // and the distribution was unchanged (mean 777ms vs 788ms). The wait
          // is the per-database CREATE cost, not queueing for a free slot.
          //
          // NB: `poolOptions.forks.isolate: false` was tried to reuse the server
          // module graph across files — it was measurably SLOWER (~50s vs ~27s)
          // and dropped test discovery (161 vs 164), because the per-worker pg
          // pools / IntegreSQL client don't share cleanly across files. Keep
          // isolation on.
          //
          // Isolation is now load-bearing for CORRECTNESS, not just speed:
          // test-setup.ts caches its database in module scope, which is
          // per-file only because `isolate: true` gives each file a fresh module
          // registry. Turning it off would silently share one database across
          // files, and the suite's global "zero" invariants
          // (findOrphanedEntityEmbeddings) and recent-N windows
          // (listBackgroundBatches) are only meaningful within one file.
        },
      },
    ],

    env: {
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "1",
      DATABASE_URL: "postgresql://postgres:password@localhost:5432/test",
      USDA_API_URL: "http://localhost:8080",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_ENDPOINT: "http://localhost:9000",
      R2_BUCKET_NAME: "test",
      R2_PUBLIC_URL: "http://localhost:9000",
    },
  },
});
