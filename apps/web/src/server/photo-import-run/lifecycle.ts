import type { ImageShortcode } from "@cubby/schemas/identifiers";
import { imageId, runEntityId, runShortcode } from "@cubby/schemas/identifiers";
import {
  storedPhotoRunInput,
  photoRunProcessor,
  runPushKind,
  type PhotoGroupProposalList,
  type PhotoInventoryRunInput,
  type PhotoRunImage,
  type PhotoRunLifecycle,
  type PhotoRunLifecyclePhase,
  type PhotoRunProcessor,
} from "@cubby/schemas/photo-import-run";
import { runStatus } from "@cubby/schemas/purchase-import";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  image,
  photoGroupProposal,
  photoRunImage,
  run as runTable,
  runPushRegistration,
} from "~/server/db/schema";
import {
  listPhotoGroupProposals,
  listPhotoRunImages,
} from "~/server/photo-import-run/proposals";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { dispatchRunEvent } from "~/server/purchase-import/dispatch";
import {
  schedulePhotoRunImageProcessing,
  startGuardedPhotoCoordinator,
} from "~/server/purchase-import/run-service";
import { getDb, withTransaction } from "~/server/repo/database-helpers";

/**
 * A description waiting for a capable device is not settled either; matches
 * the Apple app's `PhotoReviewPolicy.groupingReadiness`.
 */
export const DESCRIPTION_IN_FLIGHT = new Set([
  "pending",
  "leased",
  "waiting_for_device",
]);

type RunStatus = z.infer<typeof runStatus>;

const log = createLogger("photo-run-lifecycle");

/** Targets a stop for review left unfinished (`stopRunForReview`). */
const STOPPED_TARGET_STATES = new Set(["unresolved", "needs_evidence"]);

/** Shown on every photo a member chose to continue without. */
export const EXCLUDED_FAILED_DESCRIPTION_REASON =
  "Description failed; continued without this photo (the photo is kept)";

type LifecycleRun = {
  status: RunStatus;
  input: PhotoInventoryRunInput | null;
  dispatchEventId: string | null;
  dispatchError: string | null;
  /** The coordinator's live progress; settlement marks review handoff here. */
  liveProgress: { generation: string; awaitingApproval?: boolean } | null;
};

/**
 * Derive where a photo Run stands from durable rows. Pure, so every reader
 * (review, Live Activity push, the automatic advance) agrees.
 */
export function derivePhotoRunLifecycle(
  run: LifecycleRun,
  images: readonly Pick<PhotoRunImage, "id" | "targetState" | "describe">[],
  proposals: Pick<PhotoGroupProposalList, "proposals">["proposals"],
): PhotoRunLifecycle {
  const pending = images.filter((image) => image.targetState === "pending");
  // A chosen-processor Run requires a description for every pending photo:
  // a missing job (finalize committed but scheduling did not) blocks like
  // one in flight until the advance repairs it. Legacy Runs keep manual
  // semantics, where a missing job never blocked.
  const inFlight = pending.filter((image) =>
    image.describe === null
      ? run.input !== null
      : DESCRIPTION_IN_FLIGHT.has(image.describe),
  );
  const failedImageIds = pending
    .filter((image) => image.describe === "failed")
    .map((image) => image.id);
  const openBatchCount =
    run.input?.batches.filter((batch) => batch.state === "open").length ?? 0;
  const proposedGroupCount = proposals.filter(
    (group) => group.state === "proposed",
  ).length;
  const processor = run.input?.processor ?? null;
  // A settled coordinator with proposals keeps its Run `running` and marks
  // the handoff on its own generation's live progress; that is review, not
  // grouping.
  const handedOff =
    run.dispatchEventId !== null &&
    run.liveProgress?.generation === run.dispatchEventId &&
    run.liveProgress.awaitingApproval === true;
  const dispatched =
    run.status === "running" && run.dispatchEventId !== null && !handedOff;
  let phase: PhotoRunLifecyclePhase;
  if (openBatchCount > 0) phase = "waiting_for_upload";
  else if (inFlight.length > 0) phase = "describing";
  else if (failedImageIds.length > 0) phase = "needs_attention";
  else if (processor !== "external" && dispatched) phase = "grouping";
  else if (proposedGroupCount > 0) phase = "ready_for_review";
  // Nothing pending and nothing proposed: finished only when every photo
  // was resolved. A Run stopped for review leaves `unresolved` targets, and a
  // failed Run never succeeded — both need the member, not a success state.
  else if (pending.length === 0)
    phase =
      images.some((image) => STOPPED_TARGET_STATES.has(image.targetState)) ||
      run.status === "failed" ||
      run.status === "dispatch_failed"
        ? "needs_attention"
        : "completed";
  else if (processor === "cubby")
    // Not yet dispatched: a dispatch failure needs the member; otherwise the
    // automatic advance is about to start the coordinator.
    phase = run.dispatchError ? "needs_attention" : "grouping";
  else phase = "ready_for_handoff";
  return {
    processor,
    phase,
    plannedImageCount: run.input
      ? run.input.batches.reduce((sum, batch) => sum + batch.imageCount, 0)
      : null,
    openBatchCount,
    finalizedImageCount: images.length,
    describedImageCount:
      pending.length - inFlight.length - failedImageIds.length,
    failedImageIds,
    skippedImageCount: images.filter((image) => image.targetState === "skipped")
      .length,
    proposedGroupCount,
    committedGroupCount: proposals.filter(
      (group) => group.state === "committed",
    ).length,
    dispatchError: run.dispatchError,
  };
}

