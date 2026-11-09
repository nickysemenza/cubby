import type { ActorContext } from "@cubby/schemas/context";
import {
  imageId,
  imageShortcode,
  runEntityId,
  userId,
  type DeviceId,
  type LedgerPartyId,
  type RunId,
  type UserId,
} from "@cubby/schemas/identifiers";
import {
  imageProcessingJobKind,
  imageProcessingJobState,
} from "@cubby/schemas/image-processing";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  storedPhotoRunInput,
  type PhotoInventoryRunInput,
  type PhotoRunDefaults,
  type PhotoRunProcessor,
} from "@cubby/schemas/photo-import-run";
import {
  runPurpose,
  runShortcode,
  runTargetState,
  runTrigger,
} from "@cubby/schemas/purchase-import";
import { runTargetEntityKind } from "@cubby/schemas/run-fields";
import { PHOTO_RUN_IMAGE_LIMIT } from "@cubby/shared/client-constants";
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type {
  PhotoImportFinalizeInput,
  PhotoImportFinalizeOutput,
} from "~/contracts/photo-import.contract";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import {
  image,
  ledgerParty,
  photoRunImage,
  run as runTable,
  user,
} from "~/server/db/schema";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import { publishImageProcessingWakeups } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { persistImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-submission";
import { IMAGE_DESCRIPTION_PROCESSOR_REVISION } from "~/server/domains/image-processing/repo/processor-policy";
import {
  recordImportSightings,
  resolveDeviceSightingContext,
} from "~/server/domains/image/repo/image-sighting";
import {
  photoRunImageOrder,
  withPhotoImportTransaction,
} from "~/server/domains/photo-import/repo/photo-import";
import {
  productionPhotoImportCommitPorts,
  verifyStagedImages,
  type PhotoImportCommitPorts,
} from "~/server/domains/photo-import/repo/photo-import-commit";
import { finalizeImportedImages } from "~/server/domains/photo-import/repo/photo-import-finalize";
import {
  assertRunActive,
  loadRunScope,
  loadRunScopeByShortcode,
} from "~/server/domains/purchase-import/repo/run-service";
import { dispatchStartedRun } from "~/server/domains/run/repo/coordinator-dispatch";
import type {
  RunPurposeLifecycle,
  RunTargetRow,
} from "~/server/domains/run/repo/purpose-lifecycle";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

export type StartPhotoInventoryRunInput = {
  /** The household member the photos belong to; defaults to the creator's own party. */
  ledgerPartyId?: LedgerPartyId;
  actorUserId: UserId;
  notes?: string;
  defaults?: PhotoRunDefaults;
  /**
   * The per-Run grouping choice and first upload batch. Omitted only by
   * fixtures of the legacy manual flow, which keeps a null `Run.input`.
   */
  grouping?: {
    processor: PhotoRunProcessor;
    clientBatchId: string;
    imageCount: number;
  };
  /** The initiating install (`X-Cubby-Device`); never an executor. */
  deviceId?: DeviceId | null;
};

/** `Run.clientKey` of a photo Run: its first batch id makes createRun replay-safe. */
const photoRunClientKey = (clientBatchId: string) =>
  `photo-run:${clientBatchId}`;

/**
 * A photo-inventory run has no vendor and no upfront targets: the native app
 * bulk-uploads photos into it via `stage`/`finalize`, an agent works the
 * queue afterward. The owning `ledgerParty`
 * and the creating actor can differ (a member photographing a shared or
 * another member's belongings), so the actor snapshot is always the
 * *creator's* own identity, resolved independently of the chosen owner.
 */
export async function startPhotoInventoryRun(
  db: Database,
  input: StartPhotoInventoryRunInput,
) {
  return withTransaction(db, async (tx) => {
    if (input.grouping) {
      const [existing] = await tx
        .select({
          id: runTable.id,
          shortcode: runTable.shortcode,
          actorUserId: runTable.actorUserId,
        })
        .from(runTable)
        .where(
          eq(
            runTable.clientKey,
            photoRunClientKey(input.grouping.clientBatchId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.actorUserId !== input.actorUserId)
          throw new Error("This upload batch id belongs to another member");
        return {
          id: existing.id,
          publicId: runShortcode.parse(existing.shortcode),
        };
      }
    }
    const [actor] = await tx
      .select({
        actorUserId: ledgerParty.userId,
        actorName: user.name,
        actorEmail: user.email,
        actorLedgerPartyId: ledgerParty.id,
        actorLedgerPartyShortcode: ledgerParty.shortcode,
        actorLedgerPartyName: ledgerParty.name,
        actorLedgerPartyKind: ledgerParty.kind,
      })
      .from(user)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.userId, user.id),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .where(eq(user.id, input.actorUserId))
      .limit(1);
    if (!actor?.actorUserId)
      throw new Error("Photo inventory actor is not available");

    let ownerLedgerPartyId = actor.actorLedgerPartyId;
    if (
      input.ledgerPartyId &&
      input.ledgerPartyId !== actor.actorLedgerPartyId
    ) {
      const [owner] = await tx
        .select({ id: ledgerParty.id })
        .from(ledgerParty)
        .where(
          and(eq(ledgerParty.id, input.ledgerPartyId), notDeleted(ledgerParty)),
        )
        .limit(1);
      if (!owner)
        throw new Error("Photo inventory owner party is not available");
      ownerLedgerPartyId = owner.id;
    }

    const id = runEntityId.parse(crypto.randomUUID());
    const run = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: ownerLedgerPartyId,
      actorUserId: actor.actorUserId,
      actorName: actor.actorName,
      actorEmail: actor.actorEmail,
      actorLedgerPartyShortcode: actor.actorLedgerPartyShortcode,
      actorLedgerPartyName: actor.actorLedgerPartyName,
      actorLedgerPartyKind: actor.actorLedgerPartyKind,
      vendorId: null,
      vendorAccountId: null,
      purpose: runPurpose.enum.photo_inventory,
      coordinatorModel: coordinatorModelFor("photo_inventory"),
      trigger: runTrigger.enum.manual,
      notes: input.notes ?? null,
      agentSessionId: importRunAgentIdentity(id, "photo_inventory"),
      deviceId: input.deviceId ?? null,
      clientKey: input.grouping
        ? photoRunClientKey(input.grouping.clientBatchId)
        : null,
      input: input.grouping
        ? {
            kind: "photo_inventory",
            processor: input.grouping.processor,
            defaults: input.defaults ?? {
              stockIntent: "receive",
              locationId: null,
            },
            batches: [
              {
                clientBatchId: input.grouping.clientBatchId,
                imageCount: input.grouping.imageCount,
                positionOffset: 0,
                state: "open",
              },
            ],
          }
        : null,
    });
    return { id: run.id, publicId: run.shortcode };
  });
}

