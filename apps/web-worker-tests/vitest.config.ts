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
      wrangler: {
        configPath: fileURLToPath(
          new URL("../web/wrangler.calendar-test.jsonc", import.meta.url),
        ),
      },
    }),
  ],
  resolve: { tsconfigPaths: true },
  test: {
    name: "calendar-worker",
    include: [
      "../web/src/server/calendar/**/*.workers.test.ts",
      "../web/src/server/database-freshness/**/*.workers.test.ts",
      "../web/src/server/purchase-import/**/*.workers.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
