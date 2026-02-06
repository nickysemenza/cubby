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
  // CF Workers: use @cloudflare/vite-plugin (Vite Environment API) instead of
  // Nitro. This handles Worker bundling, bindings, and the workerd runtime.
  const deployPlugin: PluginOption[] = [];
  if (isCloudflare) {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    deployPlugin.push(cloudflare({ viteEnvironment: { name: "ssr" } }));
  } else {
    const { nitro } = await import("nitro/vite");
    const preset =
      (process.env.NITRO_PRESET as "vercel" | "node-server") || "vercel";
    deployPlugin.push(
      nitro({
        preset,
        // Force bundle captcha packages from better-auth-ui (unused but cause ESM/CJS issues)
        noExternals: [
          "@hcaptcha/react-hcaptcha",
          "@hcaptcha/loader",
          "@captchafox/react",
          "@marsidev/react-turnstile",
          "@wojtekmaj/react-recaptcha-v3",
          "react-google-recaptcha",
          "@daveyplate/better-auth-ui",
        ],
        // chokidar 3.x (via @tanstack/router-plugin) imports fsevents native
        // addon (.node binary) that Rollup can't parse. Mark as external.
        rollupConfig: {
          external: ["fsevents"],
        },
      }),
    );
  }

  return {
    envDir: ".", // Explicitly load .env from this directory
    // CF Workers build-time flag for dead code elimination in db.ts
    define: isCloudflare ? { __CF_WORKERS__: "true" } : {},
    // CF Workers: alias `pg` to a shim that re-exports from @neondatabase/serverless.
    // The pg package imports pg-native (optional native addon) which can't resolve
    // in Workers. The shim provides real pg-types (builtins, getTypeParser, etc.)
    // needed by drizzle-orm's neon-serverless session.
    resolve: isCloudflare
      ? { alias: { pg: path.resolve(__dirname, "src/lib/pg-cf-shim.ts") } }
      : undefined,
    server: {
      host: "0.0.0.0",
      allowedHosts: ["nickys-macbook-air.tailnet-0eba.ts.net"],
    },
    ssr: {
      // Externalize OpenTelemetry packages to avoid ESM/CJS compatibility issues.
      // Not needed for CF Workers — the cloudflare plugin handles bundling.
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
      ...(isCloudflare ? [cfWasmPlugin()] : []),
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