/** Arm a photo run only after upload has produced pending targets. */
export async function startPhotoInventoryCoordinator(
  db: Database,
  input: { publicId: string; actorUserId: string },
) {
  const publicId = runShortcode.parse(input.publicId);
  const actorUserId = userId.parse(input.actorUserId);
  const started = await armPhotoCoordinator(db, publicId, actorUserId, []);
  if (started) return started;
  const scope = await loadRunScopeByShortcode(db, publicId);
  if (scope.public.purpose !== "photo_inventory")
    throw new Error("Import run is not a photo-inventory run");
  if (scope.actorUserId !== actorUserId)
    throw new Error("Only the run's initiating member can start its agent");
  if (scope.public.status !== "running")
    throw new Error(`Import run is ${scope.public.status}`);
  if (scope.public.dispatchEventId)
    return {
      id: scope.public.runId,
      publicId,
      eventId: scope.public.dispatchEventId,
      created: false as const,
    };
  throw new Error(
    "Upload and finalize photos before asking the agent to group them",
  );
}

/**
 * Arm a chosen-processor photo Run's coordinator only if what was judged
 * ready still holds at the write: `Run.input` is unchanged (no new batch,
 * seal or switch to `external`), no batch is open, and every pending photo
 * has a ready or skipped current description. Null when any of that moved;
 * the change that moved it runs its own advance.
 */
export async function startGuardedPhotoCoordinator(
  db: Database,
  input: {
    publicId: string;
    actorUserId: string;
    expectedInput: PhotoInventoryRunInput;
  },
) {
  return armPhotoCoordinator(
    db,
    runShortcode.parse(input.publicId),
    userId.parse(input.actorUserId),
    [
      sql`${runTable.input} = ${JSON.stringify(input.expectedInput)}::jsonb`,
      sql`NOT (${runTable.input} @> ${JSON.stringify({ batches: [{ state: "open" }] })}::jsonb)`,
      // Literal qualified names: the correlation must name the outer Run.
      sql`NOT EXISTS (
        SELECT 1 FROM "PhotoRunImage" target
        JOIN "Image" source ON source."id" = target."imageId" AND ${notDeleted("source")}
        WHERE target."runId" = "Run"."id"
          AND target."state" = ${runTargetState.enum.pending}
          AND NOT EXISTS (
            SELECT 1 FROM "ImageProcessingJob" job
            WHERE job."imageId" = target."imageId" AND ${notDeleted("job")}
              AND job."kind" = ${imageProcessingJobKind.enum.describe_image}
              AND job."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION}
              AND job."sourceContentHash" = source."sha256"
              AND job."state" IN (${imageProcessingJobState.enum.ready}, ${imageProcessingJobState.enum.skipped})
          )
      )`,
    ],
  );
}

