import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import viteTsConfigPaths from "vite-tsconfig-paths";

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitCommit = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
}).trim();
const gitCommitMsg = execSync("git log -1 --pretty=%s", {
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

export default defineConfig(async () => {
  // CF Workers build: use @cloudflare/vite-plugin (Vite Environment API).
  // Dev server runs without a deploy plugin (plain Node.js via vite dev).
  const deployPlugin: PluginOption[] = [];
  if (isCloudflare) {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    deployPlugin.push(cloudflare({ viteEnvironment: { name: "ssr" } }));
  }

  return {
    envDir: ".", // Explicitly load .env from this directory
    // CF Workers build-time flag for dead code elimination in db.ts
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __GIT_COMMIT_MSG__: JSON.stringify(gitCommitMsg),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
      ...(isCloudflare ? { __CF_WORKERS__: "true" } : {}),
    },
    server: {
      host: "0.0.0.0",
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
      // Deploy plugin must come first (Cloudflare plugin needs early hook)
      ...deployPlugin,
      // CF Workers WASM instantiation plugin must run before vite-plugin-wasm
      ...(isCloudflare ? [cfPgNativeStub(), cfWasmPlugin()] : []),
      wasm(),
      devtools({
        injectSource: { enabled: false },
      }),
      viteTsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      // tanstackStart must come BEFORE viteReact per TanStack Router plugin
      tanstackStart(),
      viteReact(),
    ],
  };
});