const runSelection = {
  id: runTable.id,
  shortcode: runTable.shortcode,
  purpose: runTable.purpose,
  status: runTable.status,
  input: runTable.input,
  actorUserId: runTable.actorUserId,
  dispatchEventId: runTable.dispatchEventId,
  dispatchError: runTable.dispatchError,
  liveProgress: runTable.liveProgress,
  retiredAt: runTable.retiredAt,
};

async function loadPhotoRun(db: Database, publicId: string) {
  const [row] = await getDb(db)
    .select(runSelection)
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(publicId)))
    .limit(1);
  if (!row || row.purpose !== "photo_inventory")
    throw new Error(`Photo-inventory run ${publicId} was not found`);
  return {
    ...row,
    status: runStatus.parse(row.status),
    input: storedPhotoRunInput.parse(row.input ?? null),
  };
}

/** One read of everything the lifecycle derives from. */
async function readPhotoRunSnapshot(db: Database, publicId: string) {
  const [run, images, review] = await Promise.all([
    loadPhotoRun(db, publicId),
    listPhotoRunImages(db, publicId),
    listPhotoGroupProposals(db, publicId),
  ]);
  return {
    run,
    images,
    lifecycle: derivePhotoRunLifecycle(run, images, review.proposals),
  };
}

export async function readPhotoRunLifecycle(db: Database, publicId: string) {
  return (await readPhotoRunSnapshot(db, publicId)).lifecycle;
}

/**
 * Advance a photo Run after anything that can change its readiness
 * (finalize, a batch seal, a description settling, an exclusion, a
 * settlement, the maintenance sweep). A `cubby` Run whose batches are sealed
 * and whose descriptions are all ready dispatches its coordinator with no
 * client attached — by compare-and-set against the same input it judged
 * ready, so a concurrent admission or switch to `external` wins. An
 * `external` or legacy Run never dispatches here. Missing description jobs
 * are scheduled. Always pushes the Run's Live Activities. Idempotent.
 */
export async function advancePhotoRun(db: Database, publicId: string) {
  let snapshot = await readPhotoRunSnapshot(db, publicId);
  const { run } = snapshot;
  const unscheduled = run.input
    ? snapshot.images.filter(
        (image) => image.targetState === "pending" && image.describe === null,
      )
    : [];
  if (unscheduled.length) {
    // Missing jobs keep the Run blocked; a failed repair is retried by the
    // next advance or sweep rather than letting grouping start.
    await schedulePhotoRunImageProcessing(
      db,
      run.id,
      unscheduled.map((image) => image.id),
    ).catch((error: unknown) =>
      log.error("photo run description repair failed", {
        runId: publicId,
        error,
      }),
    );
    snapshot = await readPhotoRunSnapshot(db, publicId);
  } else if (
    run.input?.processor === "cubby" &&
    run.status === "running" &&
    run.dispatchEventId === null &&
    !run.dispatchError &&
    snapshot.lifecycle.phase === "grouping"
  ) {
    const error = await dispatchPhotoCoordinator(db, run, run.input);
    if (error) {
      // Recorded without a generation: the member sees it verbatim; switching
      // the processor (or an admission) clears it for the next advance.
      await getDb(db)
        .update(runTable)
        .set({ dispatchError: error.slice(0, 2_000), updatedAt: new Date() })
        .where(and(eq(runTable.id, run.id), isNull(runTable.dispatchEventId)));
    }
    snapshot = await readPhotoRunSnapshot(db, publicId);
  }
  const { pushPhotoRunRegistrations } = await import("./run-push");
  await pushPhotoRunRegistrations(db, run.id, publicId, snapshot.lifecycle);
  return snapshot.lifecycle;
}