async function armPhotoCoordinator(
  db: Database,
  publicId: ReturnType<typeof runShortcode.parse>,
  actorUserId: UserId,
  guards: readonly SQL[],
) {
  return withTransaction(db, async (tx) => {
    const eventId = crypto.randomUUID();
    const [started] = await tx
      .update(runTable)
      .set({
        dispatchEventId: eventId,
        dispatchError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTable.shortcode, publicId),
          eq(runTable.actorUserId, actorUserId),
          eq(runTable.purpose, "photo_inventory"),
          eq(runTable.status, "running"),
          isNull(runTable.dispatchEventId),
          sql`EXISTS (SELECT 1 FROM ${photoRunImage} WHERE ${photoRunImage.runId} = ${runTable.id} AND ${photoRunImage.state} = ${runTargetState.enum.pending})`,
          ...guards,
        ),
      )
      .returning({ id: runTable.id, publicId: runTable.shortcode });
    if (started)
      await dispatchStartedRun(tx, {
        id: started.id,
        eventId,
        purpose: "photo_inventory",
      });
    return started
      ? {
          id: started.id,
          publicId: runShortcode.parse(started.publicId),
          eventId,
          created: true as const,
        }
      : null;
  });
}

/**
 * Finalize a chunk of bulk-uploaded photos into a photo-inventory run: turn
 * each `stage`d image into a `PhotoRunImage` and activate it, then queue
 * describe/lift processing. Unlike the vendor-scoped run flows this is not
 * owner-fenced (`assertOwnedRun`) — any household member may finalize into a
 * shared photo-inventory run, so `actor` is accepted for parity with sibling
 * mutations but not consulted for authorization.
 */
