import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Calendar protocol tests run in workerd with real Durable Object SQLite
 * storage. They intentionally use a narrow Worker entrypoint rather than the
 * full application Worker, whose unrelated bindings would obscure calendar
 * storage and HTTP behavior.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.calendar-test.jsonc" },
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