/** Best-effort advance for hooks whose own work already committed. */
export async function advancePhotoRunQuietly(
  db: Database,
  runId: string | null | undefined,
) {
  if (!runId) return;
  try {
    const [row] = await getDb(db)
      .select({ shortcode: runTable.shortcode, purpose: runTable.purpose })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(runId)))
      .limit(1);
    if (row?.purpose === "photo_inventory")
      await advancePhotoRun(db, row.shortcode);
  } catch (error) {
    // The maintenance sweep retries; the triggering write must not fail.
    log.error("photo run advance failed", { runId, error });
  }
}

async function dispatchPhotoCoordinator(
  db: Database,
  run: Awaited<ReturnType<typeof loadPhotoRun>>,
  judgedInput: PhotoInventoryRunInput,
): Promise<string | null> {
  if (!(await findActivePurchaseAgentGrant(db, run.actorUserId)))
    return "Connect the Cubby agent so this Run can group its photos";
  const queue = getPurchaseAgentQueue();
  if (!queue) return "Photo import agent queue is unavailable";
  try {
    const started = await startGuardedPhotoCoordinator(db, {
      publicId: run.shortcode,
      actorUserId: run.actorUserId,
      expectedInput: judgedInput,
    });
    // The input changed after it was judged ready; that change ran (or
    // will run) its own advance.
    if (!started) return null;
    if (started.created)
      await dispatchRunEvent(db, queue, {
        version: 1,
        runId: started.id,
        eventId: started.eventId,
        generation: started.eventId,
        purpose: "photo_inventory",
        type: "start_or_resume",
      });
    return null;
  } catch (error) {
    // `dispatchRunEvent` already recorded a queue failure on its generation.
    return error instanceof Error ? error.message : String(error);
  }
}

type PhotoRunTransaction = Parameters<Parameters<typeof withTransaction>[1]>[0];

/**
 * Change a photo Run's input by compare-and-set on the input it read: a
 * concurrent change makes the update miss and the change is recomputed from
 * fresh state (no row lock is held while deciding). `after` runs in the same
 * transaction only when the swap won.
 */
async function updatePhotoRunInput<T>(
  db: Database,
  publicId: string,
  change: (
    run: Awaited<ReturnType<typeof loadPhotoRun>> & {
      input: PhotoInventoryRunInput;
    },
  ) => {
    input: PhotoInventoryRunInput;
    result: T;
    set?: object;
    after?: (tx: PhotoRunTransaction) => Promise<void>;
  },
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const run = await loadPhotoRun(db, publicId);
    if (!run.input)
      throw new Error(
        `Photo run ${publicId} predates per-Run grouping choice; start a new run`,
      );
    const read = run.input;
    const changed = change({ ...run, input: read });
    if (changed.input === read && !changed.set && !changed.after)
      return changed.result;
    const swapped = await withTransaction(db, async (tx) => {
      const [won] = await tx
        .update(runTable)
        .set({ input: changed.input, updatedAt: new Date(), ...changed.set })
        .where(
          // The decision read status and retirement too: a status change or
          // a coordinator retirement between read and write makes it retry.
          and(
            eq(runTable.id, run.id),
            sql`${runTable.input} = ${JSON.stringify(read)}::jsonb`,
            eq(runTable.status, run.status),
            // Retirement is permanent once set, so only its absence can change.
            run.retiredAt ? undefined : isNull(runTable.retiredAt),
          ),
        )
        .returning({ id: runTable.id });
      if (!won) return false;
      await changed.after?.(tx);
      return true;
    });
    if (swapped) return changed.result;
  }
  throw new Error(`Photo run ${publicId} kept changing; retry the request`);
}

/**
 * A photo Run takes another batch while open, stopped for review, or fully
 * approved (its committed and discarded groups stay frozen). Failed,
 * dispatch-failed, paused and cancelled Runs never reopen this way.
 */
const OPEN_FOR_UPLOAD: ReadonlySet<RunStatus> = new Set([
  "running",
  "needs_review",
  "completed",
]);

