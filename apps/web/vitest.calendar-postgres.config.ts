import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const requirePg = createRequire(import.meta.resolve("pg"));

export default defineConfig({
  ssr: { noExternal: ["pg", "pg-protocol", "pg-connection-string"] },
  plugins: [
    {
      name: "calendar-workerd-wasm-init",
      enforce: "pre",
      load(id) {
        if (!id.endsWith("recipebridge_bg.wasm?init")) return;
        // Match production's CF Vite WASM initialization using workerd's real
        // compiled module, without Node filesystem reads or mocked exports.
        return `import module from ${JSON.stringify(id.slice(0, -5))}; export default (imports) => new WebAssembly.Instance(module, imports);`;
      },
    },
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: "./wrangler.calendar-test.jsonc" },
      // Local Hyperdrive supplies a connection URL; pg still opens real sockets
      // and executes canonical transactions against a disposable PostgreSQL DB.
      miniflare: {
        queueProducers: { BACKGROUND_QUEUE: "calendar-test-background" },
        bindings: {
          HYPERDRIVE: {
            connectionString: inject<string>("calendarDatabaseUrl"),
          },
        },
      },
    })),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: /^@cubby\/recipebridge$/,
        replacement: fileURLToPath(
          new URL("./src/lib/recipebridge-cf.ts", import.meta.url),
        ),
      },
      // Select pg's actual CJS/workerd exports rather than the test runner's
      // default ESM or empty non-workerd conditional targets.
      { find: /^pg-protocol$/, replacement: requirePg.resolve("pg-protocol") },
      {
        find: /^pg-cloudflare$/,
        replacement: requirePg
          .resolve("pg-cloudflare/package.json")
          .replace(/package\.json$/, "dist/index.js"),
      },
    ],
  },
  test: {
    name: "calendar-postgres-worker",
    include: ["src/server/calendar/**/*.postgres-worker.test.ts"],
    globalSetup: ["./tooling/calendar-postgres-setup.ts"],
    env: {
      SKIP_ENV_VALIDATION: "true",
      NODE_ENV: "test",
      USDA_API_URL: "http://localhost:8080",
      UPC_LOOKUP_API_URL: "http://localhost:8081",
      UPC_LOOKUP_API_KEY: "",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_ENDPOINT: "http://localhost:9000",
      R2_BUCKET_NAME: "test",
      R2_PUBLIC_URL: "http://localhost:9000",
      BETTER_AUTH_SECRET: "calendar-test-only-secret",
      BETTER_AUTH_URL: "https://calendar.test",
      AI_GATEWAY_API_KEY: "",
      NOTION_API_KEY: "",
    },
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
