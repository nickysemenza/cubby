import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request, type APIRequestContext } from "@playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";

import {
  closeE2EWorkerResources,
  type E2EWorkerResources,
} from "../../tooling/e2e-worker-resources";
import { createE2EDatabase } from "./e2e-database";
import { createE2EObjectStorage } from "./e2e-object-storage";
import {
  ensureHarnessServiceBundles,
  type HarnessServiceBundles,
} from "./harness-services/bundle";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.join(__dirname, "../..");
const e2eConfigPath = "dist/server/wrangler.e2e.json";
const e2eEnvironmentKeys = [
  "E2E_DATABASE_URL",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
] as const;

type E2EStorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;
type EnvironmentKey = (typeof e2eEnvironmentKeys)[number];

export interface E2EWorkerRuntime {
  baseURL: string;
  databaseUrl: string;
  storageState: E2EStorageState;
  debug(): void;
  close(): Promise<void>;
}

/** Exported for tooling/dev-db-seed.ts, which needs this before its own `createHarness` call too. */
export function installDatabaseEnvironment(databaseUrl: string) {
  const previous = new Map<EnvironmentKey, string | undefined>();
  for (const key of e2eEnvironmentKeys) previous.set(key, process.env[key]);
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

/** Exported for tooling/dev-db-seed.ts, which points this at the persistent dev database. */
export function createHarness(
  databaseUrl: string,
  objectStorageUrl: string,
  harnessServiceBundles: HarnessServiceBundles,
) {
  const compatibilityDate = z
    .object({ compatibility_date: z.string() })
    .parse(
      JSON.parse(readFileSync(path.join(webRoot, e2eConfigPath), "utf8")),
    ).compatibility_date;

  return createTestHarness({
    root: webRoot,
    workers: [
      {
        configPath: e2eConfigPath,
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
          // Keyless like CI (emptyStringAsUndefined), so a local .env key never
          // turns E2E into slow, billed, nondeterministic model calls: every
          // AI operation takes the same fast "not configured" path everywhere.
          AI_GATEWAY_API_KEY: "",
        },
        secrets: {
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
        },
        bindingOverrides: {
          USDA_API: "e2e-usda-empty",
          UPC_LOOKUP: "e2e-upc-empty",
          PURCHASE_AGENT: "e2e-purchase-agent-empty",
        },
      },
      {
        config: {
          name: "e2e-usda-empty",
          main: harnessServiceBundles.usdaEmpty,
          no_bundle: true,
          compatibility_date: compatibilityDate,
        },
      },
      {
        config: {
          name: "e2e-upc-empty",
          main: harnessServiceBundles.upcEmpty,
          no_bundle: true,
          compatibility_date: compatibilityDate,
        },
      },
      {
        config: {
          name: "e2e-purchase-agent-empty",
          main: harnessServiceBundles.purchaseAgentEmpty,
          no_bundle: true,
          compatibility_date: compatibilityDate,
        },
      },
      {
        config: {
          name: "e2e-queue-sink",
          main: harnessServiceBundles.queueSink,
          no_bundle: true,
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

async function authenticate(baseURL: string): Promise<E2EStorageState> {
  const email = process.env.E2E_TEST_USER_EMAIL;
  const password = process.env.E2E_TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "E2E_TEST_USER_EMAIL and E2E_TEST_USER_PASSWORD are required for authenticated browser tests",
    );
  }

  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  try {
    const signUp = await context.post("/api/auth/sign-up/email", {
      data: { email, password, name: "E2E Test User" },
    });
    const response = signUp.ok()
      ? signUp
      : await context.post("/api/auth/sign-in/email", {
          data: { email, password },
        });
    if (!response.ok()) {
      throw new Error(
        `Failed to authenticate E2E user: ${response.status()} - ${await response.text()}`,
      );
    }

    const state = await context.storageState();
    state.cookies = state.cookies.filter(
      (cookie) => !cookie.name.endsWith("session_data"),
    );
    return state;
  } finally {
    await context.dispose();
  }
}

export async function createE2EWorkerRuntime({
  authenticated,
  parallelIndex,
}: {
  authenticated: boolean;
  parallelIndex: number;
}): Promise<E2EWorkerRuntime> {
  const resources: E2EWorkerResources = {};
  let restoreEnvironment = () => {};
  let harness: TestHarness | undefined;
  // Phase timings attribute a slow or failed worker start without a trace.
  let phaseStart = performance.now();
  const logPhase = (phase: string) => {
    const now = performance.now();
    console.log(
      `[E2E Worker ${parallelIndex}] ${phase} ${Math.round(now - phaseStart)}ms`,
    );
    phaseStart = now;
  };
  try {
    const database = await createE2EDatabase();
    logPhase("database checkout");
    resources.database = database;
    restoreEnvironment = installDatabaseEnvironment(database.databaseUrl);

    const objectStorage = await createE2EObjectStorage();
    resources.objectStorage = objectStorage;
    logPhase("object storage");

    const harnessServiceBundles = await ensureHarnessServiceBundles();
    harness = createHarness(
      database.databaseUrl,
      objectStorage.url,
      harnessServiceBundles,
    );
    resources.harness = harness;
    const { url } = await harness.listen();
    const baseURL = url.origin;
    logPhase("harness create+listen");
    const storageState = authenticated
      ? await authenticate(baseURL)
      : { cookies: [], origins: [] };
    logPhase("auth");

    console.log(`[E2E Worker ${parallelIndex}] ${database.name} at ${baseURL}`);

    let closed = false;
    return {
      baseURL,
      databaseUrl: database.databaseUrl,
      storageState,
      debug: () => harness?.debug(),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await closeE2EWorkerResources(resources);
        } finally {
          restoreEnvironment();
        }
      },
    };
  } catch (error) {
    try {
      harness?.debug();
      await closeE2EWorkerResources(resources);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "E2E worker setup and cleanup failed",
        { cause: cleanupError },
      );
    } finally {
      restoreEnvironment();
    }
    throw error;
  }
}
