import { execSync } from "node:child_process";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

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

/** Keep IntegreSQL opt-in while supporting both direct and full-suite commands. */
function wantsIntegrationTier(): boolean {
  if (process.env.CUBBY_TEST_INTEGRATION === "1") return true;
  return process.argv.some(
    (arg, i) =>
      arg === "--project=integration" ||
      (arg === "--project" && process.argv[i + 1] === "integration"),
  );
}

const pureUnitTests = [
  "src/entities/entity-contracts.unit.test.ts",
  "src/entities/entities.unit.test.ts",
];
const mcpContractTests = [
  "src/server/mcp/catalog-schema.unit.test.ts",
  "src/server/mcp/mcp-apps.unit.test.ts",
  "src/server/mcp/mcp-output-uuid-boundary.unit.test.ts",
  "src/server/mcp/mcp-protocol.unit.test.ts",
  "src/server/mcp/mcp-workflow-tools.unit.test.ts",
];

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __SOURCE_COMMIT__: JSON.stringify(gitCommit),
    __SOURCE_BRANCH__: JSON.stringify("test"),
    __BUILD_DATE__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  // https://github.com/Menci/vite-plugin-wasm#usage
  plugins: [wasmInlinedForVitest(), topLevelAwait()],
  resolve: {
    alias: {
      // https://github.com/juliusmarminge/t3-complete/blob/main/vitest.config.ts
      "~/": join(import.meta.dirname, "./src/"),
      "tooling/": join(import.meta.dirname, "./tooling/"),
    },
  },
  test: {
    // Dependency prebundling regresses this import-heavy graph; remeasure before
    // enabling it. WASM initialization is not the material cost.

    // `default` keeps the familiar output (progress + full diffs); the second
    // reporter re-prints just the failing test names at the very end so a
    // `| tail` of the run still shows what broke. See the reporter for the
    // measured re-run waste that motivated it.
    reporters: ["default", "./tooling/failure-summary-reporter.ts"],
    coverage: {
      exclude: ["src/components/reui/**"],
    },
    projects: (
      [
        {
          // will inherit options from this config like plugins and pool
          extends: true,
          test: {
            name: "unit",
            include: ["**/*.unit.test.ts"],
            exclude: [
              "**/node_modules/**",
              ...pureUnitTests,
              ...mcpContractTests,
            ],
            // Threads reduce worker startup while preserving per-file isolation.
            pool: "threads",
          },
        },
        {
          extends: true,
          test: {
            name: "mcp-contract",
            include: mcpContractTests,
            pool: "threads",
          },
        },
        {
          // Catalog and schema invariants only: no mocks, databases, env
          // mutation, or global singleton state. Sharing their module graph is
          // therefore safe and removes the isolation startup tax.
          extends: true,
          test: {
            name: "unit-pure",
            include: pureUnitTests,
            pool: "threads",
            isolate: false,
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
            // Threads amortize jsdom construction without sharing test state.
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
            testTimeout: 10000,
            // First-test database provisioning is the long tail; resets use the
            // full safe TRUNCATE path documented in tooling/test-setup.ts.
            hookTimeout: 30000,
            // Integration stays on isolated forks: database clients and module
            // caches are file-scoped, while shared registries make vi.mock order
            // dependent. Larger IntegreSQL pools do not reduce CREATE latency.
          },
        },
        {
          // PGlite is an embedded real Postgres: this project is deliberately
          // tiny and proves schema/extensions plus one production SQL path
          // without provisioning an IntegreSQL database.
          extends: true,
          test: {
            name: "pglite",
            include: ["**/*.pglite.test.ts"],
            pool: "forks",
            fileParallelism: false,
            testTimeout: 30000,
          },
        },
      ] satisfies TestProjectConfiguration[]
    ).filter(
      (project) =>
        project.test.name !== "integration" || wantsIntegrationTier(),
    ),

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
