import { request, type APIRequestContext } from "@playwright/test";
import { type TestHarness } from "wrangler";

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

type E2EStorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

export interface E2EWorkerRuntime {
  baseURL: string;
  databaseUrl: string;
  objectStorageUrl: string;
  storageState: E2EStorageState;
  debug(): void;
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

    harness = createLocalWorkerdHarness(
      database.databaseUrl,
      objectStorage.url,
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
      objectStorageUrl: objectStorage.url,
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
