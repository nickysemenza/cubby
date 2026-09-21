import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("../web", import.meta.url));

/**
 * Cloudflare's latest test plugin still relies on Vitest 4 internals. Keep its
 * workerd-only harness isolated while the rest of the monorepo runs Vitest 5.
 */
export default defineConfig({
  root: webRoot,
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
      "src/server/calendar/**/*.workers.test.ts",
      "src/server/database-freshness/**/*.workers.test.ts",
      "src/server/purchase-import/**/*.workers.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
