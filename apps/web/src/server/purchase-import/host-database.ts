import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { db, withRequestDbClient, type Database } from "~/server/db";
import { assertNotInMaintenance } from "~/server/maintenance";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * One purchase-import host call's database scope: refused in maintenance,
 * with this Worker's bindings, on its own Hyperdrive client.
 */
export function withHostDatabase<T>(
  env: Env,
  ctx: HostContext,
  fn: (database: Database) => Promise<T>,
): Promise<T> {
  assertNotInMaintenance(env);
  setCfEnv(env);
  return runWithExecutionCtx(ctx, () =>
    withRequestDbClient(env.HYPERDRIVE.connectionString, () => fn(db)),
  );
}
