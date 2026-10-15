import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Resolve the Worker suites and their Cloudflare plugin from this package.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      miniflare: {
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
      wrangler: {
        configPath: fileURLToPath(
          new URL("../web/wrangler.calendar-test.jsonc", import.meta.url),
        ),
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
    // As the web app's SSR build does (recipebridgePlugin in
    // apps/web/vite.config.ts): a bare wasm-bindgen import is never
    // instantiated in workerd, so `__wbindgen_start is not a function`.
    alias: [
      {
        find: /^@cubby\/recipebridge$/,
        replacement: fileURLToPath(
          new URL("recipebridge-workerd.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: "calendar-worker",
    // workerd cannot read Vitest 5's transformed modules from the host filesystem.
    fsModuleCache: false,
    include: [
      "../web/src/server/calendar/**/*.workers.test.ts",
      "../web/src/server/database-freshness/**/*.workers.test.ts",
      "../web/src/server/purchase-import/**/*.workers.test.ts",
      "../web/src/server/ai/**/*.workers.test.ts",
      "../web/src/server/usda-release/**/*.workers.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
