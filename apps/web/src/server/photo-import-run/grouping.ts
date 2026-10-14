import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/identifiers";
import { storedPhotoRunInput } from "@cubby/schemas/photo-import-run";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import {
  assertPhotoRunReviewer,
  listPhotoRunImages,
} from "~/server/photo-import-run/proposals";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { dispatchRunEvent } from "~/server/purchase-import/dispatch";
import { startPhotoInventoryCoordinator } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";

import { advancePhotoRun } from "./lifecycle";

/**
 * A coordinator started before descriptions settle sees bare photos and stops
 * for review instead of grouping them. Matches the Apple app's
 * `PhotoReviewPolicy.groupingReadiness`: a description waiting for a capable
 * device is not settled either.
 */
const ANALYSIS_IN_FLIGHT = new Set(["pending", "leased", "waiting_for_device"]);

/** The browser and native clients start the same idempotent coordinator. */
export async function startPhotoGroupingForActor(
  db: Database,
  actorContext: ActorContext,
  actorUserId: string,
  runId: string,
) {
  await assertPhotoRunReviewer(db, actorContext, runId);
  const [row] = await getDb(db)
    .select({ input: runTable.input })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(runId)))
    .limit(1);
  const choice = storedPhotoRunInput.parse(row?.input ?? null);
  if (choice?.processor === "external")
    throw new Error(
      "This Run uses a Claude/Codex handoff; Cubby does not group its photos",
    );
  if (choice) {
    // A chosen-processor Run starts only through the guarded lifecycle
    // (sealed batches, every description ready, compare-and-set dispatch).
    // A manual start is the member's retry: it clears a recorded dispatch
    // error so the advance tries again.
    await getDb(db)
      .update(runTable)
      .set({ dispatchError: null, updatedAt: new Date() })
      .where(
        and(
          eq(runTable.shortcode, runShortcode.parse(runId)),
          isNull(runTable.dispatchEventId),
          isNotNull(runTable.dispatchError),
        ),
      );
    const lifecycle = await advancePhotoRun(db, runId);
    if (lifecycle.dispatchError) throw new Error(lifecycle.dispatchError);
    const [after] = await getDb(db)
      .select({ dispatchEventId: runTable.dispatchEventId })
      .from(runTable)
      .where(eq(runTable.shortcode, runShortcode.parse(runId)))
      .limit(1);
    return {
      runId: runShortcode.parse(runId),
      started: Boolean(after?.dispatchEventId),
      // Every required description not yet settled, a missing job included.
      waitingForAnalysis: (await listPhotoRunImages(db, runId)).filter(
        (image) =>
          image.targetState === "pending" &&
          (image.describe === null || ANALYSIS_IN_FLIGHT.has(image.describe)),
      ).length,
    };
  }
  // Legacy Run (no processor choice): the original manual start.
  const grant = await findActivePurchaseAgentGrant(db, actorUserId);
  if (!grant) throw new Error("Connect the Cubby agent before grouping photos");
  const queue = getPurchaseAgentQueue();
  if (!queue) throw new Error("Photo import agent is unavailable");
  const waitingForAnalysis = (await listPhotoRunImages(db, runId)).filter(
    (image) =>
      image.targetState === "pending" &&
      image.describe !== null &&
      ANALYSIS_IN_FLIGHT.has(image.describe),
  ).length;
  if (waitingForAnalysis > 0)
    return { runId, started: false, waitingForAnalysis };
  const run = await startPhotoInventoryCoordinator(db, {
    publicId: runId,
    actorUserId,
  });
  if (run.created)
    await dispatchRunEvent(db, queue, {
      version: 1,
      runId: run.id,
      eventId: run.eventId,
      generation: run.eventId,
      purpose: "photo_inventory",
      type: "start_or_resume",
    });
  return { runId: run.publicId, started: run.created, waitingForAnalysis: 0 };
}