/**
 * Admit an upload batch. Replaying a `clientBatchId` returns its stored
 * offset and changes nothing. A new batch on a `cubby` Run starts a new
 * grouping generation: the dispatch generation is cleared (fencing the old
 * coordinator's proposal writes) and still-`proposed` groups are dropped so
 * every unapproved photo is regrouped. Committed and discarded groups and
 * their photos are untouched.
 */
export async function admitPhotoRunBatch(
  db: Database,
  input: { runId: string; clientBatchId: string; imageCount: number },
) {
  const admitted = await updatePhotoRunInput(db, input.runId, (run) => {
    const existing = run.input.batches.find(
      (batch) => batch.clientBatchId === input.clientBatchId,
    );
    if (existing)
      return {
        input: run.input,
        result: { positionOffset: existing.positionOffset },
      };
    if (!OPEN_FOR_UPLOAD.has(run.status))
      throw new Error(
        `Photo run ${input.runId} is ${run.status} and cannot take more photos`,
      );
    // Retirement is permanent: a retired coordinator never runs again, so a
    // Cubby Run cannot regroup. An external Run needs no coordinator.
    if (run.input.processor === "cubby" && run.retiredAt)
      throw new Error(
        `Photo run ${input.runId} has finished and its grouping agent was retired; start a new photo import for these photos`,
      );
    const positionOffset = run.input.batches.reduce(
      (sum, batch) => sum + batch.imageCount,
      0,
    );
    const next: PhotoInventoryRunInput = {
      ...run.input,
      batches: [
        ...run.input.batches,
        {
          clientBatchId: input.clientBatchId,
          imageCount: input.imageCount,
          positionOffset,
          state: "open",
        },
      ],
    };
    // Reopen a Run stopped for review: its unapproved photos were marked
    // `unresolved` by the stop; they become pending again so they are
    // regrouped. Committed, discarded and reasoned-skip targets are frozen.
    const reopen = {
      status: "running",
      failureCode: null,
      endedAt: null,
    };
    const restoreUnresolved = async (tx: PhotoRunTransaction) => {
      await tx
        .update(photoRunImage)
        .set({ state: "pending", updatedAt: new Date() })
        .where(
          and(
            eq(photoRunImage.runId, run.id),
            eq(photoRunImage.state, "unresolved"),
          ),
        );
    };
    if (run.input.processor !== "cubby")
      return {
        input: next,
        result: { positionOffset },
        set: reopen,
        after: restoreUnresolved,
      };
    return {
      input: next,
      result: { positionOffset },
      // A new generation: `proposePhotoGroups` refuses any coordinator whose
      // signed generation no longer matches, and the next dispatch mints one.
      set: {
        ...reopen,
        dispatchEventId: null,
        coordinatorStartedAt: null,
        dispatchError: null,
      },
      after: async (tx) => {
        await restoreUnresolved(tx);
        await tx
          .delete(photoGroupProposal)
          .where(
            and(
              eq(photoGroupProposal.runId, run.id),
              eq(photoGroupProposal.state, "proposed"),
            ),
          );
      },
    };
  });
  const lifecycle = await advancePhotoRun(db, input.runId);
  return {
    runId: runShortcode.parse(input.runId),
    clientBatchId: input.clientBatchId,
    positionOffset: admitted.positionOffset,
    lifecycle,
  };
}

/**
 * Close one batch (or, without `clientBatchId`, every open batch) after its
 * last finalize chunk or when its remaining photos were given up. Idempotent.
 */
export async function sealPhotoRunBatch(
  db: Database,
  input: { runId: string; clientBatchId?: string | undefined },
) {
  await updatePhotoRunInput(db, input.runId, (run) => {
    if (
      input.clientBatchId &&
      !run.input.batches.some(
        (batch) => batch.clientBatchId === input.clientBatchId,
      )
    )
      throw new Error(
        `Upload batch ${input.clientBatchId} was never admitted to ${input.runId}`,
      );
    return {
      input: {
        ...run.input,
        batches: run.input.batches.map((batch) =>
          !input.clientBatchId || batch.clientBatchId === input.clientBatchId
            ? { ...batch, state: "sealed" as const }
            : batch,
        ),
      },
      result: null,
    };
  });
  return {
    runId: runShortcode.parse(input.runId),
    lifecycle: await advancePhotoRun(db, input.runId),
  };
}

