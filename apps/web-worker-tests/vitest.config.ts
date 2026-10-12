import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Cloudflare's test plugin still relies on Vitest 4 internals. Keep this
 * package as the resolver root so `/vitest/worker` cannot resolve the web
 * app's Vitest 5 installation; the suites themselves remain beside the code.
 */
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
