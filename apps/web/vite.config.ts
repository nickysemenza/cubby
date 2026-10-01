import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import {
  defineConfig,
  type BuildEnvironmentOptions,
  type Plugin,
  type PluginOption,
} from "vite";
import wasm from "vite-plugin-wasm";
import { mcpAppAsset } from "./tooling/mcp-app-asset.ts";
import { createServerFunctionIdGenerator } from "./tooling/server-function-id.ts";
import { resolveDevProfile } from "../../scripts/lib/dev-profile.ts";
import { writeLocalDevConfig } from "./tooling/dev/config.ts";
import {
  createLocalDevPeers,
  createLocalDevPeerPlugins,
} from "./tooling/dev/config.ts";
import { readR2PublicUrlFromWrangler } from "./tooling/wrangler-public-config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Generated output is never committed; bring it current before any module
// graph (or TanStack's route scan) reads it. A no-op when inputs are unchanged.
execFileSync(process.execPath, ["../../scripts/generator/ensure.ts"], {
  cwd: import.meta.dirname,
  stdio: "inherit",
});

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
 * take wrangler.jsonc; local development takes the supervisor's local origin
 * so image transformations and storage URLs agree with the Worker.
 */
const resolveR2PublicUrl = (localOrigin: string | undefined) =>
  localOrigin ?? wranglerR2PublicUrl;

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
/**
 * A shimmed or stubbed module missing a named export (e.g. a `Sentry.*` call
 * absent from sentry-cf-shim.ts) is `undefined` at runtime and only throws on
 * the error path. Fail the SSR build instead. Vite's own handler only logs an
 * "error"-level log, so this has to throw.
 */
const failOnUndefinedImport: NonNullable<
  BuildEnvironmentOptions["rolldownOptions"]
>["onLog"] = (level, log, handler) => {
  if (log.code === "IMPORT_IS_UNDEFINED") throw new Error(log.message);
  handler(level, log);
};

/**
 * zod's namespace re-exports every locale, and better-auth reads that
 * namespace by computed key, so all ~50 locales (~270 KB) stayed in the Worker.
 * The app only uses zod's default English messages.
 */
function cfZodLocalesStub(): Plugin {
  return {
    name: "cf-zod-locales-stub",
    enforce: "pre",
    applyToEnvironment(env) {
      return env.name === "ssr";
    },
    resolveId(source, importer) {
      if (
        source === "../locales/index.js" &&
        /\/zod\/v4\/(classic|core|mini)\//.test(
          importer?.replaceAll("\\", "/") ?? "",
        )
      )
        return (
          path.join(path.dirname(importer), "../locales/en.js") + "?en-only"
        );
    },
    load(id) {
      if (id.endsWith("?en-only"))
        return `export { default as en } from ${JSON.stringify(id.slice(0, -"?en-only".length))};`;
    },
  };
}

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

export default defineConfig(async ({ command }) => {
  const local =
    command === "serve" || process.env.CUBBY_DEV_PREVIEW_BUILD === "true";
  const profile = local ? resolveDevProfile(repoRoot) : undefined;
  if (command === "serve" && !process.env.CUBBY_DEV_ID)
    throw new Error(
      "Start local development with pnpm dev (the supervisor prepares the database and local resources)",
    );
  const r2PublicUrl = resolveR2PublicUrl(profile?.origin);
  // Development and production share the Cloudflare Vite Environment runtime.
  const deployPlugin: PluginOption[] = [];
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  if (profile) {
    deployPlugin.push(...(await createLocalDevPeerPlugins(profile)));
    const peers = await createLocalDevPeers(profile);
    deployPlugin.push(
      cloudflare({
        configPath: await writeLocalDevConfig(profile),
        viteEnvironment: { name: "ssr" },
        auxiliaryWorkers: peers.auxiliaryWorkers,
        // The plugin and Wrangler CLI append v3; the programmatic proxy does not.
        persistState: { path: path.join(profile.stateDir, "cloudflare") },
        inspectorPort: profile.inspectorPort,
        remoteBindings: profile.profile === "integrations",
      }),
    );
  } else deployPlugin.push(cloudflare({ viteEnvironment: { name: "ssr" } }));

  const serverPort = Number(process.env.PORT) || 3000;

  return {
    envDir: local ? (false as const) : ".",
    ...(profile && { cacheDir: path.join(profile.stateDir, "vite") }),
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
    // graph: grouping the image operation wrappers created a cross-chunk initialization
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
      ssr: {
        build: {
          // Vite leaves server output unminified by default; minified, the
          // Worker upload drops from ~30 MB to ~16 MB. Names are kept so error
          // names and stack frames stay readable.
          minify: true,
          rolldownOptions: {
            onLog: failOnUndefinedImport,
            output: { keepNames: true },
          },
        },
      },
    },
    // Compression reports are opt-in (CUBBY_BUNDLE_REPORT=1).
    build: { reportCompressedSize: process.env.CUBBY_BUNDLE_REPORT === "1" },
    // CF Workers build-time flag for dead code elimination in db.ts
    define: {
      "import.meta.env.CUBBY_LOCAL_RUNTIME": JSON.stringify(local),
      "import.meta.env.CUBBY_LOCAL_TELEMETRY": JSON.stringify(
        process.env.CUBBY_DEV_TELEMETRY === "true",
      ),
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __SOURCE_COMMIT__: JSON.stringify(sourceCommit),
      __SOURCE_BRANCH__: JSON.stringify(sourceBranch),
      __BUILD_DATE__: JSON.stringify(sourceDate),
      __R2_PUBLIC_URL__: JSON.stringify(r2PublicUrl),
      __CF_WORKERS__: "true",
    },
    server: {
      host: local ? "localhost" : "0.0.0.0",
      // The supervisor already selected and advertised this origin.
      port: serverPort,
      strictPort: true,
      allowedHosts: ["nickys-macbook-air.tailnet-0eba.ts.net"],
    },
    plugins: [
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
      cfPgNativeStub(),
      cfWasmPlugin(),
      cfSentryShim(),
      cfZodLocalesStub(),
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
      ...(command === "build"
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