/**
 * Switch who groups the Run. Switching to `external` stops future automatic
 * dispatch; a coordinator already running is not interrupted. Switching to
 * `cubby` clears a recorded dispatch error so the advance retries.
 */
export async function setPhotoRunProcessor(
  db: Database,
  input: { runId: string; processor: PhotoRunProcessor },
) {
  await updatePhotoRunInput(db, input.runId, (run) => ({
    input: { ...run.input, processor: input.processor },
    result: null,
    set: run.dispatchEventId === null ? { dispatchError: null } : {},
  }));
  return advancePhotoRun(db, input.runId);
}

/**
 * Continue without photos whose description failed: each becomes a
 * `skipped` run target with {@link EXCLUDED_FAILED_DESCRIPTION_REASON}. The
 * Image and its bytes are kept, nothing is deleted, and a photo a live
 * proposed group still holds is refused rather than silently pulled out.
 */
export async function excludeFailedPhotoRunImages(
  db: Database,
  input: { runId: string; imageIds: readonly ImageShortcode[] },
) {
  const images = await listPhotoRunImages(db, input.runId);
  const byId = new Map(images.map((image) => [image.id, image]));
  for (const id of input.imageIds) {
    const image = byId.get(id);
    if (!image) throw new Error(`Photo ${id} is not in run ${input.runId}`);
    if (image.targetState !== "pending" || image.describe !== "failed")
      throw new Error(
        `Photo ${id} has no failed description to continue without`,
      );
  }
  const review = await listPhotoGroupProposals(db, input.runId);
  const held = new Set<string>(input.imageIds);
  for (const group of review.proposals) {
    if (group.state !== "proposed") continue;
    const member = [...group.images, ...group.skip].find((entry) =>
      held.has(entry.id),
    );
    if (member)
      throw new Error(
        `Photo ${member.id} is in proposed group ${group.groupKey}; remove it from the group first`,
      );
  }
  const run = await loadPhotoRun(db, input.runId);
  const targets = await getDb(db)
    .select({ id: image.id })
    .from(image)
    .where(inArray(image.shortcode, [...input.imageIds]));
  await getDb(db)
    .update(photoRunImage)
    .set({
      state: "skipped",
      skipReason: EXCLUDED_FAILED_DESCRIPTION_REASON,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(photoRunImage.runId, run.id),
        eq(photoRunImage.state, "pending"),
        inArray(
          photoRunImage.imageId,
          targets.map((target) => imageId.parse(target.id)),
        ),
      ),
    );
  return advancePhotoRun(db, input.runId);
}

/**
 * Maintenance backstop for hooks that missed: a running `cubby` photo Run
 * not yet dispatched, a photo Run with an open Live Activity under 12 hours
 * old (whatever its status, so a final end is retried), and an open photo
 * Run with an active alert registration, get one advance per sweep.
 */
export async function advanceWaitingPhotoRuns(db: Database, limit = 50) {
  const rows = await getDb(db)
    .select({ shortcode: runTable.shortcode })
    .from(runTable)
    .where(
      and(
        eq(runTable.purpose, "photo_inventory"),
        or(
          and(
            eq(runTable.status, "running"),
            isNull(runTable.dispatchEventId),
            isNull(runTable.dispatchError),
            sql`${runTable.input}->>'processor' = ${photoRunProcessor.enum.cubby}`,
          ),
          // A Live Activity's final update (including its end on a
          // completed Run) is retried within ActivityKit's own lifetime.
          sql`EXISTS (SELECT 1 FROM ${runPushRegistration} WHERE ${runPushRegistration.runId} = ${runTable.id} AND ${runPushRegistration.kind} = ${runPushKind.enum.live_activity} AND ${runPushRegistration.endedAt} IS NULL AND ${runPushRegistration.createdAt} > now() - interval '12 hours')`,
          // Alerts only while the Run can still enter an alerting phase.
          and(
            inArray(runTable.status, ["running", "needs_review"]),
            sql`EXISTS (SELECT 1 FROM ${runPushRegistration} WHERE ${runPushRegistration.runId} = ${runTable.id} AND ${runPushRegistration.kind} = ${runPushKind.enum.alert} AND ${runPushRegistration.endedAt} IS NULL)`,
          ),
        ),
      ),
    )
    .limit(limit);
  for (const row of rows)
    await advancePhotoRun(db, row.shortcode).catch((error: unknown) =>
      log.error("photo run advance failed", { runId: row.shortcode, error }),
    );
  return rows.length;
}
