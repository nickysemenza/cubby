import { createLogger } from "@cubby/worker-tracing";
import { and, eq, sql } from "drizzle-orm";

import { getExecutionCtx, getImageProcessingNamespace } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { wakeAt } from "~/server/workflows/background-tasks/publish";

import type { ImageProcessingCompanionRpc } from "../operations/rpc";

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
async function ringImageProcessingCompanionsOrThrow(): Promise<number> {
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
    // the hourly cron rings for anything still due.
    log.warn("companion ring failed", { error });
    return 0;
  }
}

const ringing = new WeakSet<object>();

/**
 * Ring companions once after the enqueuing transaction commits. Device work
 * is parked for device pulls; the server never polls it.
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
 * Ring when parked device work comes due while every device idles: its backoff
 * ends or its lease lapses. A Queue-delayed wake carries the ring; work due past
 * that delay and any lost message wait for the hourly cron instead.
 */
export async function ringDeviceWorkAt(
  db: Database | DrizzleTransaction,
  at: Date,
) {
  await runAfterCommit(db, () =>
    wakeAt(at, { source: "image-device-ring", ring: true }),
  );
}

/**
 * Whether parked device work is claimable now (due, or a lapsed lease), and
 * when the earliest later work or lease expiry falls due.
 */
export async function parkedDeviceWork(
  db: Database,
  now: Date,
): Promise<{ due: boolean; next: Date | null }> {
  const instant = sql`${now.toISOString()}::timestamp`;
  const until = sql`coalesce(${imageProcessingJob.leaseUntil}, ${imageProcessingJob.runAt})`;
  const [row] = await getDb(db)
    .select({
      due: sql<boolean | null>`bool_or(${until} <= ${instant})`,
      // Epoch milliseconds: the driver would read a zoneless timestamp as local time.
      next: sql<
        number | null
      >`(extract(epoch FROM min(${until}) FILTER (WHERE ${until} > ${instant})) * 1000)::float8`,
    })
    .from(imageProcessingJob)
    .where(
      and(
        eq(imageProcessingJob.state, "pending"),
        eq(imageProcessingJob.lane, "device"),
      ),
    );
  return {
    due: row?.due ?? false,
    next: row?.next == null ? null : new Date(row.next),
  };
}

/** Ring only when parked work is claimable. A doorbell failure throws, so delivery retries. */
export async function ringDueDeviceWork(db: Database): Promise<void> {
  const { due } = await parkedDeviceWork(db, new Date());
  if (due) await ringImageProcessingCompanionsOrThrow();
}
