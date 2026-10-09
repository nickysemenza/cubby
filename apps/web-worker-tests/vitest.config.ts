import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Durable Object implementations import the database module statically.
// `pg` is CommonJS, and the pool resolves its `require("pg-protocol")` with
// the `import` condition (ESM), which CommonJS cannot evaluate; point it at
// the package's CommonJS build.
const pgRequire = createRequire(
  createRequire(new URL("../web/package.json", import.meta.url)).resolve("pg"),
);
const pgProtocolCommonJs = pgRequire.resolve("pg-protocol");

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
  // The Worker build's define (`vite.config.ts`): these suites run in workerd.
  define: { __CF_WORKERS__: "true" },
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: /^pg-protocol$/u, replacement: pgProtocolCommonJs },
      {
        find: /^@cubby\/recipebridge$/u,
        replacement: fileURLToPath(
          new URL("./recipebridge.js", import.meta.url),
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