export async function finalizePhotoRun(
  db: Database,
  input: PhotoImportFinalizeInput,
  actor: ActorContext,
  // Testability seam only: production always uses the default (R2 + real
  // image inspection), the same ports `commitPhotoImport` accepts.
  ports: PhotoImportCommitPorts = productionPhotoImportCommitPorts,
): Promise<PhotoImportFinalizeOutput> {
  const scope = await loadRunScopeByShortcode(db, input.runId);
  if (scope.public.purpose !== "photo_inventory") {
    throw new Error("Import run is not a photo-inventory run");
  }
  if (scope.public.status !== "running") {
    throw new Error(`Import run is fenced in status ${scope.public.status}`);
  }
  // The upload barrier: a chosen-processor Run takes new photos only inside
  // the named, still-open batch. Checked here for a clear early error, and
  // again atomically where the targets are inserted.
  const [runInput] = await getDb(db)
    .select({ input: runTable.input })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .limit(1);
  const photoInput = storedPhotoRunInput.parse(runInput?.input ?? null);
  if (photoInput && !input.clientBatchId)
    throw new Error(
      `Photo run ${input.runId} needs the clientBatchId these photos were admitted under`,
    );
  if (
    photoInput &&
    !photoInput.batches.some(
      (batch) => batch.clientBatchId === input.clientBatchId,
    )
  )
    throw new Error(
      `Upload batch ${input.clientBatchId} was never admitted to ${input.runId}`,
    );

  const detailByShortcode = new Map(
    input.images.map((item) => [
      // SAFETY: widening the branded ImageShortcode to plain string so this
      // map can be looked up by ImportImageRow.shortcode (unbranded) below.
      item.imageId as string,
      { position: item.position, sha256: item.sha256 },
    ]),
  );

  // Same preflight seam `commitPhotoImport` uses: bytes/dimensions are
  // verified outside the transaction so R2 failures never hold locks.
  // `stage` already decided reuse for an exact-hash match, so finalize
  // always allows it.
  const staged = await verifyStagedImages(
    db,
    input.images.map((item) => ({
      imageId: item.imageId,
      sha256: item.sha256,
      width: item.width,
      height: item.height,
    })),
    { reuseAllowed: true },
    ports,
  );

  const { finalizedIds, alreadyFinalizedIds } =
    await withPhotoImportTransaction(db, async (transactionDb) => {
      const imageCodes = staged.map((entry) => entry.row.shortcode);
      const lockedRows = await ports.lockImages(transactionDb, imageCodes);
      const lockedByCode = new Map(
        lockedRows.map((row) => [row.shortcode, row] as const),
      );
      if (lockedByCode.size !== imageCodes.length) {
        throw new Error(
          "One or more staged images disappeared before finalize",
        );
      }
      const lockedStaged = staged.map((entry) => {
        const locked = lockedByCode.get(entry.row.shortcode);
        if (!locked || locked.status !== entry.row.status) {
          throw new Error(
            `Staged image ${entry.row.shortcode} changed while it was ` +
              "being finalized",
          );
        }
        return { ...entry, row: locked };
      });

      // Review and the grouping agent read a whole Run at once and stop at
      // the limit, so a photo past it would upload but never be imported.
      // The lock serializes concurrent chunks of the same Run for the count.
      await getDb(transactionDb).execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scope.public.runId}))`,
      );
      const targeted = new Set(
        (
          await getDb(transactionDb)
            .select({ imageId: photoRunImage.imageId })
            .from(photoRunImage)
            .where(eq(photoRunImage.runId, scope.public.runId))
        ).map((row) => row.imageId),
      );
      const adding = lockedStaged.filter(
        (entry) => !targeted.has(imageId.parse(entry.row.id)),
      ).length;
      // A replay of already-targeted photos is harmless after the seal; new
      // photos need their batch still open at this instant. The guarded
      // write holds the Run row until commit, so a seal or dispatch that
      // races it waits and then sees these targets.
      if (photoInput && adding > 0) {
        const [open] = await getDb(transactionDb)
          .update(runTable)
          .set({ updatedAt: new Date() })
          .where(
            and(
              eq(runTable.id, scope.public.runId),
              sql`${runTable.input} @> ${JSON.stringify({
                batches: [
                  { clientBatchId: input.clientBatchId, state: "open" },
                ],
              })}::jsonb`,
            ),
          )
          .returning({ id: runTable.id });
        if (!open)
          throw new Error(
            `Upload batch ${input.clientBatchId} is sealed; admit a new batch for more photos`,
          );
      }
      if (targeted.size + adding > PHOTO_RUN_IMAGE_LIMIT) {
        throw new Error(
          `Photo run ${input.runId} holds at most ${PHOTO_RUN_IMAGE_LIMIT} photos: ` +
            `it has ${targeted.size} and this upload adds ${adding}. ` +
            "Start a new run for the rest.",
        );
      }

      const inserted = await getDb(transactionDb)
        .insert(photoRunImage)
        .values(
          lockedStaged.map((entry) => {
            const detail = detailByShortcode.get(entry.row.shortcode);
            return {
              runId: scope.public.runId,
              imageId: imageId.parse(entry.row.id),
              position: detail?.position ?? 0,
              state: "pending" as const,
              targetFingerprint: detail?.sha256 ?? entry.integrity.sha256,
            };
          }),
        )
        // Conflicts land on the `(runId, entityId)` unique index — a
        // retried chunk re-selecting an already-targeted image is a no-op,
        // not a failure. The bare form matches every constraint on the
        // table, same as `persistLocalImageAnalysis`'s idempotent upsert.
        .onConflictDoNothing()
        .returning({ entityId: photoRunImage.imageId });
      const insertedIds = new Set(inserted.map((row) => row.entityId));

      await finalizeImportedImages(transactionDb, {
        pending: lockedStaged.map(({ row, integrity }) => ({
          row,
          integrity,
        })),
        analyses: [],
      });

      const allIds = lockedStaged.map((entry) => entry.row.id);
      await getDb(transactionDb)
        .update(image)
        .set({ source: "own", sourceEvidence: null })
        .where(and(inArray(image.id, allIds), eq(image.source, "unknown")));

      const library = input.images.flatMap((item) => {
        const locked = lockedByCode.get(item.imageId);
        return item.library && locked
          ? [{ imageId: imageId.parse(locked.id), sighting: item.library }]
          : [];
      });
      const sightingContext = library.length
        ? await resolveDeviceSightingContext(
            transactionDb,
            actor.deviceId,
            actor.userId,
          )
        : null;
      if (sightingContext)
        await recordImportSightings(
          transactionDb,
          sightingContext,
          library,
          actor,
        );

      return {
        finalizedIds: lockedStaged
          .filter((entry) => insertedIds.has(imageId.parse(entry.row.id)))
          .map((entry) => entry.row.shortcode),
        alreadyFinalizedIds: lockedStaged
          .filter((entry) => !insertedIds.has(imageId.parse(entry.row.id)))
          .map((entry) => entry.row.shortcode),
      };
    });

  // Replayed photos too: job identity makes this a no-op for scheduled work
  // and repairs a finalize whose scheduling never ran.
  const submission = await schedulePhotoRunImageProcessing(
    db,
    scope.public.runId,
    [...finalizedIds, ...alreadyFinalizedIds],
  );
  const { advancePhotoRunQuietly } = await import("./lifecycle");
  await advancePhotoRunQuietly(db, scope.public.runId);

  return {
    finalized: finalizedIds.map((code) => imageShortcode.parse(code)),
    alreadyFinalized: alreadyFinalizedIds.map((code) =>
      imageShortcode.parse(code),
    ),
    submissionId: submission.publicId,
  };
}

/**
 * Schedule a photo Run's per-image work (description, subject lift,
 * identification). Idempotent per job identity; the lifecycle's repair and
 * finalize share it.
 */
export async function schedulePhotoRunImageProcessing(
  db: Database,
  runId: RunId,
  imageCodes: readonly string[],
) {
  const submission = await createImageProcessingSubmission(db);
  const jobIds: string[] = [];
  for (const shortcode of imageCodes) {
    const scheduled = await persistImageProcessingSubmission(db, {
      id: shortcode,
      kinds: ["describe_image", "subject_lift", "identify_image"],
      submission: { id: submission.id, publicId: submission.publicId },
      runId,
    });
    jobIds.push(...scheduled.jobIds);
  }
  await publishImageProcessingWakeups(db, jobIds);
  return submission;
}

/** Photo coordination reads only its explicit pending image targets. */
export async function claimPhotoInventoryWork(db: Database, runId: RunId) {
  const scope = await loadRunScope(db, runId);
  if (scope.public.purpose !== "photo_inventory")
    throw new Error("Photo work selection requires a photo inventory run");
  if (scope.public.status === "paused_auth")
    return { kind: "paused_auth" as const };
  if (scope.public.status === "paused_offline")
    return { kind: "paused_offline" as const };
  assertRunActive(scope.public.status);
  const [run] = await getDb(db)
    .select({ notes: runTable.notes })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .limit(1);
  const [pending] = await getDb(db)
    .select({ count: count() })
    .from(photoRunImage)
    .where(
      and(
        eq(photoRunImage.runId, scope.public.runId),
        eq(photoRunImage.state, "pending"),
      ),
    );
  return pending?.count
    ? {
        kind: "photo_inventory" as const,
        runId: scope.public.shortcode,
        pendingImages: pending.count,
        notes: run?.notes ?? null,
      }
    : { kind: "none" as const };
}

/** Every photo of the Run in review order; its state decides what a retry carries. */
function photoRunTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
): Promise<RunTargetRow[]> {
  return client
    .select({
      id: photoRunImage.id,
      entityKind: sql<"image">`${runTargetEntityKind.enum.image}`,
      entityId: photoRunImage.imageId,
      entityCode: image.shortcode,
      workKey: photoRunImage.workKey,
      position: photoRunImage.position,
      vendorAccountId: sql<null>`NULL`,
      vendorAccountCode: sql<null>`NULL`,
      vendorAccountLabel: sql<null>`NULL`,
      sourceKind: sql<null>`NULL`,
      sourceExternalKey: sql<null>`NULL`,
      targetFingerprint: photoRunImage.targetFingerprint,
      state: photoRunImage.state,
      outcome: photoRunImage.outcome,
      warning: photoRunImage.skipReason,
      diff: photoRunImage.commitReceipt,
      completedAt: photoRunImage.completedAt,
    })
    .from(photoRunImage)
    .innerJoin(image, eq(image.id, photoRunImage.imageId))
    .where(eq(photoRunImage.runId, runId))
    .orderBy(...photoRunImageOrder());
}

/** A successor reprocesses the carried photos from `pending`. */
export const photoRunLifecycle: RunPurposeLifecycle = {
  targets: photoRunTargets,
  handOff: async (tx, { to, carried }) => {
    if (!carried.length) return;
    await tx.insert(photoRunImage).values(
      carried.map((target) => ({
        runId: to,
        imageId: imageId.parse(target.entityId),
        workKey: target.workKey,
        position: target.position,
        targetFingerprint: target.targetFingerprint,
        state: "pending" as const,
      })),
    );
  },
};
