import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import { isGitWorktree } from "./tooling/git-worktree.ts";
import { assertDevDatabaseUrl } from "./tooling/dev-db-guard.ts";
import { mcpAppAsset } from "./tooling/mcp-app-asset.ts";
import { createServerFunctionIdGenerator } from "./tooling/server-function-id.ts";
import { viteDevLogin } from "./tooling/vite-dev-login.ts";
import { readR2PublicUrlFromWrangler } from "./tooling/wrangler-public-config.ts";

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitCommit = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
}).trim();
// Full SHA for the Sentry release's commit association (setCommits below) —
// the short `gitCommit` above is what actually names the release, matching
// the runtime `release` in router.tsx and cf-server.ts.
const fullSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
const repoRoot = path.resolve(__dirname, "../..");
const sourceCommit = process.env.CUBBY_SOURCE_COMMIT?.slice(0, 7) || gitCommit;
// Source time keeps identical checkouts byte-stable across repeated builds.
const sourceDate = execFileSync(
  "git",
  [
    "show",
    "-s",
    "--format=%cI",
    process.env.CUBBY_SOURCE_COMMIT || "HEAD",
    "--",
  ],
  { encoding: "utf-8" },
).trim();
const sourceBranch =
  process.env.CUBBY_SOURCE_BRANCH ||
  execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
const wranglerR2PublicUrl = readR2PublicUrlFromWrangler();
/**
 * The client's transform gate must name the host the SERVER stamps on image
 * URLs, or `transformedImageUrl` passes every URL through untouched. Builds
 * take wrangler.jsonc (the deployed Worker's origin); the dev server takes the
 * same `.env` `R2_PUBLIC_URL` the server reads, which points at the dev bucket
 * — a different host, so with the wrangler value alone dev never downsized.
 */
const resolveR2PublicUrl = (command: "build" | "serve", mode: string) =>
  command === "serve"
    ? (loadEnv(mode, import.meta.dirname, "R2_PUBLIC_URL").R2_PUBLIC_URL ??
      wranglerR2PublicUrl)
    : wranglerR2PublicUrl;

