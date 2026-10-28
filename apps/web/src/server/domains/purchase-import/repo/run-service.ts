import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  imageId,
  imageShortcode,
  userId,
  parseEntityRef,
  runEntityId,
  vendorAccountId,
  type DeviceId,
  type LedgerPartyId,
  type RunId,
  type UserId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  imageProcessingJobKind,
  imageProcessingJobState,
} from "@cubby/schemas/image-processing";
import {
  agentImportRunPurpose,
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { paidOverBudgetUsd } from "@cubby/schemas/mail-import-settings";
import {
  storedPhotoRunInput,
  type PhotoInventoryRunInput,
  type PhotoRunProcessor,
  type PhotoRunDefaults,
} from "@cubby/schemas/photo-import-run";
import {
  type AgentProgressEvent,
  agentProgressEvent,
} from "@cubby/schemas/purchase-agent-services";
import {
  extractedPurchaseLine,
  preparePurchaseImportOut,
  commitPurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import {
  runShortcode,
  runPurpose,
  runTrigger,
  runScope,
  runTargetState,
} from "@cubby/schemas/purchase-import";
import { purchaseImportDebugEvent } from "@cubby/schemas/purchase-import-debug";
import {
  chargeHuntRunInput,
  researchObjectivesRunInput,
  mailResearchRunInput,
  orderBackfillRunInput,
  orderMailImportRunInput,
  orderMailImportRunOrders,
  type RunRestartInput,
  runInputsErased,
  runRetirementReason,
  runTargetEntityKind,
} from "@cubby/schemas/run-fields";
import { parseShortcodeFor } from "@cubby/shared";
import {
  ACTIVE_RUN_STATUSES,
  PHOTO_RUN_IMAGE_LIMIT,
} from "@cubby/shared/client-constants";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type {
  PhotoImportFinalizeInput,
  PhotoImportFinalizeOutput,
} from "~/contracts/photo-import.contract";
import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  aiUsage,
  auditLog,
  entityIdentity,
  image,
  importPreparedLine,
  importPreparedOrder,
  ledgerParty,
  purchase,
  run as runTable,
  runApproval,
  runControlEvent,
  runOperation,
  photoRunImage,
  user,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { IMAGE_DESCRIPTION_PROCESSOR_REVISION } from "~/server/domains/image-processing/repo/image-processing";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import { publishImageProcessingWakeups } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { persistImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-submission";
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
  readMailRunRoster,
  releaseUnsettledMailRunSources,
  transferMailRunSources,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import {
  loadRunController,
  loadRunControlScopeByShortcode,
} from "~/server/domains/run/repo/control-scope";
import { getRunHeaderByShortcode } from "~/server/domains/run/repo/run";
import {
  DEBUG_EVENT_KIND,
  failOperationsForRun,
} from "~/server/domains/run/repo/run-operation";
import { recordRunProgress } from "~/server/domains/run/repo/run-progress";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { dispatchStartedRun } from "./dispatch";
import { loadRunFindings } from "./run-finding";
import { listRunTargetOutcomes } from "./run-target";

/**
 * The target rows "Start new run with same inputs" copies, with the public
 * codes the run detail shows for them. One selection for both, so the inputs
 * a member reads are exactly the inputs a restart replays.
 */
async function selectNonPhotoTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  const mail = await readMailRunRoster(client, runId);
  const receipts = await listRunTargetOutcomes(client, [runId]);
  // An erased Mail import Run has no targets; its outcome receipts never stand in for the roster.
  if (mail) {
    const ownerIds = [
      ...new Set(
        mail.flatMap(({ email, owned }) =>
          !owned && email.runId ? [email.runId] : [],
        ),
      ),
    ];
    const owners = ownerIds.length
      ? await client
          .select({ id: runTable.id, shortcode: runTable.shortcode })
          .from(runTable)
          .where(inArray(runTable.id, ownerIds))
      : [];
    return mail.map(({ email, orderMailId, checksum, position, owned }) => {
      const outcome = receipts
        .filter(
          (item) =>
            item.workKey === orderMailId &&
            (item.targetFingerprint === checksum ||
              // Migrated hashes include a retired research version. Their
              // original Run/source identity binds them to this frozen roster.
              (item.operationId.startsWith("migrated-target:") &&
                item.entityKind === "run" &&
                item.entityId === runId &&
                item.sourceKind === "mail_message" &&
                item.sourceExternalKey === orderMailId)),
        )
        .sort((a, b) =>
          (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
        )[0];
      return {
        id: email.id,
        entityId: email.id,
        entityKind: "email" as const,
        workKey: orderMailId,
        position,
        vendorAccountId: null,
        vendorAccountCode: null,
        vendorAccountLabel: null,
        sourceKind: "mail_message",
        sourceExternalKey: orderMailId,
        targetFingerprint: checksum,
        entityCode: parseShortcodeFor("email", email.shortcode),
        state:
          outcome?.state ??
          (owned && email.status === "completed"
            ? ("completed" as const)
            : owned && email.status === "researching"
              ? ("pending" as const)
              : ("unresolved" as const)),
        outcome: outcome
          ? outcome.outcome
          : owned && email.status === "completed"
            ? ("verified" as const)
            : null,
        warning: outcome
          ? outcome.warning
          : !owned
            ? email.runId
              ? `Moved to ${owners.find((owner) => owner.id === email.runId)?.shortcode ?? "another Run"}.`
              : "Returned to Mail discovery after this Run ended."
            : email.classificationReason,
        diff: null,
        completedAt: outcome
          ? outcome.completedAt
            ? new Date(outcome.completedAt)
            : null
          : owned && email.status === "completed"
            ? email.updatedAt
            : null,
      };
    });
  }
  const identities = receipts.length
    ? await client
        .select({ id: entityIdentity.id, shortcode: entityIdentity.shortcode })
        .from(entityIdentity)
        .where(
          inArray(
            entityIdentity.id,
            receipts.map((receipt) => receipt.entityId),
          ),
        )
    : [];
  const accountIds = receipts.flatMap((receipt) =>
    receipt.vendorAccountId
      ? [vendorAccountId.parse(receipt.vendorAccountId)]
      : [],
  );
  const accounts = accountIds.length
    ? await client
        .select({
          id: vendorAccount.id,
          shortcode: vendorAccount.shortcode,
          label: vendorAccountLabelSql,
        })
        .from(vendorAccount)
        .where(inArray(vendorAccount.id, accountIds))
    : [];
  return receipts.map((receipt) => ({
    ...receipt,
    position: receipt.position ?? null,
    vendorAccountId: receipt.vendorAccountId ?? null,
    vendorAccountCode:
      accounts.find((account) => account.id === receipt.vendorAccountId)
        ?.shortcode ?? null,
    vendorAccountLabel:
      accounts.find((account) => account.id === receipt.vendorAccountId)
        ?.label ?? null,
    sourceKind: receipt.sourceKind ?? null,
    sourceExternalKey: receipt.sourceExternalKey ?? null,
    entityCode:
      identities.find((identity) => identity.id === receipt.entityId)
        ?.shortcode ?? null,
    completedAt: receipt.completedAt ? new Date(receipt.completedAt) : null,
  }));
}
/** The authoritative roster and latest applicable outcomes used by shared Run progress. */
export function readRunProgressTargets(db: Database, runId: RunId) {
  return selectNonPhotoTargets(getDb(db), runId);
}

function selectRestartTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  return selectNonPhotoTargets(client, runId);
}

function selectPhotoRestartTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  return client
    .select({
      entityId: photoRunImage.imageId,
      entityKind: sql<"image">`${runTargetEntityKind.enum.image}`,
      workKey: photoRunImage.workKey,
      position: photoRunImage.position,
      vendorAccountId: sql<null>`NULL`,
      sourceKind: sql<null>`NULL`,
      sourceExternalKey: sql<null>`NULL`,
      targetFingerprint: photoRunImage.targetFingerprint,
      entityCode: image.shortcode,
      vendorAccountCode: sql<null>`NULL`,
    })
    .from(photoRunImage)
    .innerJoin(image, eq(image.id, photoRunImage.imageId))
    .where(eq(photoRunImage.runId, runId))
    .orderBy(...photoRunImageOrder());
}

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
        JOIN "Image" source ON source."id" = target."imageId" AND source."deletedAt" IS NULL
        WHERE target."runId" = "Run"."id"
          AND target."state" = ${runTargetState.enum.pending}
          AND NOT EXISTS (
            SELECT 1 FROM "ImageProcessingJob" job
            WHERE job."imageId" = target."imageId" AND job."deletedAt" IS NULL
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
 * Consumer-side fence: only the active event generation may admit the agent.
 */
export async function acknowledgeRunCoordinator(
  db: Database,
  input: { runId: string; eventId: string },
) {
  const [run] = await getDb(db)
    .update(runTable)
    .set({
      coordinatorStartedAt: new Date(),
      dispatchError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.dispatchEventId, input.eventId),
        eq(runTable.status, "running"),
        isNull(runTable.coordinatorStartedAt),
      ),
    )
    .returning({ id: runTable.id });
  return Boolean(run);
}

/**
 * Read-only consumer fence before agent admission.
 */
export async function canDispatchRunCoordinator(
  db: Database,
  input: { runId: string; eventId: string },
) {
  const [run] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.dispatchEventId, input.eventId),
        eq(runTable.status, "running"),
        isNull(runTable.coordinatorStartedAt),
      ),
    )
    .limit(1);
  return Boolean(run);
}

