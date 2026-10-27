import "./build-constants";
import { request } from "@playwright/test";
import { z } from "zod";
import { testUserId } from "@cubby/schemas/testing";
import { createPostgresPool } from "#web/tooling/postgres-pool.ts";
import {
  buildKernelContext,
  buildScenarioDatabase,
} from "#web/tooling/scenarios/context.ts";
import { retryStaleKeepAlive } from "#web/tooling/stale-keep-alive.ts";
import { withDerivedRefresh } from "./derived-refresh";
import { createE2EWorkerRuntime } from "./e2e-worker-runtime";

/** A test-scoped lease and authenticated scenario context, shared by browser engines. */
export async function withSeededE2ERuntime<T>(
  options: Omit<Parameters<typeof createE2EWorkerRuntime>[0], "authenticated">,
  run: (world: {
    runtime: Awaited<ReturnType<typeof createE2EWorkerRuntime>>;
    client: Awaited<ReturnType<typeof request.newContext>>;
    pool: ReturnType<typeof createPostgresPool>;
    context: ReturnType<typeof buildKernelContext>;
    userId: string;
  }) => Promise<T>,
): Promise<T> {
  // Async disposal preserves a body failure together with any cleanup failure.
  await using cleanup = new AsyncDisposableStack();
  const runtime = await createE2EWorkerRuntime({
    ...options,
    authenticated: true,
  });
  cleanup.defer(runtime.close);
  const client = await request.newContext({
    baseURL: runtime.baseURL,
    storageState: runtime.storageState,
  });
  cleanup.defer(() => client.dispose());
  retryStaleKeepAlive(client);
  const session = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await (await client.get("/api/auth/get-session")).json());
  const pool = createPostgresPool({ connectionString: runtime.databaseUrl });
  cleanup.defer(() => pool.end());
  const db = buildScenarioDatabase(pool);
  const execute = () =>
    run({
      runtime,
      client,
      pool,
      userId: session.user.id,
      context: buildKernelContext(db, testUserId(session.user.id)),
    });
  return await (options.profile === "offline"
    ? withDerivedRefresh(db, execute)
    : execute());
}
