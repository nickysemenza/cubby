import { jobState } from "@cubby/schemas/job";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";

import { getExecutionCtx, getImageProcessingNamespace } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import { recordJobInvalidation } from "~/server/generic/jobs/repo/jobs";

import type { ImageProcessingCompanionRpc } from "./companion-rpc";

const log = createLogger("image-processing");

type ImageProcessingStub = ReturnType<
  NonNullable<ReturnType<typeof getImageProcessingNamespace>>["getByName"]
>;

function companionRpc(value: ImageProcessingStub): ImageProcessingCompanionRpc {
  // SAFETY: this binding names ImageProcessingDurableObject, whose public RPC
  // surface implements ImageProcessingCompanionRpc.
  return value as ImageProcessingCompanionRpc;
}

/**
 * Ring every connected companion now and return how many the doorbell
 * reached; a missing binding or no open socket reaches none (0). A doorbell
 * RPC failure throws: it is not the same as reaching nobody.
 */
export async function ringImageProcessingCompanionsOrThrow(): Promise<number> {
  const namespace = getImageProcessingNamespace();
  if (!namespace) return 0;
  return companionRpc(namespace.getByName("household")).ring();
}

/** Best-effort ring for paths with another wake behind them; failures are logged. */
export async function ringImageProcessingCompanions(): Promise<number> {
  try {
    return await ringImageProcessingCompanionsOrThrow();
  } catch (error) {
    // A lost ring only delays work: a companion pulls again on connect, and
    // the durable device wake rings for work that comes due later.
    log.warn("companion ring failed", { error });
    return 0;
  }
}

const ringing = new WeakSet<object>();

/**
 * Ring companions once after the enqueuing transaction commits. Device work
 * is parked for device pulls; the server drain never polls it.
 */
export async function ringImageProcessingCompanionsAfterCommit(
  db: Database | DrizzleTransaction,
) {
  if (ringing.has(db)) return;
  ringing.add(db);
  await runAfterCommit(db, async () => {
    const ring = ringImageProcessingCompanions();
    const ctx = getExecutionCtx();
    if (ctx) ctx.waitUntil(ring);
    else await ring;
  });
}

/**
 * The durable device wake: one Job (`image.device.wake`) that rings
 * companions when parked device work comes due. `image.device` is never
 * drained, so without it work whose backoff or abandoned lease expires while
 * every device idles would wait for an unrelated save, pull or connect.
 */
export const DEVICE_WAKE_KEY = "image.device.wake";

/**
 * Arm the wake in the caller's transaction whenever parked device work gets
 * a later availability or a lease. A durable invalidation (restarting) of
 * the wake's own Job, so an arm that lands while a wake page runs supersedes
 * it and is never lost; the woken page recomputes its schedule from Job rows.
 */
export async function armDeviceWake(db: Database) {
  await recordJobInvalidation(db, {
    key: DEVICE_WAKE_KEY,
    kind: DEVICE_WAKE_KEY,
    input: {},
    restartsPass: true,
  });
}

/**
 * Whether parked device work is claimable now (due, or a lapsed lease), and
 * when the earliest later work or lease expiry falls due.
 */
export async function parkedDeviceWork(
  db: Database,
  now: Date,
): Promise<{ due: boolean; next: Date | null }> {
  const at = sql`${now.toISOString()}::timestamp`;
  const result = await getDb(db).execute<{
    due: boolean | null;
    next: number | null;
  }>(sql`SELECT
      bool_or((state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}) AND "availableAt" <= ${at})
        OR (state = ${jobState.enum.running} AND "leaseExpiresAt" <= ${at})) AS due,
      -- Epoch milliseconds: the driver would read a zoneless timestamp as local time.
      (extract(epoch FROM min(CASE
        WHEN state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}) AND "availableAt" > ${at} THEN "availableAt"
        WHEN state = ${jobState.enum.running} AND "leaseExpiresAt" > ${at} THEN "leaseExpiresAt" END)) * 1000)::float8 AS next
    FROM "Job"
    WHERE kind = 'image.device'
      AND state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running})`);
  const row = result.rows[0];
  return {
    due: row?.due ?? false,
    next: row?.next == null ? null : new Date(row.next),
  };
}
