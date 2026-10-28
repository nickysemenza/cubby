import { createLogger } from "@cubby/worker-tracing";

import { mergeDatabaseChanges, type DatabaseChanges } from "~/lib/doorbell";
import { afterResponse, getDatabaseFreshnessNamespace } from "~/server/cf-env";

export { recordDatabaseWrite } from "./member-marker";

const log = createLogger("database-freshness");

// The first RPC after a deploy cold-starts the Durable Object, measured at up
// to ~2.5s; a tighter bound drops write notifications and leaves cached reads stale.
const DATABASE_FRESHNESS_RPC_TIMEOUT_MS = 5000;
const getPort = () =>
  getDatabaseFreshnessNamespace()?.getByName("household", {
    locationHint: "wnam",
  });

/** Failure cannot turn an already committed write into a failed save. */
export async function notifyDatabaseChanges(
  changes: DatabaseChanges,
): Promise<void> {
  try {
    const target = getPort();
    if (!target) return;
    await afterResponse(
      boundedRpc(async () => {
        const bounded: DatabaseChanges = {};
        mergeDatabaseChanges(bounded, changes);
        await target.publishChanges(bounded);
      }).catch((error: unknown) => {
        log.warn("change notification failed", { error });
      }),
    );
  } catch (error) {
    log.warn("change notification unavailable", { error });
  }
}

async function boundedRpc<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database freshness RPC timed out")),
          DATABASE_FRESHNESS_RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
