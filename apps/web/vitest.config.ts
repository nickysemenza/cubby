import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import type { HookHandler, Plugin } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";
import { readR2PublicUrl } from "./tooling/cloudflare-public-config.ts";
import { testShuffleSeed } from "./tooling/test-seed.ts";
import { testWorker } from "./tooling/workers-test.cloudflare.config.ts";

// Generated output and the @cubby/recipebridge WASM are never committed; bring
// them current before any module graph (or TanStack's route scan) reads them.
// Each is a marker or Nx cache hit when its inputs are unchanged. Inside an
// Nx task `ensure.ts` skips the build but still prunes generated files a cache
// restore left behind. Vitest evaluates this file more than once per run.
if (process.env.CUBBY_VITEST_ENSURED === undefined) {
  for (const target of ["wasm", "generate"])
    execFileSync(process.execPath, ["../../scripts/ensure.ts", target], {
      cwd: import.meta.dirname,
      stdio: "inherit",
    });
  process.env.CUBBY_VITEST_ENSURED = "1";
}

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
 *     TypeError: Failed to parse URL from /@fs/…/packages/wasm/worker/recipebridge_bg.wasm
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
  // SAFETY: vite-plugin-wasm returns one concrete plugin here, while Vite's
  // public PluginOption type also permits arrays and falsy conditional entries.
  const plugin = wasm() as Plugin;
  const load = plugin.load;
  if (!isPluginLoadHook(load)) {
    throw new Error("vite-plugin-wasm no longer exposes a `load` function");
  }
  return {
    ...plugin,
    load(id, options) {
      return load.call(this, id, { ...options, ssr: true });
    },
  };
}

type PluginLoadHook = HookHandler<NonNullable<Plugin["load"]>>;

function isPluginLoadHook(load: Plugin["load"]): load is PluginLoadHook {
  return typeof load === "function";
}

/** Keep IntegreSQL opt-in while supporting both direct and full-suite commands. */
function workersTestPluginOptions(): Parameters<typeof cloudflareTest>[0] {
  const durableObjects = Object.fromEntries(
    Object.entries(testWorker.env).flatMap(([name, binding]) =>
      binding.type === "durable-object"
        ? [
            [
              name,
              {
                className: binding.exportName,
                useSQLite:
                  new Map(Object.entries(testWorker.exports)).get(
                    binding.exportName,
                  )?.storage === "sqlite",
              },
            ],
          ]
        : [],
    ),
  );
  return {
    miniflare: {
      // The beta pool renames its runner without retargeting native self bindings.
      durableObjects,
      outboundService: async (request) => {
        if (
          request.url === "https://auth.openai.com/api/accounts/oauth/token"
        ) {
          return new Response("synthetic token rejection", { status: 400 });
        }
        // Miniflare's Request is not Node's native Request class.
        return fetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          redirect: request.redirect,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.arrayBuffer(),
        });
      },
    },
    experimental: {
      newConfig: {
        configPath: join(
          import.meta.dirname,
          "tooling/workers-test.cloudflare.config.ts",
        ),
      },
    },
  };
}

function wantsIntegrationTier(name: string): boolean {
  if (process.env.CUBBY_TEST_INTEGRATION === "1") return true;
  return explicitlySelectsProject(name);
}

/**
 * The browser-mode `preview` project launches a real (Playwright) Chromium
 * instance, which is slower to start than the jsdom `ui` project and would
 * slow the fast tier noticeably if it ran by default. Keep it opt-in the same
 * way `integration` is — but ALSO opt in for a direct `.preview.test.tsx`
 * file argument (`pnpm test:file src/....preview.test.tsx`), matching the
 * other projects' `include` globs, which vitest still resolves by path even
 * when this project is otherwise filtered out.
 */
function wantsPreviewTier(): boolean {
  if (explicitlySelectsProject("preview")) return true;
  return process.argv.some((arg) => arg.includes(".preview.test.tsx"));
}

function explicitlySelectsProject(name: string): boolean {
  return process.argv.some(
    (arg, i) =>
      arg === `--project=${name}` ||
      (arg === "--project" && process.argv[i + 1] === name),
  );
}