export async function loadRunScope(db: Database, runId: string) {
  const parsedRunId = runEntityId.parse(runId);
  const [row] = await getDb(db)
    .select({
      runId: runTable.id,
      publicId: runTable.shortcode,
      agentId: runTable.agentSessionId,
      trigger: runTable.trigger,
      purpose: runTable.purpose,
      status: runTable.status,
      vendorAccountId: runTable.vendorAccountId,
      vendorId: sql<VendorId | null>`coalesce(${runTable.vendorId}, ${vendor.id})`,
      vendorLabel: sql<string | null>`${vendorAccountLabelSql}`,
      allowedHosts: vendor.browserDomains,
      navigationHints: vendor.agentHints,
      website: vendor.website,
      ledgerPartyId: runTable.ledgerPartyId,
      actorUserId: runTable.actorUserId,
      coordinatorModel: runTable.coordinatorModel,
      skillRevision: runTable.skillRevision,
      runtimeRevision: runTable.runtimeRevision,
      dispatchEventId: runTable.dispatchEventId,
      dispatchError: runTable.dispatchError,
      coordinatorStartedAt: runTable.coordinatorStartedAt,
      runUpdatedAt: runTable.updatedAt,
    })
    .from(runTable)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, runTable.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(
        or(
          eq(vendor.id, runTable.vendorId),
          eq(vendor.id, vendorAccount.vendorId),
        ),
        notDeleted(vendor),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(eq(ledgerParty.id, runTable.ledgerPartyId), notDeleted(ledgerParty)),
    )
    .where(eq(runTable.id, parsedRunId))
    .limit(1);
  // Only runs that group AI work lack a party, and they have no import scope.
  if (!row || !row.agentId || !row.actorUserId || !row.ledgerPartyId)
    throw new Error("Import run ownership is unavailable");
  return {
    public: runScope.parse({
      runId: row.runId,
      shortcode: row.publicId,
      agentId: row.agentId,
      trigger: row.trigger,
      purpose: row.purpose,
      status: row.status,
      vendorAccountId: row.vendorAccountId,
      vendorLabel: row.vendorLabel,
      allowedHosts: row.allowedHosts ?? [],
      navigationHints: row.navigationHints,
      coordinatorModel: row.coordinatorModel,
      skillRevision: row.skillRevision,
      runtimeRevision: row.runtimeRevision,
      dispatchEventId: row.dispatchEventId,
      dispatchError: row.dispatchError,
      coordinatorStartedAt: row.coordinatorStartedAt?.toISOString() ?? null,
    }),
    website: row.website,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    actorUserId: row.actorUserId,
    runUpdatedAt: row.runUpdatedAt,
  };
}

export async function loadRunScopeByShortcode(db: Database, publicId: string) {
  const parsedPublicId = runShortcode.parse(publicId);
  const [row] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(eq(runTable.shortcode, parsedPublicId))
    .limit(1);
  if (!row) throw new Error("Purchase import run was not found");
  return loadRunScope(db, row.id);
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
  const { advancePhotoRunQuietly } =
    await import("~/server/domains/photo-import/repo/run/lifecycle");
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

export async function updateAgentProgress(
  db: Database,
  rawInput: AgentProgressEvent,
) {
  const input = agentProgressEvent.parse(rawInput);
  return recordRunProgress(db, input);
}

export async function pauseRunForAuthorization(db: Database, runId: string) {
  const [run] = await getDb(db)
    .update(runTable)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(runTable.id, runEntityId.parse(runId)),
        eq(runTable.status, "running"),
      ),
    )
    .returning({ publicId: runTable.shortcode });
  return run ?? null;
}