const clientCodeSplittingGroups = [
  {
    name: "es-toolkit",
    test: /[\\/]es-toolkit[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "date-fns",
    test: /[\\/]date-fns[\\/]|[\\/]@date-fns[\\/]tz[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "tanstack-router",
    test: /[\\/]@tanstack[\\/]react-router[\\/]|[\\/]@tanstack[\\/]router-core[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "tanstack-query",
    test: /[\\/]@tanstack[\\/]react-query[\\/]|[\\/]@tanstack[\\/]query-core[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "floating-ui",
    test: /[\\/]@floating-ui[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "react-hook-form",
    test: /[\\/]react-hook-form[\\/]|[\\/]@hookform[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "radix-ui",
    test: /[\\/]@radix-ui[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
  {
    name: "small-runtime-utils",
    test: /[\\/]clsx[\\/]|[\\/]goober[\\/]|[\\/]pluralize[\\/]/,
    entriesAware: true,
    entriesAwareMergeThreshold: 65536,
  },
];

/**
 * Stub pg-native for CF Workers. Vite emits a bare `throw` for unresolvable
 * optional peer deps, which CF's deploy validator rejects. This resolves
 * pg-native to an empty module so pg falls through to its JS implementation.
 */
function cfPgNativeStub(): Plugin {
  return {
    name: "cf-pg-native-stub",
    enforce: "pre",
    applyToEnvironment(env) {
      return env.name === "ssr";
    },
    resolveId(id) {
      if (id === "pg-native") return "\0pg-native-stub";
    },
    load(id) {
      if (id === "\0pg-native-stub") return "export default null;";
    },
  };
}

/**
 * Vite plugin that redirects @cubby/recipebridge to a CF Workers-compatible
 * wrapper in the SSR environment. The wrapper uses the ?init pattern supported
 * by @cloudflare/vite-plugin to properly instantiate the WASM module.
 *
 * Without this, vite-plugin-wasm doesn't apply to the CF Workers SSR environment,
 * so the bare .wasm import returns a WebAssembly.Module (not instantiated exports),
 * causing `__wbindgen_start is not a function`.
 */
function cfWasmPlugin(): Plugin {
  const cfWrapper = path.resolve(__dirname, "src/lib/recipebridge-cf.ts");
  return {
    name: "cf-wasm-redirect",
    enforce: "pre",
    applyToEnvironment(env) {
      return env.name === "ssr";
    },
    resolveId(source) {
      if (
        source === "@cubby/recipebridge" ||
        source.endsWith("/packages/wasm/recipebridge.js")
      ) {
        return cfWrapper;
      }
    },
  };
}

/**
 * Redirect @sentry/tanstackstart-react to a @sentry/cloudflare-backed shim in
 * the SSR environment. Its server half re-exports @sentry/node, which pulls
 * @sentry/node-core, @sentry/opentelemetry, seven @opentelemetry/* packages and
 * require/import-in-the-middle into the worker — ~600 KiB of Node-only code
 * that cannot run on workerd, welded into the eager root chunk because
 * router.tsx and components/route-error.tsx are isomorphic.
 *
 * SSR-only: the client build keeps the real package (browser tracing needs it).
 * See src/lib/sentry-cf-shim.ts for the exports it has to cover.
 */
function cfSentryShim(): Plugin {
  const shim = path.resolve(__dirname, "src/lib/sentry-cf-shim.ts");
  return {
    name: "cf-sentry-shim",
    enforce: "pre",
    applyToEnvironment(env) {
      return env.name === "ssr";
    },
    resolveId(source) {
      if (source === "@sentry/tanstackstart-react") return shim;
    },
  };
}

export default defineConfig(async ({ command, mode }) => {
  let enableDevLogin = false;
  if (command === "serve") {
    try {
      assertDevDatabaseUrl(process.env.DATABASE_URL);
      enableDevLogin = true;
    } catch {
      // Only the fixed local development database can enable this middleware.
    }
  }
  const r2PublicUrl = resolveR2PublicUrl(command, mode);
  // CF Workers build: use @cloudflare/vite-plugin (Vite Environment API).
  // Dev server runs without a deploy plugin (plain Node.js via vite dev).
  const deployPlugin: PluginOption[] = [];
  if (isCloudflare) {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    deployPlugin.push(cloudflare({ viteEnvironment: { name: "ssr" } }));
  }

  // Multi-worktree dev-server port resolution (see `server.port` below).
  const serverPort = Number(process.env.PORT) || 0;
  const inWorktree = isGitWorktree();

  return {
    envDir: ".", // Explicitly load .env from this directory
    // Resolve tsconfig `paths` (~/*, tooling/*) natively — Vite 8 replaces the
    // vite-tsconfig-paths plugin with this built-in option.
    resolve: { tsconfigPaths: true },
    // Consolidate the CLIENT build's request fan-out. Default Rolldown splitting
    // gives each route its own chunk (correct, keep) but also hoists every shared
    // leaf module into its own chunk. Phosphor's per-icon imports stay on the
    // default graph: grouping the whole library made a 612KB shared chunk,
    // while the default split added only a handful of requests in the build.
    // `experimentalMinChunkSize` does NOT fix this (it won't merge a chunk
    // shared across async boundaries), so we coalesce selected packages with
    // Rolldown's native code-splitting groups instead.
    //
    // Only these bounded groups are consolidated, and deliberately:
    //   - es-toolkit, date-fns, TanStack Router/Query, Floating UI, hook-form,
    //     Radix UI, and small runtime utilities are bounded shared
    //     families; entry-aware groups keep route-specific subsets local.
    // Application-owned server-function wrappers stay on Rolldown's default
    // graph: grouping image.functions created a cross-chunk initialization
    // cycle once authenticated routes shared entity-schema dependencies.
    // React stays on the default graph too: its entry-aware group merged a
    // Base UI timeout singleton into a cyclic chunk, crashing hydration.
    //   - @base-ui was tried and reverted: its grouped chunk is 243KB (80KB gzip)
    //     but the landing page only uses ~7KB of it, so grouping would drag
    //     lazy-route dialog/sheet code into first paint. Lazy-only deps (@nivo,
    //     markdown, cmdk) remain split for the same reason.
    // Scoped to `client` so it never reshapes the CF Worker SSR bundle (single entry).
    environments: {
      client: {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: { groups: clientCodeSplittingGroups },
            },
          },
        },
      },
    },
    // Compression reports are opt-in (CUBBY_BUNDLE_REPORT=1).
    build: { reportCompressedSize: process.env.CUBBY_BUNDLE_REPORT === "1" },
    // CF Workers build-time flag for dead code elimination in db.ts
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __SOURCE_COMMIT__: JSON.stringify(sourceCommit),
      __SOURCE_BRANCH__: JSON.stringify(sourceBranch),
      __BUILD_DATE__: JSON.stringify(sourceDate),
      __R2_PUBLIC_URL__: JSON.stringify(r2PublicUrl),
      __CF_WORKERS__: isCloudflare ? "true" : "false",
    },
    server: {
      host: "0.0.0.0",
      // Port resolution for multi-worktree dev (see README "Worktrees"):
      // - A preview harness can inject PORT when it picks a free port — bind
      //   exactly that (strictPort) so the preview attaches.
      // - No PORT: the main checkout is 3000-or-fail-loudly (never silent-drift);
      //   any linked Git worktree auto-finds a free port instead.
      port: serverPort || 3000,
      strictPort: serverPort ? true : !inWorktree,
      allowedHosts: ["nickys-macbook-air.tailnet-0eba.ts.net"],
    },
    ssr: {
      // Externalize OpenTelemetry packages to avoid ESM/CJS compatibility issues in dev.
      // Not needed for CF Workers builds — the cloudflare plugin handles bundling.
      external: isCloudflare
        ? []
        : [
            "@opentelemetry/sdk-node",
            "@opentelemetry/resources",
            "@opentelemetry/semantic-conventions",
            "@opentelemetry/auto-instrumentations-node",
            "@opentelemetry/exporter-trace-otlp-http",
          ],
    },
    plugins: [
      ...(enableDevLogin ? [viteDevLogin()] : []),
      // Permit the JS Self-Profiling API in dev (`window.__jsProfile`, see
      // lib/perf/js-self-profile.ts). The header must be on the SSR document, and
      // `server.headers` doesn't reach TanStack Start's response — set it via
      // middleware. `configureServer` only runs under `vite dev`, so prod never
      // gets it.
      {
        name: "js-self-profiling-header",
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader("Document-Policy", "js-profiling");
            next();
          });
        },
      } satisfies Plugin,
      // Deploy plugin must come first (Cloudflare plugin needs early hook)
      ...deployPlugin,
      mcpAppAsset(),
      // CF Workers WASM instantiation plugin must run before vite-plugin-wasm
      ...(isCloudflare
        ? [cfPgNativeStub(), cfWasmPlugin(), cfSentryShim()]
        : []),
      wasm(),
      devtools({
        // Keep the runtime devtools available to the production lazy chunk;
        // visibility is controlled by the persisted developer flag.
        removeDevtoolsOnBuild: false,
        injectSource: { enabled: false },
        // Disable the devtools server→browser console pipe (re-logs server output
        // in the browser console tagged [Server]). Vite 8's forwardConsole already
        // does browser→terminal (auto-on for coding agents), and the two opposite
        // pipes form an infinite server→browser→terminal→server loop seeded by any
        // server console.error (e.g. pg's "SSL modes" warning). We keep
        // forwardConsole — agents need client-side errors in the CLI — and drop
        // this leg; server logs are already visible directly in the terminal.
        consolePiping: { enabled: false },
      }),
      tailwindcss(),
      // tanstackStart must come BEFORE viteReact per TanStack Router plugin
      tanstackStart({
        serverFns: {
          generateFunctionId: createServerFunctionIdGenerator(),
        },
        router: {
          codeSplittingOptions: {
            // Keep the route component and its recovery UI in one request. Data
            // loaders and pending UI remain in their existing eager boundaries.
            defaultBehavior: [
              ["component", "errorComponent", "notFoundComponent"],
            ],
          },
          // Colocated unit tests (e.g. projects.index.unit.test.ts, which imports
          // the route's search schema) are not routes. Without this the generator
          // warns "does not export a Route" on every build/HMR pass. Matched
          // against the file's basename.
          routeFileIgnorePattern: "\\.(test|spec)\\.[jt]sx?$",
        },
      }),
      viteReact(),
      // Sentry source maps, CF production build only (the plugin already
      // no-ops under NODE_ENV=development). Last in `plugins` so it sees the
      // final client/server output. `autoInstrumentMiddleware` stays off: it
      // would inject `wrapMiddlewaresWithSentry` imports from
      // `@sentry/tanstackstart-react`, which the SSR build resolves to
      // `cfSentryShim` (no such export). Maps are "hidden" (no
      // `sourceMappingURL`), uploaded once per Vite environment from that
      // environment's own output dir, then deleted so none ship as public
      // assets. Map sources are output-relative (`../../src/x.ts` from
      // dist/server, `../../../src/x.ts` from dist/client/assets); rewriting
      // them repo-relative (`apps/web/src/x.ts`, `packages/schemas/src/y.ts`)
      // lets one Sentry code mapping (repo root -> repo root on main) resolve
      // browser and Worker frames. Without SENTRY_AUTH_TOKEN (PR/preview CI) the plugin warns,
      // skips the upload, and still injects debug IDs and deletes the maps.
      ...(isCloudflare && command === "build"
        ? [
            sentryTanstackStart({
              org: "nicky-semenza",
              project: "cubby",
              authToken: process.env.SENTRY_AUTH_TOKEN,
              telemetry: false,
              autoInstrumentMiddleware: false,
              release: {
                name: `cubby@${gitCommit}`, // must equal the runtime `release` in router.tsx and cf-server.ts
                setCommits: {
                  repo: "nickysemenza/cubby",
                  commit: process.env.CUBBY_SOURCE_COMMIT ?? fullSha,
                },
                deploy: { env: "production" },
              },
              sourcemaps: {
                // Resolve relative map sources against the map's own directory
                // so `apps/web/src/...` and workspace `packages/*/src/...` both
                // come out repo-relative (a fixed `apps/web/` prefix would
                // mangle the packages).
                rewriteSources: (source, _map, context) =>
                  /^\.\.?\//.test(source) && context?.mapDir
                    ? path
                        .relative(
                          repoRoot,
                          path.resolve(context.mapDir, source),
                        )
                        .split(path.sep)
                        .join("/")
                    : source,
                filesToDeleteAfterUpload: ["./dist/**/*.map"],
              },
            }),
          ]
        : []),
    ],
  };
});
