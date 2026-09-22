import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { importRun } from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Producer-side dispatch accounting. Its own module because both the run
 * service and the paths that admit runs (hunts, receipts, manual sync) need
 * it, and those paths are themselves imported by the run service.
 */

/** Mark the producer hand-off. A delivery can be retried only with this id. */
export async function recordImportRunDispatchAttempt(
  db: Database,
  input: { runId: string; eventId: string; error?: string },
) {
  const runId = z.uuid().parse(input.runId);
  const [run] = await getDb(db)
    .update(importRun)
    .set({
      dispatchAttempts: sql`${importRun.dispatchAttempts} + 1`,
      dispatchError: input.error?.slice(0, 2_000) ?? null,
      status: input.error ? "dispatch_failed" : "running",
      failureCode: input.error ? "dispatch_failed" : null,
      endedAt: input.error ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importRun.id, runId),
        eq(importRun.dispatchEventId, input.eventId),
        inArray(importRun.status, ["running", "dispatch_failed"]),
      ),
    )
    .returning({ id: importRun.id, status: importRun.status });
  if (run) return run;
  const [settled] = await getDb(db)
    .select({ id: importRun.id, status: importRun.status })
    .from(importRun)
    .where(
      and(
        eq(importRun.id, runId),
        eq(importRun.dispatchEventId, input.eventId),
      ),
    )
    .limit(1);
  if (settled) return settled;
  throw new Error("Import run dispatch generation is no longer active");
}

/**
 * The one producer hand-off. Every path that starts a coordinator sends
 * through here so `dispatchAttempts` counts the initial delivery, not only
 * the retry route. A `retry` event resumes the active generation and is not a
 * new attempt: `recordImportRunDispatchAttempt` would reject its event id.
 */
export async function dispatchImportRunEvent(
  db: Database,
  queue: PurchaseAgentQueueProducer,
  event: PurchaseAgentEvent,
) {
  if (event.type !== "start_or_resume") {
    await queue.send(event);
    return;
  }
  try {
    await queue.send(event);
  } catch (error) {
    await recordImportRunDispatchAttempt(db, {
      runId: event.runId,
      eventId: event.eventId,
      error: error instanceof Error ? error.message : "Queue send failed",
    });
    throw error;
  }
  await recordImportRunDispatchAttempt(db, {
    runId: event.runId,
    eventId: event.eventId,
  });
}
