import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { z } from "zod";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const environmentKeys = [
  "E2E_DATABASE_URL",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
] as const;

/** Point the production Worker build at a local PostgreSQL database. */
export function installDatabaseEnvironment(databaseUrl: string) {
  const previous = new Map<
    (typeof environmentKeys)[number],
    string | undefined
  >();
  for (const key of environmentKeys) previous.set(key, process.env[key]);
  process.env.E2E_DATABASE_URL = databaseUrl;
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
    databaseUrl;
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED =
    databaseUrl;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Run the built Cubby Worker with local bindings and offline external peers. */
export function createLocalWorkerdHarness(
  databaseUrl: string,
  objectStorageUrl: string,
) {
  const compatibilityDate = z
    .object({ compatibility_date: z.string() })
    .parse(
      JSON.parse(
        readFileSync(
          path.join(webRoot, "dist/server/wrangler.e2e.json"),
          "utf8",
        ),
      ),
    ).compatibility_date;

  return createTestHarness({
    root: webRoot,
    workers: [
      {
        configPath: "dist/server/wrangler.e2e.json",
        vars: {
          ALLOW_SIGNUP: "true",
          INSECURE_AUTH_COOKIES: "true",
          E2E_AUTH_TEST_MODE: "true",
          DATABASE_URL: databaseUrl,
          R2_ENDPOINT: objectStorageUrl,
          R2_PUBLIC_URL: objectStorageUrl,
          R2_BUCKET_NAME: "e2e-bucket",
          R2_KEY_PREFIX: "e2e",
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          USDA_API_URL: "http://127.0.0.1:9/",
          // Keep local runs keyless and deterministic like CI.
          AI_GATEWAY_API_KEY: "",
        },
        secrets: {
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
        },
        bindingOverrides: {
          USDA_API: "local-offline-peers",
          UPC_LOOKUP: "local-offline-peers",
          PURCHASE_AGENT: "local-offline-peers",
        },
      },
      {
        config: {
          name: "local-offline-peers",
          main: "tooling/local-offline-peers.ts",
          compatibility_date: compatibilityDate,
          queues: {
            consumers: [
              { queue: "cubby-background", max_batch_timeout: 0 },
              { queue: "cubby-telemetry", max_batch_timeout: 0 },
            ],
          },
        },
      },
    ],
  });
}
