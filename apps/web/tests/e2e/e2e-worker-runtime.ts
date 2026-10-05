import { request, type APIRequestContext } from "@playwright/test";
import type { PurchaseImportNamespace } from "~/server/purchase-import/run-service";

import {
  harnessExplorerUrl,
  sanitizeWorkerdLogs,
  type WorkerdLog,
} from "../../tooling/e2e-workerd-logs";
import { scenarioControls } from "../../tooling/purchase-agent-workerd-harness";
import { WORKERD_PROFILES } from "../../tooling/workerd-harness";
import {
  openWorkerdRuntime,
  type WorkerdRuntimeOptions,
} from "../../tooling/workerd-runtime";
import { createE2EDatabase } from "./e2e-database";

type E2EStorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

export async function authenticate(baseURL: string): Promise<E2EStorageState> {
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

/**
 * The browser runtime: a seeded `browser` database lease, local object
 * storage, and the built Worker under `profile`, optionally signed in.
 * `close()` releases all of it (see `openWorkerdRuntime`).
 */
export async function createE2EWorkerRuntime({
  authenticated,
  parallelIndex,
  profile = "offline",
  models,
  objectStorage = {},
}: {
  authenticated: boolean;
  parallelIndex: number;
  profile?: WorkerdRuntimeOptions["profile"];
  models?: WorkerdRuntimeOptions["models"];
  objectStorage?: NonNullable<WorkerdRuntimeOptions["objectStorage"]>;
}) {
  // Phase timings attribute a slow or failed worker start without a trace.
  let phaseStart = performance.now();
  const logPhase = (phase: string) => {
    const now = performance.now();
    console.log(
      `[E2E Worker ${parallelIndex}] ${phase} ${Math.round(now - phaseStart)}ms`,
    );
    phaseStart = now;
  };
  const {
    runtime,
    prepared: { storageState, objectStorageUrl },
  } = await openWorkerdRuntime(
    {
      profile,
      database: { lease: createE2EDatabase },
      objectStorage,
      models,
      onPhase: logPhase,
    },
    async ({ origin, objectStorageUrl }) => {
      if (!objectStorageUrl)
        throw new Error("The browser runtime always starts object storage");
      const state = authenticated
        ? await authenticate(origin)
        : { cookies: [], origins: [] };
      logPhase("auth");
      return { storageState: state, objectStorageUrl };
    },
  );
  const { harness, origin: baseURL } = runtime;
  const explorerUrl = harnessExplorerUrl(baseURL);
  console.log(
    `[E2E Worker ${parallelIndex}] ${runtime.databaseName} at ${baseURL} (explorer ${explorerUrl})`,
  );

  return {
    baseURL,
    databaseUrl: runtime.databaseUrl,
    objectStorageUrl,
    googleProvider: runtime.googleProvider,
    /** The workerd harness, for peers a lane reads directly. */
    harness,
    /** The scripted coordinator and gateway, when the profile has them. */
    purchaseAgent: WORKERD_PROFILES[profile].purchaseAgentPeers
      ? scenarioControls(harness)
      : undefined,
    async browserNamespace(): Promise<PurchaseImportNamespace> {
      return (
        await harness
          .getWorker<{ PURCHASE_IMPORT: PurchaseImportNamespace }>()
          .getEnv()
      ).PURCHASE_IMPORT;
    },
    storageState,
    /** Bindings, Durable Object, queue and R2 explorer of this live harness. */
    explorerUrl,
    /** Sanitized workerd logs since the last `clearLogs()`. */
    getLogs: (): WorkerdLog[] => sanitizeWorkerdLogs(harness.getLogs()),
    clearLogs: () => harness.clearLogs(),
    close: runtime.close,
  };
}

export type E2EWorkerRuntime = Awaited<
  ReturnType<typeof createE2EWorkerRuntime>
>;
