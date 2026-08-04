import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import { isGitWorktree } from "./tooling/git-worktree";

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitCommit = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
}).trim();
const gitCommitMsg = execSync("git log -1 --pretty=%s", {
  encoding: "utf-8",
}).trim();
const gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
  encoding: "utf-8",
}).trim();

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

export default defineConfig(async () => {
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
    // Consolidate the CLIENT build's request fan-out. Default Rollup splitting
    // gives each route its own chunk (correct, keep) but also hoists every shared
    // leaf module into its own chunk — so a single `import { Clock } from
    // "lucide-react"` used by 2+ routes became a standalone ~1KB chunk. lucide
    // alone fanned out into ~68 of these, i.e. dozens of HTTP requests for a few
    // KB. experimentalMinChunkSize does NOT fix this (it won't merge a chunk
    // shared across async boundaries), so we coalesce lucide by-package instead.
    //
    // Only lucide is grouped, and deliberately so:
    //   - Icons are tiny + ubiquitous: the whole set is 39KB (13KB gzip), already
    //     eager via the nav, so forcing the full set eager costs ~12KB to save
    //     ~50 requests — a clear win.
    //   - @base-ui was tried and reverted: its grouped chunk is 243KB (80KB gzip)
    //     but the landing page only uses ~7KB of it, so grouping would drag
    //     lazy-route dialog/sheet code into first paint. Left split on purpose.
    //   - Lazy-only deps (@nivo, markdown, cmdk) are untouched and stay
    //     code-split, so first paint never pulls them in.
    // Scoped to `client` so it never reshapes the CF Worker SSR bundle (single entry).
    environments: {
      client: {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id: string) {
                if (id.includes("/lucide-react/")) return "icons";
              },
            },
          },
        },
      },
    },
    // CF Workers build-time flag for dead code elimination in db.ts
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __GIT_COMMIT_MSG__: JSON.stringify(gitCommitMsg),
      __GIT_BRANCH__: JSON.stringify(gitBranch),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
      ...(isCloudflare ? { __CF_WORKERS__: "true" } : {}),
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
      // CF Workers WASM instantiation plugin must run before vite-plugin-wasm
      ...(isCloudflare
        ? [cfPgNativeStub(), cfWasmPlugin(), cfSentryShim()]
        : []),
      wasm(),
      devtools({
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
        router: {
          // Colocated unit tests (e.g. projects.index.unit.test.ts, which imports
          // the route's search schema) are not routes. Without this the generator
          // warns "does not export a Route" on every build/HMR pass. Matched
          // against the file's basename.
          routeFileIgnorePattern: "\\.(test|spec)\\.[jt]sx?$",
        },
      }),
      viteReact(),
    ],
  };
});