export async function resumeAuthorizedRuns(
  db: Database,
  actorUserId: string,
  now = new Date(),
) {
  const owner = userId.parse(actorUserId);
  const repairCutoff = new Date(now.getTime() - 60_000);
  return withTransaction(db, async (tx) => {
    const resumed = await tx
      .update(runTable)
      .set({
        status: "running",
        dispatchEventId: sql`gen_random_uuid()`,
        dispatchError: null,
        failureCode: null,
        endedAt: null,
        coordinatorStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(runTable.actorUserId, owner),
          eq(runTable.status, "paused_auth"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
        ),
      )
      .returning({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      });
    const interrupted = await tx
      .select({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      })
      .from(runTable)
      .where(
        and(
          eq(runTable.actorUserId, owner),
          eq(runTable.status, "running"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
          isNull(runTable.coordinatorStartedAt),
          isNotNull(runTable.dispatchEventId),
          lt(runTable.updatedAt, repairCutoff),
        ),
      );
    for (const item of [...resumed, ...interrupted])
      if (item.eventId)
        await dispatchStartedRun(tx, { ...item, eventId: item.eventId });
    return [...resumed, ...interrupted];
  });
}

/**
 * A funding-paused import an older coordinator stopped for review while its
 * targets were still pending. It is waiting for AI funding, not for review:
 * resume and the funding window both continue it.
 *
 * Retry and restart leave the predecessor in `needs_review` with its
 * `execution_limit` code, but its unresolved targets now belong to the
 * successor (photo targets are copied, Mail sources transferred). A
 * predecessor with any successor is therefore never funding-resumable.
 */
const isFundingStoppedForReview = (row: {
  status: string;
  failureCode: string | null;
  hasSuccessor: boolean;
}) =>
  row.status === "needs_review" &&
  row.failureCode === "execution_limit" &&
  !row.hasSuccessor;

/** Resume only funding-paused imports; manual and authorization pauses stay stopped. */

export async function redispatchBudgetPausedImports(
  db: Database,
  now = new Date(),
  pausedBefore = now,
) {
  return withTransaction(db, async (tx) => {
    const resumed = await tx
      .update(runTable)
      .set({
        status: "running",
        dispatchEventId: sql`gen_random_uuid()`,
        dispatchError: null,
        failureCode: null,
        endedAt: null,
        coordinatorStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(runTable.status, ["paused_auth", "needs_review"]),
          eq(runTable.failureCode, "execution_limit"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          lt(runTable.updatedAt, pausedBefore),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
          // The work moved even if the successor was deleted.
          not(
            related(
              runTable,
              (successor) =>
                sql`${successor.predecessorRunId} = ${outer(runTable.id)}`,
              { includeDeleted: true },
            ).exists(),
          ),
        ),
      )
      .returning({
        id: runTable.id,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      });
    for (const item of resumed)
      if (item.eventId)
        await dispatchStartedRun(tx, { ...item, eventId: item.eventId });
    return resumed.length;
  });
}

export async function pauseAuthorizedRuns(db: Database, actorUserId: string) {
  return getDb(db)
    .update(runTable)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(runTable.actorUserId, userId.parse(actorUserId)),
        eq(runTable.status, "running"),
      ),
    )
    .returning({ id: runTable.id });
}

/**
 * Historical provider-pagination and mailbox-binding receipts: host authority,
 * never shown as Run evidence.
 */
const PRIVATE_OPERATION_KINDS = [
  "research_mail_scope",
  "research_mail_choice",
  "research_mail_page",
  "research_mail_continuation",
] as const;

const PUBLIC_OPERATION_COLUMNS = {
  operationId: runOperation.operationId,
  kind: runOperation.kind,
  state: runOperation.state,
  error: runOperation.error,
  startedAt: runOperation.startedAt,
  completedAt: runOperation.completedAt,
};
const publicRunOperations = (runId: RunId) =>
  and(
    eq(runOperation.runId, runId),
    notInArray(runOperation.kind, [...PRIVATE_OPERATION_KINDS]),
  );

export const STALE_RUN_MS = 2 * 60 * 60_000;

export const assertRunActive = (status: string) => {
  if (status !== "running")
    throw new Error(`Import run is fenced in status ${status}`);
};

/** Photo coordination reads only its explicit pending image targets. */
export async function claimPhotoInventoryWork(db: Database, runId: string) {
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

/**  Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function markRunFailed(
  db: Database,
  input: {
    runId: string;
    failureCode: "agent_failed" | "agent_aborted";
    detail?: string;
    dispatchEventId?: string | null;
  },
) {
  const runId = runEntityId.parse(input.runId);
  const run = await withTransaction(db, async (tx) => {
    const [failed] = await tx
      .update(runTable)
      .set({
        status: "failed",
        failureCode: input.failureCode,
        // The Run page's raw failure text, as `failWorkflowRun` records it.
        ...(input.detail !== undefined && { dispatchError: input.detail }),
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTable.id, runId),
          eq(runTable.status, "running"),
          input.dispatchEventId === undefined
            ? undefined
            : input.dispatchEventId === null
              ? isNull(runTable.dispatchEventId)
              : eq(runTable.dispatchEventId, input.dispatchEventId),
        ),
      )
      .returning({ purpose: runTable.purpose });
    if (failed) await recordChange(tx, { kind: "source", categories: ["run"] });
    if (failed?.purpose === "mail_import")
      await releaseUnsettledMailRunSources(tx, runId);
    return failed;
  });
  return { failed: Boolean(run), detail: input.detail ?? null };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

async function loadPreparedReviewRows(db: Database, runId: string) {
  const database = getDb(db);
  return database
    .select({
      orderId: importPreparedOrder.id,
      stableOrderId: importPreparedOrder.stableOrderId,
      prepareOperationId: importPreparedOrder.prepareOperationId,
      itemOperationId: importPreparedOrder.itemOperationId,
      sourceKind: importPreparedOrder.sourceKind,
      externalKey: importPreparedOrder.sourceExternalKey,
      preparedAt: importPreparedOrder.createdAt,
      stableLineId: importPreparedLine.stableLineId,
      line: importPreparedLine.line,
      identifiers: importPreparedLine.identifiers,
      candidates: importPreparedLine.candidates,
    })
    .from(importPreparedOrder)
    .leftJoin(
      importPreparedLine,
      eq(importPreparedLine.preparedOrderId, importPreparedOrder.id),
    )
    .where(eq(importPreparedOrder.runId, runId))
    .orderBy(
      asc(importPreparedOrder.createdAt),
      asc(importPreparedOrder.id),
      asc(importPreparedLine.position),
    );
}

function projectPreparedOrders(
  rows: Awaited<ReturnType<typeof loadPreparedReviewRows>>,
  operations: Pick<
    typeof runOperation.$inferSelect,
    "kind" | "state" | "result"
  >[],
): RunDetail["preparedOrders"] {
  const committedOrders = new Set<string>();
  for (const operation of operations) {
    if (
      operation.kind !== "commit_purchase_import" ||
      operation.state !== "completed"
    )
      continue;
    const result = commitPurchaseImportOut.safeParse(operation.result);
    if (result.success) {
      for (const item of result.data.items)
        committedOrders.add(item.stableOrderId);
    }
  }
  const reviewOrders = new Map<string, RunDetail["preparedOrders"][number]>();
  for (const row of rows) {
    let order = reviewOrders.get(row.orderId);
    if (!order) {
      order = {
        stableOrderId: row.stableOrderId,
        prepareOperationId: row.prepareOperationId,
        itemOperationId: row.itemOperationId,
        sourceKind: row.sourceKind,
        externalKey: row.externalKey,
        preparedAt: row.preparedAt.toISOString(),
        committed: committedOrders.has(row.stableOrderId),
        lineCount: 0,
        lines: [],
      };
      reviewOrders.set(row.orderId, order);
    }
    if (row.stableLineId !== null) {
      const line = extractedPurchaseLine.parse(row.line);
      order.lines.push(
        preparePurchaseImportOut.shape.orders.element.shape.lines.element.parse(
          {
            stableLineId: row.stableLineId,
            title: line.title,
            amount: line.amount,
            identifiers: row.identifiers,
            candidates: row.candidates,
            requiresProductResolution: line.lineKind === "principal",
          },
        ),
      );
      order.lineCount++;
    }
  }
  return [...reviewOrders.values()];
}

/**
 * The run detail every browser and native surface reads: the kernel
 * `run` row plus its child collections, projected once. Private UUIDs
 * and operation payloads never cross this boundary.
 */
/** What a restart copies from `Run.input`, by public values only. */
function restartInputSummary(
  input: unknown,
  vendorRef: string | null,
): RunRestartInput | null {
  const researchMail = mailResearchRunInput.safeParse(input);
  if (researchMail.success)
    return {
      kind: researchMail.data.kind,
      sourceCount: researchMail.data.sources.length,
    };
  const parsedObjectives = researchObjectivesRunInput.safeParse(input);
  const objectives = parsedObjectives.success ? parsedObjectives.data : null;
  if (objectives) {
    const single =
      objectives.objectives.length === 1 ? objectives.objectives[0] : null;
    if (single?.kind === "vendor_purchases" && vendorRef)
      return { ...single, vendorId: vendorRef };
    const charges = objectives.objectives.flatMap((objective) =>
      objective.kind === "charge_hunt" ? [objective.huntId] : [],
    );
    if (charges.length)
      return { kind: "charge_hunts", chargeCount: charges.length };
    const history = objectives.objectives.find(
      (objective) => objective.kind === "account_history",
    );
    if (history?.kind === "account_history" && history.range)
      return { kind: "order_backfill", ...history.range };
    return null;
  }
  const mail = orderMailImportRunInput.safeParse(input);
  if (mail.success)
    return {
      kind: "order_mail_import" as const,
      orderIds: orderMailImportRunOrders(mail.data).map(
        (order) => order.orderId,
      ),
    };
  const backfill = orderBackfillRunInput.safeParse(input);
  if (backfill.success) return backfill.data;
  const charges = chargeHuntRunInput.safeParse(input);
  if (charges.success)
    return {
      kind: "charge_hunts" as const,
      chargeCount: charges.data.huntIds.length,
    };
  return null;
}

/** A durable timeline needs public operation metadata, never result payloads
 * or the import-specific targets and restart context. */
export async function loadRunTimeline(
  db: Database,
  runId: RunId,
): Promise<RunDetail["operations"]> {
  const operations = await getDb(db)
    .select(PUBLIC_OPERATION_COLUMNS)
    .from(runOperation)
    .where(publicRunOperations(runId))
    .orderBy(asc(runOperation.startedAt));
  return operations.map((operation) => ({
    ...operation,
    startedAt: operation.startedAt.toISOString(),
    completedAt: iso(operation.completedAt),
  }));
}

export async function loadRunDetail(
  db: Database,
  shortcode: string,
  preparedHeader?: ReturnType<typeof getRunHeaderByShortcode>,
): Promise<RunDetail> {
  const publicId = runShortcode.parse(shortcode);
  const database = getDb(db);
  const [header, [run]] = await Promise.all([
    preparedHeader ?? getRunHeaderByShortcode(db, publicId),
    database
      .select({
        id: runTable.id,
        dispatchEventId: runTable.dispatchEventId,
        retirementReason: runTable.retirementReason,
        purpose: runTable.purpose,
        progressHistory: runTable.progressHistory,
        actorLedgerPartyShortcode: runTable.actorLedgerPartyShortcode,
        actorLedgerPartyName: runTable.actorLedgerPartyName,
        input: runTable.input,
      })
      .from(runTable)
      .where(and(eq(runTable.shortcode, publicId), notDeleted(runTable)))
      .limit(1),
  ]);
  if (!header || !run) throw new Error("Import run was not found");

  const [
    successor,
    operations,
    preparedOrders,
    progress,
    affectedPurchases,
    findings,
    controlHistory,
    targets,
    agentModelUsage,
    restartTargets,
  ] = await Promise.all([
    database
      .select({ publicId: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.predecessorRunId, run.id))
      .orderBy(desc(runTable.startedAt))
      .limit(1),
    database
      .select({
        ...PUBLIC_OPERATION_COLUMNS,
        result: runOperation.result,
      })
      .from(runOperation)
      .where(publicRunOperations(run.id))
      .orderBy(asc(runOperation.startedAt)),
    loadPreparedReviewRows(db, run.id),
    Promise.resolve(run.progressHistory ?? []),
    database
      .selectDistinct({
        shortcode: purchase.shortcode,
        displayName: purchase.displayLabel,
        orderId: purchase.orderId,
      })
      .from(auditLog)
      .innerJoin(
        purchase,
        and(eq(purchase.id, auditLog.entityId), notDeleted(purchase)),
      )
      .where(
        and(eq(auditLog.runId, run.id), eq(auditLog.entityKind, "purchase")),
      ),
    loadRunFindings(db, run.id),
    database
      .select({
        action: runControlEvent.action,
        userId: runControlEvent.controllerUserId,
        name: runControlEvent.controllerName,
        ledgerPartyId: runControlEvent.controllerLedgerPartyShortcode,
        ledgerPartyName: runControlEvent.controllerLedgerPartyName,
        createdAt: runControlEvent.createdAt,
      })
      .from(runControlEvent)
      .where(eq(runControlEvent.runId, run.id))
      .orderBy(asc(runControlEvent.createdAt)),
    run.purpose === "photo_inventory"
      ? database
          .select({
            id: photoRunImage.id,
            entityKind: sql<"image">`${runTargetEntityKind.enum.image}`,
            entityId: photoRunImage.imageId,
            entityCode: image.shortcode,
            vendorAccountId: sql<null>`NULL`,
            vendorAccountLabel: sql<null>`NULL`,
            sourceKind: sql<null>`NULL`,
            sourceExternalKey: sql<null>`NULL`,
            state: photoRunImage.state,
            targetFingerprint: photoRunImage.targetFingerprint,
            outcome: photoRunImage.outcome,
            warning: photoRunImage.skipReason,
            diff: photoRunImage.commitReceipt,
            completedAt: photoRunImage.completedAt,
          })
          .from(photoRunImage)
          .innerJoin(image, eq(image.id, photoRunImage.imageId))
          .where(eq(photoRunImage.runId, run.id))
          .orderBy(...photoRunImageOrder())
      : selectNonPhotoTargets(database, run.id),
    database
      .select({
        durationMs: sql<number>`coalesce(sum(${aiUsage.durationMs}), 0)`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.runId, run.id),
          eq(aiUsage.feature, "purchase_import_agent"),
          notDeleted(aiUsage),
        ),
      ),
    run.purpose === "photo_inventory"
      ? selectPhotoRestartTargets(database, run.id)
      : selectRestartTargets(database, run.id),
  ]);
  const { lookupEntityLabels } =
    await import("~/server/generic/shortcode/repo/shortcode-resolver");
  const targetNames = await lookupEntityLabels(
    db,
    targets.map((target) => parseEntityRef(target.entityKind, target.entityId)),
  );
  const publicSourceKey = (
    target: Pick<(typeof targets)[number], "sourceKind" | "sourceExternalKey">,
  ) => {
    if (target.sourceKind === "mail_message") return null;
    return target.sourceKind === "vendor_purchases"
      ? header.vendorId
      : target.sourceExternalKey;
  };
  const controller = (event: (typeof controlHistory)[number]) => ({
    name: event.name,
    ledgerParty: { id: event.ledgerPartyId, name: event.ledgerPartyName },
  });
  const browserProgress = progress.map((event) => ({
    eventId: event.eventId,
    phase: event.phase,
    currentItem: event.currentItem,
    awaitingApproval: event.awaitingApproval,
    detail: event.detail,
    createdAt: event.createdAt,
  }));
  return {
    publicId,
    status: header.status,
    purpose: header.purpose,
    trigger: header.trigger,
    parentRunId: header.parentRunId,
    cause: header.cause,
    attempt: header.attempt,
    source: { kind: header.trigger, vendorName: header.vendorName },
    actor: {
      name: header.actorName,
      ledgerParty: {
        id: run.actorLedgerPartyShortcode,
        name: run.actorLedgerPartyName,
      },
    },
    vendorAccount:
      header.vendorAccountId && header.vendorAccountLabel
        ? { id: header.vendorAccountId, label: header.vendorAccountLabel }
        : null,
    startedAt: header.startedAt.toISOString(),
    endedAt: iso(header.endedAt),
    ordersSeen: header.ordersSeen,
    imported: header.imported,
    updated: header.updated,
    skipped: header.skipped,
    failureCode: header.failureCode,
    notes: header.notes,
    retirementReason: runRetirementReason
      .nullable()
      .parse(run.retirementReason),
    dispatch: {
      eventId: run.dispatchEventId,
      state: header.coordinatorStartedAt
        ? "started"
        : header.dispatchError
          ? "failed"
          : "pending",
      error: header.dispatchError,
      coordinatorStartedAt: iso(header.coordinatorStartedAt),
    },
    predecessorRunPublicId: header.predecessorRunId
      ? runShortcode.parse(header.predecessorRunId)
      : null,
    successorRunPublicId: successor[0]
      ? runShortcode.parse(successor[0].publicId)
      : null,
    // What `restart` writes to its successor: this run's settings and targets.
    // An erased Run has nothing left to copy.
    restartInputs:
      agentImportRunPurpose.safeParse(header.purpose).success &&
      !runInputsErased(run.retirementReason)
        ? {
            purpose: header.purpose,
            trigger: "manual",
            coordinatorModel: coordinatorModelFor(header.purpose),
            vendor: header.vendorId,
            vendorAccount: header.vendorAccountId,
            input: restartInputSummary(run.input, header.vendorId),
            notes: header.notes,
            skillRevision: header.skillRevision,
            runtimeRevision: header.runtimeRevision,
            targets: restartTargets.map((target) => ({
              position: target.position,
              image: target.entityKind === "image" ? target.entityCode : null,
              purchase:
                target.entityKind === "purchase" ? target.entityCode : null,
              product:
                target.entityKind === "product" ? target.entityCode : null,
              vendorAccount: target.vendorAccountCode,
              sourceKind: target.sourceKind,
              sourceExternalKey: publicSourceKey(target),
              targetFingerprint:
                target.sourceKind === "mail_message"
                  ? null
                  : target.targetFingerprint,
            })),
          }
        : null,
    coordinatorModel: header.coordinatorModel,
    skillRevision: header.skillRevision,
    runtimeRevision: header.runtimeRevision,
    agentModelMs: Number(agentModelUsage[0]?.durationMs ?? 0),
    operations: operations.map(({ result: _result, ...operation }) => ({
      ...operation,
      startedAt: operation.startedAt.toISOString(),
      completedAt: iso(operation.completedAt),
    })),
    preparedOrders: projectPreparedOrders(preparedOrders, operations),
    targets: targets.map((target) => ({
      id: target.id,
      targetType: target.entityKind,
      // Image targets need their IMG- code too: photos often share a filename.
      targetShortcode: target.entityCode,
      targetName:
        targetNames.get(entityRefKey(target.entityKind, target.entityId)) ??
        null,
      sourceId: null,
      sourceLabel: target.sourceKind
        ? `${target.sourceKind}${publicSourceKey(target) ? ` · ${publicSourceKey(target)}` : ""}`
        : null,
      vendorAccountLabel: target.vendorAccountLabel,
      state: target.state,
      fingerprint:
        target.sourceKind === "mail_message" ? null : target.targetFingerprint,
      outcome: target.outcome,
      warning: target.warning,
      diff: z
        .json()
        .nullable()
        .parse(target.diff ?? null),
      completedAt: iso(target.completedAt),
    })),
    affectedPurchases,
    findings,
    controllingMembers: [
      ...new Map(
        controlHistory.map((event) => [event.userId, controller(event)]),
      ).values(),
    ],
    controlHistory: controlHistory.map((event) => ({
      action: event.action,
      ...controller(event),
      createdAt: event.createdAt.toISOString(),
    })),
    progress: browserProgress,
    latestProgress: browserProgress.at(-1) ?? null,
  };
}

const MAX_LOG_ENTRIES = 2_000;

const emptyLogMetadata = {
  commandId: null,
  operationId: null,
  operationKind: null,
  host: null,
  browser: null,
  attempt: null,
  count: null,
  outcome: null,
  messageType: null,
  errorType: null,
  errorCode: null,
  error: null,
} as const;

function debugOperationLogEntry(
  operation: Parameters<typeof operationLogEntry>[0],
): RunLogEntry | null {
  const event = purchaseImportDebugEvent.safeParse(operation.result);
  if (!event.success) return null;
  return {
    id: operation.id,
    occurredAt: event.data.occurredAt,
    source: "mac",
    level:
      event.data.outcome?.startsWith("failed:") || event.data.errorType
        ? "error"
        : "debug",
    event: event.data.event,
    state: operation.state,
    commandId: event.data.commandId ?? null,
    operationId: event.data.operationId ?? null,
    operationKind: event.data.operationKind ?? null,
    host: event.data.host ?? null,
    browser: event.data.browser ?? null,
    attempt: event.data.attempt ?? null,
    count: event.data.count ?? null,
    outcome: event.data.outcome ?? null,
    messageType: event.data.messageType ?? null,
    errorType: event.data.errorType ?? null,
    errorCode: event.data.errorCode ?? null,
    error: null,
  };
}

function operationLogEntry(
  operation: Pick<
    typeof runOperation.$inferSelect,
    "id" | "operationId" | "kind" | "state" | "result" | "error" | "startedAt"
  >,
): RunLogEntry | null {
  if (operation.kind === DEBUG_EVENT_KIND)
    return debugOperationLogEntry(operation);

  return {
    id: operation.id,
    occurredAt: operation.startedAt.toISOString(),
    source: "server",
    level: operation.state === "failed" ? "error" : "info",
    event: `tool.${operation.kind}`,
    state: operation.state,
    ...emptyLogMetadata,
    operationId: operation.operationId,
    error: operation.error?.slice(0, 300) ?? null,
  };
}

/** Server tool calls and Mac bridge debug events, in occurrence order. */
export async function loadRunLog(db: Database, shortcode: string) {
  const database = getDb(db);
  const [run] = await database
    .select({
      id: runTable.id,
      status: runTable.status,
      failureCode: runTable.failureCode,
      startedAt: runTable.startedAt,
      endedAt: runTable.endedAt,
    })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(shortcode)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const operations = await database
    .select({
      id: runOperation.id,
      operationId: runOperation.operationId,
      kind: runOperation.kind,
      state: runOperation.state,
      result: runOperation.result,
      error: runOperation.error,
      startedAt: runOperation.startedAt,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, run.id),
        notInArray(runOperation.kind, [...PRIVATE_OPERATION_KINDS]),
      ),
    )
    .orderBy(asc(runOperation.startedAt), asc(runOperation.id))
    .limit(MAX_LOG_ENTRIES + 1);

  const entries: RunLogEntry[] = [
    {
      id: `run:${run.id}:started`,
      occurredAt: run.startedAt.toISOString(),
      source: "run",
      level: "info",
      event: "run.started",
      state: "running",
      ...emptyLogMetadata,
    },
    ...operations
      .slice(0, MAX_LOG_ENTRIES)
      .flatMap((operation) => operationLogEntry(operation) ?? []),
  ];
  if (run.endedAt) {
    entries.push({
      id: `run:${run.id}:ended`,
      occurredAt: run.endedAt.toISOString(),
      source: "run",
      level: run.status === "failed" ? "error" : "info",
      event: `run.${run.status}`,
      state: run.status,
      ...emptyLogMetadata,
      error: run.failureCode,
    });
  }
  entries.sort(
    (left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
  return { entries, truncated: operations.length > MAX_LOG_ENTRIES };
}

const runControlInput = z.object({
  runPublicId: runShortcode,
  action: z.enum([
    "pause",
    "resume",
    "cancel",
    "abort",
    "retry",
    "restart",
    "retry_dispatch",
    "upload_evidence",
    "no_evidence_available",
    "escalate_sol",
    "run_now_paid",
  ]),
  paidOverBudgetUsd: paidOverBudgetUsd.optional(),
});

const runControlAction = z.enum([
  "prompt",
  "abort",
  "pause",
  "resume",
  "cancel",
  "retry",
  "restart",
  "retry_dispatch",
  "upload_evidence",
  "no_evidence_available",
  "escalate_sol",
]);

export async function recordRunControlEvent(
  db: Database,
  actor: ActorContext,
  rawInput: {
    runPublicId: string;
    action: z.input<typeof runControlAction>;
  },
) {
  const input = z
    .object({ runPublicId: runShortcode, action: runControlAction })
    .parse(rawInput);
  const scope = await loadRunControlScopeByShortcode(db, input.runPublicId);
  const controller = await loadRunController(db, actor);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  const [event] = await getDb(db)
    .insert(runControlEvent)
    .values({
      runId: scope.runId,
      action: input.action,
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: controller.ledgerPartyId,
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
    })
    .returning({
      id: runControlEvent.id,
      createdAt: runControlEvent.createdAt,
    });
  if (!event) throw new Error("Import run control event was not recorded");
  return event;
}

export async function controlRun(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof runControlInput>,
) {
  const input = runControlInput.parse(rawInput);
  const scope = await loadRunControlScopeByShortcode(db, input.runPublicId);
  const controller = await loadRunController(db, actor);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  if (
    scope.purpose !== "photo_inventory" &&
    scope.ledgerPartyId !== controller.ledgerPartyId
  )
    throw new Error("Only the member this Run belongs to can control it");
  return withTransaction(db, async (tx) => {
    if (scope.vendorAccountId)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scope.vendorAccountId}))`,
      );
    const [locked] = await tx
      .select({
        status: runTable.status,
        failureCode: runTable.failureCode,
        ledgerPartyId: runTable.ledgerPartyId,
        actorUserId: runTable.actorUserId,
        actorName: runTable.actorName,
        actorEmail: runTable.actorEmail,
        actorLedgerPartyShortcode: runTable.actorLedgerPartyShortcode,
        actorLedgerPartyName: runTable.actorLedgerPartyName,
        actorLedgerPartyKind: runTable.actorLedgerPartyKind,
        vendorAccountId: runTable.vendorAccountId,
        vendorId: runTable.vendorId,
        purpose: runTable.purpose,
        trigger: runTable.trigger,
        parentRunId: runTable.parentRunId,
        notes: runTable.notes,
        input: runTable.input,
        skillRevision: runTable.skillRevision,
        runtimeRevision: runTable.runtimeRevision,
        dispatchEventId: runTable.dispatchEventId,
        coordinatorStartedAt: runTable.coordinatorStartedAt,
        decisionRevision: runTable.decisionRevision,
        historyCursorUrl: runTable.historyCursorUrl,
      })
      .from(runTable)
      .where(eq(runTable.id, scope.runId))
      .limit(1)
      // A key-preserving lock: this transaction also touches child rows
      // whose foreign keys share-lock the Run, so a full lock could deadlock.
      .for("no key update");
    if (!locked) throw new Error("Purchase import run was not found");
    if (locked.vendorAccountId !== scope.vendorAccountId)
      throw new Error("Purchase import control account changed.");
    if (locked.ledgerPartyId !== scope.ledgerPartyId)
      throw new Error("Purchase import control owner changed.");
    if (input.action === "restart") {
      if (
        !new Set([
          "completed",
          "failed",
          "needs_review",
          "dispatch_failed",
        ]).has(locked.status)
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Only a finished run can be started again (${locked.status})`,
        );
      if (!agentImportRunPurpose.safeParse(locked.purpose).success)
        throw new Error("Only agent import runs can be started again");
      const sourceTargets = (
        await (locked.purpose === "photo_inventory"
          ? selectPhotoRestartTargets(tx, scope.runId)
          : selectRestartTargets(tx, scope.runId))
      ).map((target) => ({
        entityId: target.entityId,
        entityKind: target.entityKind,
        workKey: target.workKey,
        position: target.position,
        vendorAccountId: target.vendorAccountId,
        sourceKind: target.sourceKind,
        sourceExternalKey: target.sourceExternalKey,
        targetFingerprint: target.targetFingerprint,
      }));
      if (sourceTargets.length === 0)
        throw new Error("This run has no inputs to start again");
      if (
        locked.purpose === "photo_inventory" &&
        sourceTargets.some((target) => target.entityKind !== "image")
      )
        throw new Error("Photo run inputs are incomplete");
      const successorId = runEntityId.parse(crypto.randomUUID());
      const dispatchEventId = crypto.randomUUID();
      const successor = await insertWithShortcode(tx, "run", {
        id: successorId,
        ledgerPartyId: locked.ledgerPartyId,
        actorUserId: userId.parse(controller.userId),
        actorName: controller.name,
        actorEmail: controller.email,
        actorLedgerPartyShortcode: controller.ledgerPartyShortcode,
        actorLedgerPartyName: controller.ledgerPartyName,
        actorLedgerPartyKind: controller.ledgerPartyKind,
        vendorAccountId: locked.vendorAccountId,
        vendorId: locked.vendorId,
        predecessorRunId: scope.runId,
        parentRunId:
          locked.purpose === "mail_import" ? locked.parentRunId : null,
        purpose: locked.purpose,
        trigger: "manual",
        notes: locked.notes,
        input: locked.input,
        coordinatorModel: coordinatorModelFor(locked.purpose),
        skillRevision: locked.skillRevision,
        runtimeRevision: locked.runtimeRevision,
        dispatchEventId,
        agentSessionId: importRunAgentIdentity(
          successorId,
          agentImportRunPurpose.parse(locked.purpose),
        ),
      });
      if (locked.purpose === "photo_inventory") {
        if (sourceTargets.length)
          await tx.insert(photoRunImage).values(
            sourceTargets.map((target) => ({
              runId: successorId,
              imageId: imageId.parse(target.entityId),
              workKey: target.workKey,
              position: target.position,
              targetFingerprint: target.targetFingerprint,
              state: "pending" as const,
            })),
          );
      } else if (locked.purpose === "mail_import") {
        await transferMailRunSources(tx, scope.runId, successorId);
      }
      await dispatchStartedRun(tx, {
        id: successorId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: locked.status,
        successorRunId: successorId,
        successorRunPublicId: successor.shortcode,
        successorStatus: successor.status,
        created: true,
        dispatchRunId: successorId,
        dispatchPublicId: successor.shortcode,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    await tx.insert(runControlEvent).values({
      runId: scope.runId,
      action: input.action,
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: controller.ledgerPartyId,
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
      paidOverBudgetUsd: input.paidOverBudgetUsd ?? null,
    });
    await recordChange(tx, { kind: "source", categories: ["run"] });
    if (input.action === "retry_dispatch") {
      if (
        !new Set(["running", "dispatch_failed"]).has(locked.status) ||
        locked.coordinatorStartedAt
      ) {
        throw new Error("Only an unacknowledged dispatch can be retried");
      }
      const dispatchEventId = crypto.randomUUID();
      await tx
        .update(runTable)
        .set({
          status: "running",
          failureCode: null,
          endedAt: null,
          dispatchEventId,
          dispatchError: null,
          coordinatorModel: coordinatorModelFor(locked.purpose),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await dispatchStartedRun(tx, {
        id: scope.runId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: "running" as const,
        dispatchRunId: scope.runId,
        dispatchPublicId: input.runPublicId,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    if (input.action === "retry" || input.action === "escalate_sol") {
      if (!new Set(["needs_review", "completed", "failed"]).has(locked.status))
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is not terminal in ${locked.status}`,
        );
      const successorVendorAccountId = locked.vendorAccountId
        ? vendorAccountId.parse(locked.vendorAccountId)
        : null;
      const [existingSuccessor] = await tx
        .select({
          id: runTable.id,
          publicId: runTable.shortcode,
          status: runTable.status,
        })
        .from(runTable)
        .where(eq(runTable.predecessorRunId, scope.runId))
        .orderBy(desc(runTable.startedAt))
        .limit(1);
      if (existingSuccessor) {
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: existingSuccessor.id,
          successorRunPublicId: existingSuccessor.publicId,
          successorStatus: existingSuccessor.status,
          created: false,
        };
      }
      const successorId = runEntityId.parse(crypto.randomUUID());
      const dispatchEventId = crypto.randomUUID();
      const unresolvedTargets =
        locked.purpose === "photo_inventory"
          ? await tx
              .select({
                entityId: photoRunImage.imageId,
                entityKind: sql<"image">`${runTargetEntityKind.enum.image}`,
                workKey: photoRunImage.workKey,
                position: photoRunImage.position,
                vendorAccountId: sql<null>`NULL`,
                sourceKind: sql<null>`NULL`,
                sourceExternalKey: sql<null>`NULL`,
                targetFingerprint: photoRunImage.targetFingerprint,
              })
              .from(photoRunImage)
              .where(
                and(
                  eq(photoRunImage.runId, scope.runId),
                  inArray(photoRunImage.state, [
                    "pending",
                    "prepared",
                    "unresolved",
                    "needs_evidence",
                    "unavailable",
                  ]),
                ),
              )
          : (await selectRestartTargets(tx, scope.runId)).filter((target) =>
              [
                "pending",
                "prepared",
                "unresolved",
                "needs_evidence",
                "unavailable",
              ].includes(target.state),
            );
      if (!unresolvedTargets.length)
        throw new Error("This Run has no unresolved targets to retry");
      const successorInput =
        locked.purpose === "mail_import"
          ? {
              ...mailResearchRunInput.parse(locked.input),
              sources: mailResearchRunInput
                .parse(locked.input)
                .sources.filter((source) =>
                  unresolvedTargets.some(
                    (target) => target.workKey === source.orderMailId,
                  ),
                ),
            }
          : locked.input;
      const successor = await insertWithShortcode(tx, "run", {
        id: successorId,
        ledgerPartyId: locked.ledgerPartyId,
        actorUserId: locked.actorUserId,
        actorName: locked.actorName,
        actorEmail: locked.actorEmail,
        actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
        actorLedgerPartyName: locked.actorLedgerPartyName,
        actorLedgerPartyKind: locked.actorLedgerPartyKind,
        vendorAccountId: successorVendorAccountId,
        vendorId: locked.vendorId,
        predecessorRunId: scope.runId,
        parentRunId:
          locked.purpose === "mail_import" ? locked.parentRunId : null,
        purpose: locked.purpose,
        trigger: locked.trigger,
        input: successorInput,
        dispatchEventId,
        coordinatorModel: coordinatorModelFor(locked.purpose),
        skillRevision: locked.skillRevision,
        runtimeRevision: locked.runtimeRevision,
        decisionRevision: locked.decisionRevision + 1,
        agentSessionId: importRunAgentIdentity(
          successorId,
          agentImportRunPurpose.parse(locked.purpose),
        ),
      });
      if (locked.purpose === "photo_inventory") {
        await tx.insert(photoRunImage).values(
          unresolvedTargets.map((target) => ({
            runId: successorId,
            imageId: imageId.parse(target.entityId),
            workKey: target.workKey,
            position: target.position,
            targetFingerprint: target.targetFingerprint,
            state: "pending" as const,
          })),
        );
      } else if (locked.purpose === "mail_import") {
        await transferMailRunSources(
          tx,
          scope.runId,
          successorId,
          unresolvedTargets.map((target) => target.workKey),
        );
      }
      await dispatchStartedRun(tx, {
        id: successorId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: locked.status,
        successorRunId: successorId,
        successorRunPublicId: successor.shortcode,
        successorStatus: successor.status,
        created: true,
        dispatchRunId: successorId,
        dispatchPublicId: successor.shortcode,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    if (input.action === "cancel" || input.action === "abort") {
      const dispatchAbort = input.action === "abort";
      if (
        dispatchAbort
          ? !new Set(["running", "dispatch_failed"]).has(locked.status) ||
            locked.coordinatorStartedAt !== null
          : !ACTIVE_RUN_STATUSES.some((status) => status === locked.status)
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is immutable in ${locked.status}`,
        );
      await tx
        .update(runTable)
        .set({
          status: "failed",
          failureCode: dispatchAbort ? "dispatch_aborted" : "user_cancelled",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await tx
        .update(runApproval)
        .set({ state: "invalidated", invalidatedAt: new Date() })
        .where(
          and(
            eq(runApproval.runId, scope.runId),
            inArray(runApproval.state, ["pending", "granted"]),
          ),
        );
      await failOperationsForRun(
        tx,
        scope.runId,
        dispatchAbort
          ? "Dispatch aborted by its owner"
          : "Run cancelled by its owner",
      );
      return { publicId: input.runPublicId, status: "failed" as const };
    }
    if (input.action === "pause") {
      if (locked.status !== "running")
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is fenced in ${locked.status}`,
        );
      await tx
        .update(runTable)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(runTable.id, scope.runId));
      return {
        publicId: input.runPublicId,
        status: "paused" as const,
      };
    }
    if (input.action === "resume" || input.action === "run_now_paid") {
      // The recorded `run_now_paid` event is the paid grant
      // (`readPaidGrant`); resuming is the same redispatch.
      if (
        !new Set(
          input.action === "run_now_paid"
            ? ["paused", "paused_auth"]
            : ["paused", "paused_auth", "paused_offline"],
        ).has(locked.status) &&
        !isFundingStoppedForReview({
          ...locked,
          hasSuccessor:
            (
              await tx
                .select({ id: runTable.id })
                .from(runTable)
                .where(eq(runTable.predecessorRunId, scope.runId))
                .limit(1)
            ).length > 0,
        })
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is fenced in ${locked.status}`,
        );
      const dispatchEventId = crypto.randomUUID();
      await tx
        .update(runTable)
        .set({
          status: "running",
          failureCode: null,
          dispatchEventId,
          dispatchError: null,
          coordinatorStartedAt: null,
          endedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await dispatchStartedRun(tx, {
        id: scope.runId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: "running" as const,
        dispatchRunId: scope.runId,
        dispatchPublicId: input.runPublicId,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }

    throw new Error(`Unsupported Run control: ${input.action}`);
  });
}
