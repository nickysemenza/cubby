import type { ActorContext } from "@cubby/schemas/context";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { assertPhotoRunReviewer } from "~/server/photo-import-run/proposals";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { dispatchImportRunEvent } from "~/server/purchase-import/dispatch";
import { startPhotoInventoryCoordinator } from "~/server/purchase-import/run-service";

/** The browser and native clients start the same idempotent coordinator. */
export async function startPhotoGroupingForActor(
  db: Database,
  actorContext: ActorContext,
  actorUserId: string,
  runId: string,
) {
  await assertPhotoRunReviewer(db, actorContext, runId);
  const grant = await findActivePurchaseAgentGrant(db, actorUserId);
  if (!grant) throw new Error("Connect the Cubby agent before grouping photos");
  const queue = getPurchaseAgentQueue();
  if (!queue) throw new Error("Photo import agent is unavailable");
  const run = await startPhotoInventoryCoordinator(db, {
    publicId: runId,
    actorUserId,
  });
  if (run.created)
    await dispatchImportRunEvent(db, queue, {
      version: 1,
      runId: run.id,
      eventId: run.eventId,
      purpose: "photo_inventory",
      type: "start_or_resume",
    });
  return { runId: run.publicId, started: run.created };
}