// One required owner per migrated capability; other previews remain opt-in.
const requiredCapabilityTests = [
  "src/lib/test/browser-harness.preview.test.tsx",
  "src/entity/entity-list/list-capabilities.preview.test.tsx",
  "src/entity/entity-detail/spend-chart.preview.test.tsx",
  "src/entity/fields/field-explanation.preview.test.tsx",
  "src/entity/table/date-range.preview.test.tsx",
  "src/features/run/photo-run-detail.preview.test.tsx",
  "src/ui/data-table/table-density.preview.test.tsx",
  "src/ui/data-table/rendered-column-fit.preview.test.tsx",
];

const mcpContractTests = [
  "src/server/mcp/agent-manifest-tools.unit.test.ts",
  "src/server/mcp/catalog-schema.unit.test.ts",
  "src/server/mcp/mcp-output-uuid-boundary.unit.test.ts",
  "src/server/mcp/mcp-protocol.unit.test.ts",
  "src/server/mcp/mcp-response-policies.unit.test.ts",
  "src/server/mcp/mcp-workflow-tools.unit.test.ts",
  "src/server/mcp/tools/tool-json-schema.unit.test.ts",
];
// PostgreSQL files that start the built Worker (`tooling/workerd-harness.ts`,
// directly or through `workerd-runtime.ts`). CI runs them in the Worker build
// step against its verified bundle. Keep consumers in this list explicitly:
// an ordinary integration step can inherit a browser-built bundle when paired,
// so CI's refusal to rebuild a missing/stale bundle does not enforce membership.
const workerdIntegrationTests = [
  "tooling/database-socket-lifecycle.integration.test.ts",
  "src/server/domains/purchase-import/repo/purchase-agent-scenarios.integration.test.ts",
];
const integrationTests = [
  "src/**/*.integration.test.ts",
  "tooling/**/*.integration.test.ts",
];
// Same flake policy as Playwright for suites that own databases, browsers or
// workerd: one CI retry, reported as flaky, quarantined on repeat. Node unit,
// tooling and package suites never retry, so their flakes fail.
const serviceRetry = process.env.CI ? 1 : 0;
const integrationProject = {
  retry: serviceRetry,
  globalSetup: ["./tooling/test-setup.ts"],
  // File-scoped `afterAll` that returns this file's database to
  // IntegreSQL. Must be a setupFile, not something `withTestDb()`
  // registers — see `closeTestDb` in tooling/test-setup.ts.
  setupFiles: ["./tooling/integration-teardown.ts"],
  pool: "forks" as const,
  // The former per-file family resolver made 8 lumpy import-index
  // files carry 76 real contract files with an isolated fork each.
  // `isolate: false` shares one fork's module graph across a whole
  // worker's share of those 76 files instead: `db.ts`'s
  // `moduleRuntime` pool, `cf-env.ts`, `clients/ai.ts`,
  // `ai/models.ts`, `semantic/embeddings.ts`, and
  // `clients/notion.ts`'s LRU caches are the per-worker module
  // singletons this exposes — none bind to a per-file database, so a
  // test asserting a cold cache/pool would be the first casualty.
  // `withTestDb()`/`resetTestDb()` still gives every TEST a pristine
  // database; this only changes whether the JS module registry is
  // fresh per file (it no longer is, per worker).
  isolate: false,
  testTimeout: 10000,
  // First-test database provisioning is the long tail; resets use the
  // full-table reset documented in tooling/test-setup.ts.
  hookTimeout: 30000,
};
// Web projects only: repository tooling tests assert that dev commands refuse
// inherited database overrides, so the scripts project must not see these.
const webTestEnv = {
  NODE_ENV: "test",
  SKIP_ENV_VALIDATION: "1",
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/test",
  R2_ACCESS_KEY_ID: "test",
  R2_SECRET_ACCESS_KEY: "test",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_NAME: "test",
  R2_PUBLIC_URL: "http://localhost:9000",
  BETTER_AUTH_SECRET: "synthetic-test-signing-secret",
};
const sharedIsolationSeed = testShuffleSeed();
const groupZeroMaxWorkers = Number.parseInt(
  process.env.VITEST_MAX_WORKERS ?? "4",
  10,
);
if (!Number.isSafeInteger(groupZeroMaxWorkers) || groupZeroMaxWorkers < 1) {
  throw new Error("VITEST_MAX_WORKERS must be a positive integer");
}
export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __SOURCE_COMMIT__: JSON.stringify(gitCommit),
    __SOURCE_BRANCH__: JSON.stringify("test"),
    __BUILD_DATE__: JSON.stringify("2026-01-01T00:00:00.000Z"),
    __R2_PUBLIC_URL__: JSON.stringify(readR2PublicUrl()),
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
    // Reuse source/config-keyed transforms across focused runs; assertions still execute.
    fsModuleCache: true,
    // Dependency prebundling regresses this import-heavy graph; remeasure before
    // enabling it. WASM initialization is not the material cost.

    // The default reporter covers terminal output; JSON preserves failed
    // tests when output is truncated. CI also emits GitHub annotations and a
    // blob per shard; the CI report job merges the blobs into one HTML report
    // and writes the combined job summary (tooling/ci-report/summary.ts).
    reporters:
      process.env.GITHUB_ACTIONS === "true"
        ? [
            "default",
            ["github-actions", { jobSummary: { enabled: false } }],
            ["json", { outputFile: ".vitest-results.json" }],
            "blob",
          ]
        : ["default", ["json", { outputFile: ".vitest-results.json" }]],
    // Passing fixtures intentionally exercise error logging and transport
    // tracing. Printing those expected messages dominates terminal I/O in the
    // shared-graph suite; failed tests still retain their console output.
    silent: "passed-only",
    // CI runners are slower than local dev machines but should still fail
    // fast on a genuinely hung test; local runs keep Vitest's own default.
    testTimeout: process.env.CI ? 10_000 : 5000,
    // Vitest 5 makes file ordering a root-only concern. Every project still
    // inherits the same deterministic shuffle; project sequence config only
    // controls which groups may run together.
    sequence: {
      shuffle: { files: true, tests: false },
      seed: sharedIsolationSeed,
    },
    projects: (
      [
        {
          // will inherit options from this config like plugins and pool
          extends: true,
          test: {
            name: "unit",
            // Folds the former `unit-pure` project's 2 catalog/schema files
            // in: they have no mocks, databases, env mutation, or global
            // singleton state, so sharing this project's module graph is
            // exactly as safe as their old dedicated one, without a second
            // isolation startup tax.
            include: ["**/*.unit.test.ts"],
            exclude: ["**/node_modules/**", ...mcpContractTests],
            // Unit files are order-independent and clean up their mutable state.
            // Sharing the module graph removes the dominant per-file startup cost.
            pool: "threads",
            isolate: false,
            // Four workers reduced the paired-run maximum without slowing the
            // solo median. Keep the cap aligned across group 0 so one project
            // cannot starve the others. The environment override supports
            // uncached tuning measurements and participates in the Nx cache key.
            maxWorkers: groupZeroMaxWorkers,
            sequence: { groupOrder: 0 },
          },
        },
        {
          extends: true,
          test: {
            name: "mcp-contract",
            include: mcpContractTests,
            pool: "threads",
            // These files all import the complete MCP server. Sharing each
            // worker's module graph avoids repeating that import setup when a
            // worker receives more than one file; server instances remain
            // test-owned and are still constructed as needed.
            isolate: false,
            maxWorkers: groupZeroMaxWorkers,
            sequence: { groupOrder: 0 },
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
            // Global teardown restores DOM, storage, timers, mocks, globals,
            // and env between tests, so workers can share one jsdom graph.
            pool: "threads",
            isolate: false,
            maxWorkers: groupZeroMaxWorkers,
            clearMocks: true,
            unstubGlobals: true,
            unstubEnvs: true,
            // Run UI after Node projects so each phase can reuse its own
            // warmed module graph instead of mixing worker environments.
            sequence: { groupOrder: 1 },
          },
        },
        ...["preview", "capability"].map(
          (name) =>
            ({
              // Real Chromium via the Playwright provider — not jsdom. Renders
              // components at real device widths and reads real layout (bounding
              // boxes, `getComputedStyle`, whether a rerender changed an
              // element's height) that jsdom cannot: jsdom has no layout engine,
              // so every box is 0x0 and CSS media queries never match a width.
              extends: true,
              // Tailwind (unlike `unit`/`ui`, which never render real layout)
              // has to actually generate the utility classes the components use
              // — a real browser's layout engine reads them for real, so a
              // width invariant is only meaningful if `min-h-11`, `md:min-w-0`,
              // etc. actually apply. `preview-test-setup.ts` imports the app's
              // real `styles.css` entry point to feed it.
              plugins: [react(), tailwindcss()],
              // Vite's default dependency scanner (no `index.html` here) falls
              // back to crawling the whole `src` tree for an entry, which reaches
              // `#tanstack-start-entry`/`#tanstack-router-entry` — virtual
              // specifiers only `@tanstack/react-start`'s own Vite plugin
              // resolves (that plugin isn't loaded here; the real app's
              // `vite.config.ts` is a separate config this one never imports).
              // Unlike the `ui`/`unit` projects, browser mode can't fall back to
              // skipping a failed scan (it needs a real prebundle to serve to
              // the browser), so a scan failure is fatal here. Pointing the
              // scanner's entries at only the preview test files keeps the crawl
              // out of server-only modules it was never going to test, while
              // still discovering (and properly CJS-interop-converting) every
              // dependency those files actually reach.
              optimizeDeps: {
                // Lazy feature imports must be prebundled before a test starts;
                // discovering them mid-test reloads the tab and loses assertions.
                include: [
                  "@hookform/resolvers/zod",
                  "@phosphor-icons/react/dist/csr/Book",
                  "@phosphor-icons/react/dist/csr/Bookmark",
                  "@phosphor-icons/react/dist/csr/Calculator",
                  "@phosphor-icons/react/dist/csr/CalendarCheck",
                  "@phosphor-icons/react/dist/csr/CameraPlus",
                  "@phosphor-icons/react/dist/csr/CaretDoubleLeft",
                  "@phosphor-icons/react/dist/csr/CaretDoubleRight",
                  "@phosphor-icons/react/dist/csr/Flame",
                  "@phosphor-icons/react/dist/csr/Flask",
                  "@phosphor-icons/react/dist/csr/GridFour",
                  "@phosphor-icons/react/dist/csr/ListDashes",
                  "@phosphor-icons/react/dist/csr/Thermometer",
                  "@phosphor-icons/react/dist/csr/Timer",
                  "@tanstack/react-virtual",
                  "p-map",
                ],
                entries: [
                  join(import.meta.dirname, "src/**/*.preview.test.tsx"),
                ],
                exclude: [
                  "@tanstack/react-start",
                  "@tanstack/react-start-server",
                  "@tanstack/start-server-core",
                ],
              },
              test: {
                name,
                include:
                  name === "capability"
                    ? requiredCapabilityTests
                    : ["**/*.preview.test.tsx"],
                // A direct file argument enables preview implicitly. Required
                // files already run in capability; explicit preview still runs all.
                exclude:
                  name === "preview" && !explicitlySelectsProject("preview")
                    ? requiredCapabilityTests
                    : [],
                setupFiles: ["./tooling/preview-test-setup.ts"],
                browser: {
                  enabled: true,
                  headless: true,
                  provider: playwright(),
                  instances: [{ browser: "chromium" }],
                },
                // Chromium launch + page navigation per file is slower than a
                // shared jsdom graph; give it real room instead of flaking on
                // the fast tiers' 5s/10s budget.
                testTimeout: 20_000,
                retry: serviceRetry,
                isolate: false,
                sequence: { groupOrder: 2 },
              },
            }) satisfies TestProjectConfiguration,
        ),
        {
          extends: true,
          test: {
            ...integrationProject,
            name: "integration",
            include: integrationTests,
            exclude: ["**/node_modules/**", ...workerdIntegrationTests],
            // Larger IntegreSQL pools do not reduce CREATE latency; sequencing
            // stays a distinct serial group so its shared-worker singletons
            // above never interleave with the unit/UI/mcp-contract group.
            sequence: { groupOrder: 3 },
          },
        },
        {
          // Same database harness as `integration`; a later group so a local
          // full run never starts workerd beside the PostgreSQL forks.
          extends: true,
          test: {
            ...integrationProject,
            name: "integration-workerd",
            globalSetup: [
              ...integrationProject.globalSetup,
              "./tooling/workerd-integration-setup.ts",
            ],
            include: workerdIntegrationTests,
            sequence: { groupOrder: 4 },
          },
        },
        {
          // Repository tooling tests (scripts, lint rules, generators, dev
          // services, Apple host tooling). They import plain Node modules
          // without aliases or WASM, so they do not extend the web config.
          // Many spawn processes or change directories: keep forks isolated.
          test: {
            name: "scripts",
            root: join(import.meta.dirname, "../.."),
            include: [
              "scripts/**/*.test.ts",
              "tools/oxlint/**/*.test.ts",
              "apps/web/generator/**/*.test.ts",
              "apps/web/tooling/**/*.test.ts",
              "apps/apple/tooling/**/*.test.ts",
              "apps/apple/scripts/*.test.ts",
              "apps/nx-cache/tests/*.test.mjs",
            ],
            exclude: [
              "**/node_modules/**",
              "**/*.unit.test.ts",
              "**/*.integration.test.ts",
            ],
            pool: "forks",
            testTimeout: 30_000,
            // Group 0 projects must share one worker cap.
            maxWorkers: groupZeroMaxWorkers,
            sequence: { groupOrder: 0 },
          },
        },
        {
          // Workspace package suites; they need no web aliases or plugins.
          test: {
            name: "packages",
            root: join(import.meta.dirname, "../.."),
            include: ["packages/*/src/**/*.test.ts"],
            maxWorkers: groupZeroMaxWorkers,
            sequence: { groupOrder: 0 },
          },
        },
        {
          // Worker suites inside workerd. No `extends`: the Cloudflare pool
          // brings its own module runner, and the root WASM/alias plugins
          // target Node.
          plugins: [cloudflareTest(workersTestPluginOptions())],
          // The Sentry-instrumented agent host reads the release the app build defines.
          define: { __GIT_COMMIT__: JSON.stringify("workers-test") },
          resolve: { tsconfigPaths: true },
          test: {
            name: "workers",
            // workerd cannot read Vitest 5's transformed modules from the host filesystem.
            fsModuleCache: false,
            include: [
              "src/server/domains/calendar/**/*.workers.test.ts",
              "src/server/generic/problems/**/*.workers.test.ts",
              "src/server/domains/purchase-import/**/*.workers.test.ts",
              "src/server/ai/**/*.workers.test.ts",
              "src/server/domains/run/**/*.workers.test.ts",
              "src/server/domains/usda-release/**/*.workers.test.ts",
            ],
            testTimeout: 30_000,
            hookTimeout: 30_000,
            fileParallelism: false,
            // One reused workerd runner measured 9s against 21s with a fresh
            // runner per file; the suite passes under shuffled file orders.
            isolate: false,
            retry: serviceRetry,
            sequence: { groupOrder: 5 },
          },
        },
        {
          // Opt-in, billed model evals (`*.live-eval.ts`) on the integration
          // database harness. Never part of test:postgres; select explicitly.
          extends: true,
          test: {
            globalSetup: ["./tooling/test-setup.ts"],
            setupFiles: ["./tooling/integration-teardown.ts"],
            name: "live-eval",
            include: ["src/**/*.live-eval.ts"],
            pool: "forks",
            testTimeout: 24 * 60 * 60_000,
            hookTimeout: 30000,
          },
        },
      ] satisfies TestProjectConfiguration[]
    )
      .map((project) =>
        project.extends === true
          ? { ...project, test: { env: webTestEnv, ...project.test } }
          : project,
      )
      .filter((project) => {
        if (
          project.test.name === "integration" ||
          project.test.name === "integration-workerd"
        )
          return wantsIntegrationTier(project.test.name);
        if (project.test.name === "preview") return wantsPreviewTier();
        if (project.test.name === "live-eval")
          return explicitlySelectsProject("live-eval");
        return true;
      }),
  },
});
