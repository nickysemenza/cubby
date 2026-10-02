import { request, type APIRequestContext } from "@playwright/test";
import { type TestHarness } from "wrangler";
import type { PurchaseImportNamespace } from "~/server/purchase-import/run-service";

import {
  closeE2EWorkerResources,
  type E2EWorkerResources,
} from "../../tooling/e2e-worker-resources";
import {
  createLocalWorkerdHarness,
  installDatabaseEnvironment,
} from "../../tooling/local-workerd-harness";
import { createE2EDatabase } from "./e2e-database";
import { createE2EObjectStorage } from "../../tooling/local-object-storage";
import {
  createLocalGoogleProvider,
  type LocalGoogleProvider,
} from "../../tooling/local-google-provider";
import {
  harnessExplorerUrl,
  sanitizeWorkerdLogs,
  type WorkerdLog,
} from "../../tooling/e2e-workerd-logs";

type E2EStorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

export interface E2EWorkerRuntime {
  baseURL: string;
  databaseUrl: string;
  objectStorageUrl: string;
  googleProvider?: LocalGoogleProvider;
  browserNamespace(): Promise<PurchaseImportNamespace>;
  storageState: E2EStorageState;
  /** Bindings, Durable Object, queue and R2 explorer of this live harness. */
  explorerUrl: string;
  /** Sanitized workerd logs since the last `clearLogs()`. */
  getLogs(): WorkerdLog[];
  clearLogs(): void;
  close(): Promise<void>;
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
  gmailJourney = false,
}: {
  authenticated: boolean;
  parallelIndex: number;
  gmailJourney?: boolean;
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

    const googleProvider = gmailJourney
      ? await createLocalGoogleProvider()
      : undefined;
    resources.googleProvider = googleProvider;

    harness = createLocalWorkerdHarness(
      database.databaseUrl,
      objectStorage.url,
      false,
      googleProvider?.url,
    );
    resources.harness = harness;
    const { url } = await harness.listen();
    const baseURL = url.origin;
    logPhase("harness create+listen");
    const storageState = authenticated
      ? await authenticate(baseURL)
      : { cookies: [], origins: [] };
    logPhase("auth");

    const explorerUrl = harnessExplorerUrl(baseURL);
    console.log(
      `[E2E Worker ${parallelIndex}] ${database.name} at ${baseURL} (explorer ${explorerUrl})`,
    );

    let closed = false;
    return {
      baseURL,
      databaseUrl: database.databaseUrl,
      objectStorageUrl: objectStorage.url,
      googleProvider,
      async browserNamespace() {
        if (!harness) throw new Error("Browser harness is closed");
        return (
          await harness
            .getWorker<{ PURCHASE_IMPORT: PurchaseImportNamespace }>()
            .getEnv()
        ).PURCHASE_IMPORT;
      },
      storageState,
      explorerUrl,
      getLogs: () => sanitizeWorkerdLogs(harness?.getLogs() ?? []),
      clearLogs: () => harness?.clearLogs(),
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
