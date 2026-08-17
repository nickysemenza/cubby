import { execSync } from "node:child_process";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vitest/config";

const gitCommit = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
}).trim();

/**
 * `vite-plugin-wasm` with its "inline the WASM as a base64 data URI" branch
 * forced on for every project.
 *
 * The plugin emits one of two things for a `.wasm` import: a base64 data URI
 * (decoded with `Buffer`, works under Node) when it thinks it's running in SSR
 * or under Vitest, or an `import … from "<id>?url"` (fetched at runtime) when it
 * thinks it's running in a browser. Its Vitest detection is
 * `config.plugins.some((p) => p.name === "vitest")`, and that plugin name is
 * only present on the *root* config — a Vitest **project** config gets
 * `vitest:project` / `vitest:project:server` instead, so the check is false
 * there. That was invisible for the node-environment `unit` project (its
 * transforms are SSR, which takes the same base64 branch anyway) but broke the
 * jsdom `ui` project, where the client transform emitted a `/@fs/…` URL that
 * `fetch` can't parse under Node:
 *
 *     TypeError: Failed to parse URL from /@fs/…/packages/wasm/recipebridge_bg.wasm
 *
 * That made every module transitively reaching `@cubby/recipebridge` — notably
 * `data-table/columnHelpers.tsx`, via `cell-data` → `~/lib/wasm` — unimportable
 * in a `.unit.test.tsx`, forcing whole-module `vi.mock`s instead of real tests.
 *
 * Forcing `ssr: true` on the plugin's `load` hook picks the base64 branch
 * everywhere. It is the same code path the `unit` project already runs, so ui
 * tests get the **real** WASM module (no stub, no mocked exports) and a genuine
 * WASM failure still surfaces as a genuine failure.
 */
function wasmInlinedForVitest(): Plugin {
  const plugin = wasm() as Plugin;
  const load = plugin.load;
  if (typeof load !== "function") {
    throw new Error("vite-plugin-wasm no longer exposes a `load` function");
  }
  return {
    ...plugin,
    load(id, options) {
      return load.call(this, id, { ...options, ssr: true });
    },
  };
}

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  // https://github.com/Menci/vite-plugin-wasm#usage
  plugins: [wasmInlinedForVitest(), topLevelAwait()],
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
          // Threads, not forks. This tier is almost entirely module transform +
          // import: 167 files and 1458 tests, but only `tests: 5.0s` inside a
          // 56s wall clock. So the lever is cheaper worker startup, not faster
          // assertions — measured **56s -> ~14s** (14.3s / 16.8s over two runs)
          // with per-file isolation fully preserved. See the shared
          // "measured and rejected" note on the integration project below for
          // why `isolate: false` is not the answer, even though it is faster
          // still.
          pool: "threads",
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
          // Same reasoning as `unit` — jsdom construction dominates here
          // (`environment: 59s` cumulative against a 28.4s wall clock), and a
          // thread pays it far more cheaply than a forked process. Measured
          // **28.4s -> ~19s** (19.7s / 18.9s), 697/697 green on both runs.
          pool: "threads",
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
          // default. `withTestDb()` provisions one database per file and resets
          // between tests. The reset used to be the dominant per-test cost —
          // TRUNCATE of 40 tables at **266ms mean / 1.0s p99** — which is why
          // these timeouts are generous.
          //
          // Re-measured 2026-08-17 after docker-compose.yml was tuned for test
          // workloads (fsync/synchronous_commit/full_page_writes off, statement
          // logging moved to docker-compose.debug.yml) and the 1603 leaked
          // IntegreSQL databases were dropped: the whole reset is now **~31ms
          // mean**, and the tier went **233s -> ~118s** with the previously
          // failing test going green. The timeouts stay where they are — they
          // cost nothing when unused, and the first-test-in-file provision is
          // still the long tail. See tooling/test-setup.ts for why TRUNCATE
          // survived the re-measurement and why the "truncate only dirty
          // tables" variant is unsafe.
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
          //
          // NB: `pool: "threads"` — which IS a large win on the `unit` and `ui`
          // projects above — was tried here and is a LOSS on both axes:
          // **257.6s vs 233s** wall clock, and failures rose from 3 files to
          // **9 files / 7 tests**. Same root cause as the `isolate: false` note
          // above: the per-worker pg pools and the IntegreSQL client don't
          // survive being shared inside one process. This tier stays on forks.
          //
          // NB: `--no-isolate` was measured and REJECTED repo-wide, not just
          // here. It is genuinely the fastest option (unit 56s -> 7.2s), but
          // over five runs it leaks cross-file state nondeterministically:
          // ui failed 0, 2, 3, 7, and 9 tests on five consecutive runs, and
          // unit — clean on four — failed 3 on the fifth. The leak surface
          // shifts with file->worker assignment, so it is not a bounded "fix
          // these N tests" job. `pool: "threads"` takes 4x on unit and 1.5x on
          // ui with zero isolation trade-off; that is the deal we took.
          //
          // NB: **splitting a slow test file is not a speed fix here.** With
          // per-file isolation each file builds its own module registry, so
          // splitting one file into two makes the shared graph get built
          // TWICE. Measured on server.unit.test.ts, whose lone `appRouter`
          // import makes it cost 12.83s ALONE vs 2.40s without: moving that one
          // test to its own file did cut the file to 2.37s, but the unit tier's
          // CPU went from ~97-109s to ~122-153s and wall clock did not improve.
          // Reverted. The lesson generalises — an isolated per-file duration
          // measures cold-graph cost that a full parallel run amortizes, so it
          // OVERSTATES that file's contribution to the tier. Compare tiers by
          // `user + system` CPU across the whole run, never by timing one file.
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
