import { join } from "node:path";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
          name: "integration",
          include: ["**/*.integration.test.ts"],
          testTimeout: 10000, // Increase timeout for integration tests
          // `withTestDb()` provisions a fresh IntegreSQL database in a
          // `beforeEach`, so the HOOK — not the test body — carries the cost of
          // a `CREATE DATABASE ... TEMPLATE`. Vitest's default hookTimeout is
          // 10s, which was too tight and made this suite fail ~8% of CI runs
          // (both shards, every branch) with "Hook timed out in 10000ms" on an
          // arbitrary scatter of tests — never a real assertion failure.
          //
          // Measured locally (8-core, NVMe): `getTestDatabase` takes ~43ms mean
          // running one file alone, but mean 788ms / p99 1.9s under full-suite
          // parallelism — an 18x contention penalty before CI's much slower
          // disk is accounted for. 30s keeps a genuinely hung hook failing,
          // just past the point where normal provisioning has finished.
          //
          // NB: raising IntegreSQL's pool size does NOT help — measured with
          // INTEGRESQL_TEST_INITIAL_POOL_SIZE 8 -> 32 (pool grew 8 -> 64 dbs)
          // and the distribution was unchanged (mean 777ms vs 788ms). The wait
          // is the per-database CREATE cost, not queueing for a free slot.
          // The structural fix is provisioning per-file instead of per-test
          // (294 provisions -> 35); see docs/todos.md.
          hookTimeout: 30000,
          // NB: `poolOptions.forks.isolate: false` was tried to reuse the server
          // module graph across files — it was measurably SLOWER (~50s vs ~27s)
          // and dropped test discovery (161 vs 164), because the per-worker pg
          // pools / IntegreSQL client don't share cleanly across files. Keep
          // isolation on.
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
