import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  imageId,
  imageShortcode,
  ledgerPartyId,
  productId,
  purchaseId,
  userId,
  runEntityId,
  vendorAccountId,
  type LedgerPartyId,
  type RunId,
  type UserId,
  type VendorAccountId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  flueImportRunPurpose,
  importRunAgentIdentity,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import {
  browserBridgeOperation,
  browserBridgeRequest,
  browserCapture,
  runShortcode,
  runPurpose,
  runTrigger,
  runTargetState,
  runScope,
  type BrowserBridgeOperation,
  type RunTrigger,
  type RunPurpose,
} from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
import { generateShortcode } from "@cubby/shared";
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
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type {
  PhotoImportFinalizeInput,
  PhotoImportFinalizeOutput,
} from "~/contracts/photo-import.contract";
import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import { purchaseImportDebugEvent } from "~/lib/purchase-import-debug";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  aiUsage,
  entityAttachment,
  financialTransaction,
  financialTransactionAllocation,
  image,
  runFinding,
  importHunt,
  importPreparedLine,
  importPreparedOrder,
  run as runTable,
  runApproval,
  runControlEvent,
  runEvidence,
  runMutation,
  runOperation,
  runOrderCandidate,
  runProgress,
  runTarget,
  photoGroupProposal,
  ledgerParty,
  product,
  productExternalId,
  purchase,
  user,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createImageProcessingSubmission } from "~/server/repo/image-processing-history";
import { persistImageProcessingSubmission } from "~/server/repo/image-processing-submission";
import { withPhotoImportTransaction } from "~/server/repo/photo-import";
import { getRunByShortcode } from "~/server/repo/run";
import { sha256Hex } from "~/server/semantic/hash";
import { publishImageProcessingWakeups } from "~/server/services/image-processing.service";
import {
  productionPhotoImportCommitPorts,
  verifyStagedImages,
  type PhotoImportCommitPorts,
} from "~/server/services/photo-import-commit.service";
import { finalizeImportedImages } from "~/server/services/photo-import-finalize.service";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { loadPurchaseAuditBatch } from "./audit-batch";
import type { PurchaseImportDurableObjectRpc } from "./contracts";
import { resolveRunFinding } from "./findings";
import { attachPendingOrderMailEvidence } from "./gmail/process";
import { classifyOrderCapture } from "./order-list";
import { loadReceiptEvidenceForRun } from "./receipt-evidence";
import { importVendorOrder } from "./writer";

/** The Flue coordinator model for a run purpose; purchase-agent reads the same manifest. */
function coordinatorModelFor(purpose: string) {
  const parsed = flueImportRunPurpose.safeParse(purpose);
  return importRunAgentManifest[parsed.success ? parsed.data : "account_sync"]
    .model;
}

/**
 * The target rows "Start new run with same inputs" copies, with the public
 * codes the run detail shows for them. One selection for both, so the inputs
 * a member reads are exactly the inputs a restart replays.
 */
function selectRestartTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  return client
    .select({
      purchaseId: runTarget.purchaseId,
      productId: runTarget.productId,
      imageId: runTarget.imageId,
      position: runTarget.position,
      vendorAccountId: runTarget.vendorAccountId,
      sourceKind: runTarget.sourceKind,
      sourceExternalKey: runTarget.sourceExternalKey,
      targetFingerprint: runTarget.targetFingerprint,
      purchaseCode: purchase.shortcode,
      productCode: product.shortcode,
      imageCode: image.shortcode,
      vendorAccountCode: vendorAccount.shortcode,
    })
    .from(runTarget)
    .leftJoin(purchase, eq(purchase.id, runTarget.purchaseId))
    .leftJoin(product, eq(product.id, runTarget.productId))
    .leftJoin(image, eq(image.id, runTarget.imageId))
    .leftJoin(vendorAccount, eq(vendorAccount.id, runTarget.vendorAccountId))
    .where(eq(runTarget.runId, runId))
    .orderBy(asc(runTarget.position), asc(runTarget.createdAt));
}

const ACTIVE_RUN_STATUSES = [
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
] as const;

type TargetedRunTarget =
  | {
      kind: "purchase";
      purchaseId: string;
      vendorAccountId?: string | null;
      sourceKind?: string | null;
      sourceExternalKey?: string | null;
      targetFingerprint: string;
      evidenceFingerprint?: string | null;
    }
  | {
      kind: "product";
      productId: string;
      vendorAccountId?: string | null;
      sourceKind?: string | null;
      sourceExternalKey?: string | null;
      targetFingerprint: string;
      evidenceFingerprint?: string | null;
    };

export type StartTargetedRunInput = {
  ledgerPartyId: LedgerPartyId;
  purpose: Exclude<RunPurpose, "account_sync">;
  vendorId: VendorId;
  vendorAccountId?: VendorAccountId | null;
  trigger: RunTrigger;
  predecessorRunId?: string;
  targets: TargetedRunTarget[];
};

const OFFLINE_EXPIRY_MS = 24 * 60 * 60_000;

/**
 * Postgres-side replay ledger for Flue tools. A completed operation returns its
 * original result even after the run becomes terminal. A concurrent delivery
 * sees `started` and retries later; external writers retain their own source
 * claims for the crash window between their commit and this completion write.
 */
export async function runImportOperation<T extends object | null>(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    payload: unknown;
    /**
     * Only for `work` that is a single transaction: a `failed` row holds no
     * partial side effects, so a changed payload may take the operation over.
     */
    retryFailedWithChangedInput?: boolean;
  },
  work: () => Promise<T>,
): Promise<T> {
  const runId = runEntityId.parse(input.runId);
  const fingerprint = await sha256Hex(JSON.stringify(input.payload));
  const database = getDb(db);
  const [inserted] = await database
    .insert(runOperation)
    .values({
      runId,
      operationId: input.operationId,
      kind: input.kind,
      inputFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: runOperation.id });
  if (!inserted) {
    const [recorded] = await database
      .select({
        inputFingerprint: runOperation.inputFingerprint,
        state: runOperation.state,
        result: runOperation.result,
        updatedAt: runOperation.updatedAt,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, runId),
          eq(runOperation.operationId, input.operationId),
        ),
      )
      .limit(1);
    const takesOverFailed =
      input.retryFailedWithChangedInput === true &&
      recorded?.state === "failed";
    if (
      !recorded ||
      (recorded.inputFingerprint !== fingerprint && !takesOverFailed)
    )
      throw new Error("Operation id was replayed with different input");
    if (recorded.state === "completed") {
      // SAFETY: the unique operation row is written only by this generic call
      // with the same fingerprint, so its completed JSON has work's T shape.
      return recorded.result as T;
    }
    if (
      recorded.state === "started" &&
      Date.now() - recorded.updatedAt.getTime() < 5 * 60_000
    )
      throw new Error("Import operation is already in progress");
    // Compare-and-set on the state and fingerprint just read: two deliveries
    // that both saw the same `failed` (or stale `started`) row must not both
    // take it over and run `work` twice.
    const [claimed] = await database
      .update(runOperation)
      .set({
        state: "started",
        error: null,
        inputFingerprint: fingerprint,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, runId),
          eq(runOperation.operationId, input.operationId),
          eq(runOperation.state, recorded.state),
          eq(runOperation.inputFingerprint, recorded.inputFingerprint),
        ),
      )
      .returning({ id: runOperation.id });
    if (!claimed) throw new Error("Import operation is already in progress");
  }
  try {
    const result = await work();
    await database
      .update(runOperation)
      .set({
        state: "completed",
        result,
        error: null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, runId),
          eq(runOperation.operationId, input.operationId),
        ),
      );
    return result;
  } catch (error) {
    await database
      .update(runOperation)
      .set({
        state: "failed",
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "unknown",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, runId),
          eq(runOperation.operationId, input.operationId),
        ),
      );
    throw error;
  }
}

const operationUuid = async (runId: string, operationId: string) => {
  const hex = await sha256Hex(`${runId}:${operationId}`);
  const bytes = Uint8Array.from(
    hex.slice(0, 32).match(/.{2}/gu) ?? [],
    (value) => Number.parseInt(value, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const normalized = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return z
    .uuid()
    .parse(
      `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`,
    );
};

export type PurchaseImportNamespace = {
  getByName(name: string): PurchaseImportDurableObjectRpc;
};

export async function startOrResumeRun(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorAccountId: VendorAccountId;
    trigger: RunTrigger;
    predecessorRunId?: string;
    skillRevision?: string;
    runtimeRevision?: string;
  },
) {
  const trigger = runTrigger.parse(input.trigger);
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.vendorAccountId}))`,
    );
    const [scope] = await tx
      .select({
        id: vendorAccount.id,
        vendorId: vendorAccount.vendorId,
        actorUserId: ledgerParty.userId,
        actorName: user.name,
        actorEmail: user.email,
        actorLedgerPartyShortcode: ledgerParty.shortcode,
        actorLedgerPartyName: ledgerParty.name,
        actorLedgerPartyKind: ledgerParty.kind,
      })
      .from(vendorAccount)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, vendorAccount.ledgerPartyId),
          notDeleted(ledgerParty),
        ),
      )
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(
        and(
          eq(vendorAccount.id, input.vendorAccountId),
          eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
          notDeleted(vendorAccount),
        ),
      )
      .limit(1);
    if (!scope?.actorUserId)
      throw new Error("Vendor account is not owned by an authenticated member");
    const [existing] = await tx
      .select({
        id: runTable.id,
        publicId: runTable.shortcode,
        status: runTable.status,
        dispatchEventId: runTable.dispatchEventId,
      })
      .from(runTable)
      .where(
        and(
          eq(runTable.vendorAccountId, input.vendorAccountId),
          inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (existing) return { ...existing, created: false };
    const id = runEntityId.parse(crypto.randomUUID());
    const dispatchEventId = crypto.randomUUID();
    let created:
      | {
          id: RunId;
          publicId: string;
          status: string;
          dispatchEventId: string | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      [created] = await tx
        .insert(runTable)
        .values({
          id,
          shortcode: generateShortcode("run"),
          ledgerPartyId: input.ledgerPartyId,
          actorUserId: scope.actorUserId,
          actorName: scope.actorName,
          actorEmail: scope.actorEmail,
          actorLedgerPartyShortcode: scope.actorLedgerPartyShortcode,
          actorLedgerPartyName: scope.actorLedgerPartyName,
          actorLedgerPartyKind: scope.actorLedgerPartyKind,
          vendorAccountId: input.vendorAccountId,
          vendorId: scope.vendorId,
          predecessorRunId: input.predecessorRunId
            ? runEntityId.parse(input.predecessorRunId)
            : null,
          trigger,
          coordinatorModel: coordinatorModelFor("account_sync"),
          skillRevision: input.skillRevision ?? "purchase-import@1",
          runtimeRevision: input.runtimeRevision ?? "flue@1",
          agentSessionId: importRunAgentIdentity(id, "account_sync"),
          dispatchEventId,
        })
        .onConflictDoNothing()
        .returning({
          id: runTable.id,
          publicId: runTable.shortcode,
          status: runTable.status,
          dispatchEventId: runTable.dispatchEventId,
        });
    }
    if (!created) throw new Error("Import run was not created");
    await tx
      .update(vendorAccount)
      .set({ status: "active", lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorAccount.id, input.vendorAccountId));
    return { ...created, created: true };
  });
}

/**
 * Creates an explicit validation/enrichment run. Unlike account sync, an
 * occupied account is a refusal, never a silently persisted waiting job.
 */
export async function startTargetedRun(
  db: Database,
  input: StartTargetedRunInput,
) {
  const purpose = runPurpose.parse(input.purpose);
  if (purpose === "account_sync")
    throw new Error("Targeted import runs require a targeted purpose");
  const trigger = runTrigger.parse(input.trigger);
  if (input.targets.length === 0)
    throw new Error("A targeted import run requires at least one target");
  const targetKeys = input.targets.map((target) =>
    target.kind === "purchase"
      ? `purchase:${z.uuid().parse(target.purchaseId)}`
      : `product:${z.uuid().parse(target.productId)}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length)
    throw new Error("A targeted import run cannot contain duplicate targets");

  return withTransaction(db, async (tx) => {
    if (input.vendorAccountId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${input.vendorAccountId}))`,
      );
      const [blockingRun] = await tx
        .select({
          id: runTable.id,
          publicId: runTable.shortcode,
          status: runTable.status,
        })
        .from(runTable)
        .where(
          and(
            eq(runTable.vendorAccountId, input.vendorAccountId),
            inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .limit(1);
      if (blockingRun) return { created: false as const, blockingRun };
    }

    const [actor] = await tx
      .select({
        actorUserId: ledgerParty.userId,
        actorName: user.name,
        actorEmail: user.email,
        actorLedgerPartyShortcode: ledgerParty.shortcode,
        actorLedgerPartyName: ledgerParty.name,
        actorLedgerPartyKind: ledgerParty.kind,
      })
      .from(ledgerParty)
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(
        and(eq(ledgerParty.id, input.ledgerPartyId), notDeleted(ledgerParty)),
      )
      .limit(1);
    if (!actor?.actorUserId)
      throw new Error("Targeted import actor is not available");

    if (input.vendorAccountId) {
      const [account] = await tx
        .select({ id: vendorAccount.id, vendorId: vendorAccount.vendorId })
        .from(vendorAccount)
        .where(
          and(
            eq(vendorAccount.id, input.vendorAccountId),
            eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
            eq(vendorAccount.vendorId, input.vendorId),
            notDeleted(vendorAccount),
          ),
        )
        .limit(1);
      if (!account)
        throw new Error(
          "Vendor account is not owned by this member and vendor",
        );
    }

    const id = runEntityId.parse(crypto.randomUUID());
    const eventId = crypto.randomUUID();
    const [run] = await tx
      .insert(runTable)
      .values({
        id,
        shortcode: generateShortcode("run"),
        ledgerPartyId: input.ledgerPartyId,
        actorUserId: actor.actorUserId,
        actorName: actor.actorName,
        actorEmail: actor.actorEmail,
        actorLedgerPartyShortcode: actor.actorLedgerPartyShortcode,
        actorLedgerPartyName: actor.actorLedgerPartyName,
        actorLedgerPartyKind: actor.actorLedgerPartyKind,
        vendorId: input.vendorId,
        vendorAccountId: input.vendorAccountId ?? null,
        predecessorRunId: input.predecessorRunId
          ? runEntityId.parse(input.predecessorRunId)
          : null,
        purpose,
        trigger,
        dispatchEventId: eventId,
        coordinatorModel: coordinatorModelFor(purpose),
        agentSessionId: importRunAgentIdentity(
          id,
          flueImportRunPurpose.parse(purpose),
        ),
      })
      .returning({
        id: runTable.id,
        publicId: runTable.shortcode,
        status: runTable.status,
        purpose: runTable.purpose,
        dispatchEventId: runTable.dispatchEventId,
      });
    if (!run) throw new Error("Targeted import run was not created");
    await tx.insert(runTarget).values(
      input.targets.map((target) => ({
        runId: id,
        purchaseId:
          target.kind === "purchase"
            ? purchaseId.parse(target.purchaseId)
            : null,
        productId:
          target.kind === "product" ? productId.parse(target.productId) : null,
        vendorAccountId: target.vendorAccountId
          ? vendorAccountId.parse(target.vendorAccountId)
          : (input.vendorAccountId ?? null),
        sourceKind: target.sourceKind ?? null,
        sourceExternalKey: target.sourceExternalKey ?? null,
        state: runTargetState.enum.pending,
        targetFingerprint: target.targetFingerprint,
        evidenceFingerprint: target.evidenceFingerprint ?? null,
      })),
    );
    return { created: true as const, run };
  });
}

export type StartPhotoInventoryRunInput = {
  /** The household member the photos belong to; defaults to the creator's own party. */
  ledgerPartyId?: LedgerPartyId;
  actorUserId: UserId;
  notes?: string;
};

/**
 * A photo-inventory run has no vendor and no upfront targets: the native app
 * bulk-uploads photos into it via `stage`/`finalize`, an agent works the
 * queue afterward. Unlike `startTargetedRun`, the owning `ledgerParty`
 * and the creating actor can differ (a member photographing a shared or
 * another member's belongings), so the actor snapshot is always the
 * *creator's* own identity, resolved independently of the chosen owner.
 */
export async function startPhotoInventoryRun(
  db: Database,
  input: StartPhotoInventoryRunInput,
) {
  return withTransaction(db, async (tx) => {
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
    const [run] = await tx
      .insert(runTable)
      .values({
        id,
        shortcode: generateShortcode("run"),
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
      })
      .returning({
        id: runTable.id,
        publicId: runTable.shortcode,
      });
    if (!run) throw new Error("Photo inventory run was not created");
    return run;
  });
}

/** Arm a photo run only after upload has produced pending targets. */
export async function startPhotoInventoryCoordinator(
  db: Database,
  input: { publicId: string; actorUserId: string },
) {
  const publicId = runShortcode.parse(input.publicId);
  const actorUserId = userId.parse(input.actorUserId);
  const eventId = crypto.randomUUID();
  const [started] = await getDb(db)
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
        sql`EXISTS (SELECT 1 FROM ${runTarget} WHERE ${runTarget.runId} = ${runTable.id} AND ${runTarget.imageId} IS NOT NULL AND ${runTarget.state} = 'pending')`,
      ),
    )
    .returning({ id: runTable.id, publicId: runTable.shortcode });
  if (started) return { ...started, eventId, created: true as const };
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
 * Consumer-side fence: only the active event generation may admit Flue.
 * @lintignore Called through the `PurchaseImportService` RPC namespace in
 * cf-server.ts.
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
 * Read-only consumer fence before Flue admission.
 * @lintignore Called through the `PurchaseImportService` RPC namespace in
 * cf-server.ts.
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
      vendorLabel: vendorAccount.label,
      allowedHosts: vendor.browserDomains,
      navigationHints: vendor.agentHints,
      cursor: vendorAccount.cursor,
      website: vendor.website,
      ledgerPartyId: runTable.ledgerPartyId,
      actorUserId: runTable.actorUserId,
      coordinatorModel: runTable.coordinatorModel,
      skillRevision: runTable.skillRevision,
      runtimeRevision: runTable.runtimeRevision,
      dispatchEventId: runTable.dispatchEventId,
      dispatchAttempts: runTable.dispatchAttempts,
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
      dispatchAttempts: row.dispatchAttempts,
      dispatchError: row.dispatchError,
      coordinatorStartedAt: row.coordinatorStartedAt?.toISOString() ?? null,
    }),
    website: row.website,
    cursor: row.cursor,
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
 * each `stage`d image into an `RunTarget` and activate it, then queue
 * describe/lift processing. Unlike the vendor-scoped run flows this is not
 * owner-fenced (`assertOwnedRun`) — any household member may finalize into a
 * shared photo-inventory run, so `actor` is accepted for parity with sibling
 * mutations but not consulted for authorization.
 */
export async function finalizePhotoRun(
  db: Database,
  input: PhotoImportFinalizeInput,
  _actor: ActorContext,
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

      const inserted = await getDb(transactionDb)
        .insert(runTarget)
        .values(
          lockedStaged.map((entry) => {
            const detail = detailByShortcode.get(entry.row.shortcode);
            return {
              runId: scope.public.runId,
              imageId: imageId.parse(entry.row.id),
              position: detail?.position ?? 0,
              state: runTargetState.enum.pending,
              targetFingerprint: detail?.sha256 ?? entry.integrity.sha256,
            };
          }),
        )
        // Conflicts land on the partial `(runId, imageId)` unique index — a
        // retried chunk re-selecting an already-targeted image is a no-op,
        // not a failure. The bare form matches every constraint on the
        // table, same as `persistLocalImageAnalysis`'s idempotent upsert.
        .onConflictDoNothing()
        .returning({ imageId: runTarget.imageId });
      // SAFETY: widening the branded ImageId to plain string so this set can
      // be probed with ImportImageRow.id (unbranded) below.
      const insertedIds = new Set(inserted.map((row) => row.imageId as string));

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
        .set({ source: "own" })
        .where(and(inArray(image.id, allIds), eq(image.source, "unknown")));

      return {
        finalizedIds: lockedStaged
          .filter((entry) => insertedIds.has(entry.row.id))
          .map((entry) => entry.row.shortcode),
        alreadyFinalizedIds: lockedStaged
          .filter((entry) => !insertedIds.has(entry.row.id))
          .map((entry) => entry.row.shortcode),
      };
    });

  const submission = await createImageProcessingSubmission(db);
  const jobIds: string[] = [];
  for (const shortcode of finalizedIds) {
    const scheduled = await persistImageProcessingSubmission(db, {
      id: shortcode,
      kinds: ["describe_image", "subject_lift"],
      submission: { id: submission.id, publicId: submission.publicId },
    });
    jobIds.push(...scheduled.jobIds);
  }
  await publishImageProcessingWakeups(db, jobIds);

  return {
    finalized: finalizedIds.map((code) => imageShortcode.parse(code)),
    alreadyFinalized: alreadyFinalizedIds.map((code) =>
      imageShortcode.parse(code),
    ),
    submissionId: submission.publicId,
  };
}

const agentProgressInput = z.object({
  runId: z.uuid(),
  eventId: z.string().trim().min(1).max(256),
  phase: z.string().trim().min(1).max(200),
  currentItem: z.string().trim().min(1).max(500).optional(),
  awaitingApproval: z.boolean().optional(),
  detail: z.string().trim().min(1).max(2_000).optional(),
});

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function updateAgentProgress(
  db: Database,
  rawInput: z.input<typeof agentProgressInput>,
) {
  const input = agentProgressInput.parse(rawInput);
  const [inserted] = await getDb(db)
    .insert(runProgress)
    .values({
      runId: input.runId,
      eventId: input.eventId,
      phase: input.phase,
      currentItem: input.currentItem,
      awaitingApproval: input.awaitingApproval ?? false,
      detail: input.detail,
    })
    .onConflictDoNothing()
    .returning({ id: runProgress.id });
  return { recorded: Boolean(inserted) };
}

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
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
        ),
      )
      .returning({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        coordinatorModel: runTable.coordinatorModel,
        eventId: runTable.dispatchEventId,
      });
    const interrupted = await tx
      .select({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        coordinatorModel: runTable.coordinatorModel,
        eventId: runTable.dispatchEventId,
      })
      .from(runTable)
      .where(
        and(
          eq(runTable.actorUserId, owner),
          eq(runTable.status, "running"),
          isNull(runTable.coordinatorStartedAt),
          isNotNull(runTable.dispatchEventId),
          lt(runTable.updatedAt, repairCutoff),
        ),
      );
    return [...resumed, ...interrupted];
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

export async function expireOfflineRuns(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - OFFLINE_EXPIRY_MS);
  const expired = await getDb(db)
    .update(runTable)
    .set({
      status: "failed",
      failureCode: "offline_expired",
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(runTable.status, "paused_offline"),
        lt(runTable.updatedAt, cutoff),
      ),
    )
    .returning({ id: runTable.id });
  return { expired: expired.length };
}

const STALE_RUN_MS = 2 * 60 * 60_000;

/**
 * A run still `running` after its Flue submission settled means the
 * coordinator stopped without a terminal tool call: a `review` progress
 * report, a turn budget, or a model that simply ended its turn. The one
 * legitimate ways to settle while running are a browser command still in
 * flight (its result resumes the conversation) and photo groups awaiting a
 * household review, so those cases are left alone.
 * Approvals never reach here: they move the run to `paused_approval` first.
 */
export async function reconcileSettledRun(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: {
    runId: string;
    operationId: string;
    detail?: string;
    /** Cancel bridge commands nobody answered before this instant. */
    abandonCommandsBefore?: Date;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  if (scope.public.status !== "running")
    return { reconciled: false as const, status: scope.public.status };
  if (scope.public.purpose === "photo_inventory") {
    const awaitingPhotoReview = await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select({ status: runTable.status })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .for("update");
      if (locked?.status !== "running") return false;
      const [proposal] = await tx
        .select({ id: photoGroupProposal.id })
        .from(photoGroupProposal)
        .where(
          and(
            eq(photoGroupProposal.runId, scope.public.runId),
            eq(photoGroupProposal.state, "proposed"),
          ),
        )
        .limit(1);
      if (!proposal) return false;
      const [progress] = await tx
        .select({ awaitingApproval: runProgress.awaitingApproval })
        .from(runProgress)
        .where(eq(runProgress.runId, scope.public.runId))
        .orderBy(desc(runProgress.createdAt), desc(runProgress.id))
        .limit(1);
      if (!progress?.awaitingApproval) {
        // A saved proposal is durable human work even when the coordinator
        // stops before reporting its final phase. Preserve pending targets.
        await tx
          .insert(runProgress)
          .values({
            runId: scope.public.runId,
            eventId: `photo-review-handoff:${scope.public.runId}`,
            phase: "awaiting_approval",
            currentItem: "Review proposed photo groups",
            awaitingApproval: true,
            detail: "Photo groups are ready for human review",
          })
          .onConflictDoNothing();
      }
      return true;
    });
    if (awaitingPhotoReview)
      return { reconciled: false as const, status: "running" as const };
  }
  if (scope.public.vendorAccountId) {
    const broker = namespace.getByName(scope.public.vendorAccountId);
    const pending = await broker.pendingCommands(scope.public.runId);
    const cutoff = input.abandonCommandsBefore?.getTime();
    const live = pending.filter(
      (command) => cutoff === undefined || command.createdAt >= cutoff,
    );
    if (live.length > 0)
      return { reconciled: false as const, status: "running" as const };
    // A command the Mac never answered within the stale window is not work
    // in flight; it is the reason the run stalled. Its 25-hour deadline is
    // the bridge's replay bound, not a promise anyone is still keeping.
    for (const command of pending) await broker.cancel(command.requestId);
  }
  await stopRunForReview(db, {
    runId: input.runId,
    operationId: input.operationId,
    kind: "other",
    summary: input.detail ?? "Coordinator ended without finishing the run",
  });
  return { reconciled: true as const, status: "needs_review" as const };
}

/**
 * Cron backstop for the reconcile above: a settled event can be lost, and a
 * coordinator can stall inside a submission. Activity is the newest of the
 * run row, its operations and its progress reports so a slow but live agent
 * is not cut off.
 */
export async function expireStaleRuns(
  db: Database,
  namespace: PurchaseImportNamespace,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(
      and(
        eq(runTable.status, "running"),
        lt(runTable.updatedAt, cutoff),
        // Unstarted photo runs may sit between native upload sessions. Once
        // dispatched, they get the same stalled-coordinator backstop; review
        // proposals are preserved by reconcileSettledRun.
        or(
          ne(runTable.purpose, runPurpose.enum.photo_inventory),
          isNotNull(runTable.coordinatorStartedAt),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${runOperation} WHERE ${runOperation.runId} = ${runTable.id} AND ${runOperation.startedAt} >= ${cutoff})`,
        sql`NOT EXISTS (SELECT 1 FROM ${runProgress} WHERE ${runProgress.runId} = ${runTable.id} AND ${runProgress.createdAt} >= ${cutoff})`,
      ),
    );
  let expired = 0;
  const failures: Array<{ runId: string; error: string }> = [];
  for (const run of stale) {
    // One run's review path can fail on a provider call (the required audit
    // pass); that must not abort the tick for every other run or the offline
    // expiry that shares it. The next tick retries.
    try {
      const outcome = await reconcileSettledRun(db, namespace, {
        runId: run.id,
        operationId: `stale-run:${now.toISOString()}`,
        detail: "No coordinator activity for two hours",
        abandonCommandsBefore: cutoff,
      });
      if (outcome.reconciled) expired += 1;
    } catch (error) {
      failures.push({
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { expired, failures };
}

const assertRunActive = (status: string) => {
  if (status !== "running")
    throw new Error(`Import run is fenced in status ${status}`);
};

async function settleAllocatedBrowserHunt(
  db: Database,
  accountId: VendorAccountId,
): Promise<void> {
  const [queuedHunt] = await getDb(db)
    .select({
      id: importHunt.id,
      transactionId: importHunt.financialTransactionId,
    })
    .from(importHunt)
    .where(
      and(
        eq(importHunt.vendorAccountId, accountId),
        eq(importHunt.state, "browser_queued"),
      ),
    )
    .orderBy(asc(importHunt.updatedAt))
    .limit(1);
  if (!queuedHunt) return;
  const [allocation] = await getDb(db)
    .select({ id: financialTransactionAllocation.id })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(
          financialTransactionAllocation.transactionId,
          queuedHunt.transactionId,
        ),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .limit(1);
  if (!allocation) return;
  await getDb(db)
    .update(importHunt)
    .set({ state: "resolved", updatedAt: new Date() })
    .where(eq(importHunt.id, queuedHunt.id));
}

// eslint-disable-next-line complexity -- Purpose-specific work selection is an explicit authority boundary.
export async function claimNextImportWork(
  db: Database,
  namespace: PurchaseImportNamespace,
  runId: string,
) {
  const scope = await loadRunScope(db, runId);
  const receipt = await loadReceiptEvidenceForRun(db, scope.public.runId);
  if (receipt) {
    assertRunActive(scope.public.status);
    return {
      kind: "receipt_evidence" as const,
      huntId: receipt.huntId,
      imageId: receipt.imageId,
      evidenceChecksum: receipt.evidenceChecksum,
    };
  }
  if (scope.public.status === "paused_approval")
    return { kind: "paused_approval" as const };
  if (
    scope.public.status === "paused_auth" ||
    scope.public.status === "paused_offline"
  ) {
    if (!scope.public.vendorAccountId)
      return scope.public.status === "paused_auth"
        ? { kind: "paused_auth" as const }
        : { kind: "paused_offline" as const };
    const connected = await namespace
      .getByName(scope.public.vendorAccountId)
      .connected();
    if (!connected) {
      if (
        scope.public.status === "paused_offline" &&
        Date.now() - scope.runUpdatedAt.getTime() >= OFFLINE_EXPIRY_MS
      ) {
        await getDb(db)
          .update(runTable)
          .set({
            status: "failed",
            failureCode: "offline_expired",
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runTable.id, scope.public.runId),
              eq(runTable.status, "paused_offline"),
            ),
          );
        return { kind: "failed" as const, failureCode: "offline_expired" };
      }
      return { kind: "paused_offline" as const };
    }
    await getDb(db)
      .update(runTable)
      .set({ status: "running", failureCode: null, updatedAt: new Date() })
      .where(eq(runTable.id, scope.public.runId));
  } else {
    assertRunActive(scope.public.status);
  }
  if (scope.public.purpose === "purchase_validation") {
    const [target] = await getDb(db)
      .select({
        targetId: runTarget.id,
        purchaseId: purchase.shortcode,
        orderId: purchase.orderId,
        sourceKind: runTarget.sourceKind,
        sourceExternalKey: runTarget.sourceExternalKey,
        state: runTarget.state,
      })
      .from(runTarget)
      .innerJoin(
        purchase,
        and(eq(purchase.id, runTarget.purchaseId), notDeleted(purchase)),
      )
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
        ),
      )
      .orderBy(asc(runTarget.createdAt))
      .limit(1);
    if (target) {
      const [evidence] = await getDb(db)
        .select({ id: runEvidence.id })
        .from(runEvidence)
        .where(
          and(
            eq(runEvidence.runId, scope.public.runId),
            eq(runEvidence.targetId, target.targetId),
          ),
        )
        .limit(1);
      return {
        kind: "purchase_validation" as const,
        ...target,
        hasBrowserAccount: Boolean(scope.public.vendorAccountId),
        hasRunEvidence: Boolean(evidence),
      };
    }
    return { kind: "none" as const };
  }
  if (scope.public.purpose === "product_enrichment") {
    const [target] = await getDb(db)
      .select({
        targetId: runTarget.id,
        productId: product.shortcode,
        productName: product.name,
        targetFingerprint: runTarget.targetFingerprint,
        startUrl: runTarget.sourceExternalKey,
      })
      .from(runTarget)
      .innerJoin(
        product,
        and(eq(product.id, runTarget.productId), notDeleted(product)),
      )
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          inArray(runTarget.state, ["pending", "prepared"]),
        ),
      )
      .orderBy(asc(runTarget.createdAt))
      .limit(1);
    if (!target) return { kind: "none" as const };
    const evidence = await getDb(db)
      .select({
        id: runEvidence.id,
        kind: runEvidence.kind,
        checksum: runEvidence.checksum,
        mediaType: runEvidence.mediaType,
        sourceMetadata: runEvidence.sourceMetadata,
      })
      .from(runEvidence)
      .where(eq(runEvidence.targetId, target.targetId))
      .orderBy(desc(runEvidence.createdAt));
    return {
      kind: "product_enrichment" as const,
      ...target,
      evidence,
      hasBrowserAccount: Boolean(scope.public.vendorAccountId),
    };
  }
  // A photo-inventory run is vendor-less by construction; it must never fall
  // through to the account-sync branch below.
  if (scope.public.purpose === "photo_inventory") {
    const [run] = await getDb(db)
      .select({ notes: runTable.notes })
      .from(runTable)
      .where(eq(runTable.id, scope.public.runId))
      .limit(1);
    const [pending] = await getDb(db)
      .select({ count: count() })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          isNotNull(runTarget.imageId),
          eq(runTarget.state, "pending"),
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
  if (!scope.public.vendorAccountId || !scope.vendorId)
    return { kind: "none" as const };
  const [hunt] = await getDb(db)
    .select({
      id: importHunt.id,
      orderIds: importHunt.matchedOrderIds,
      amount: financialTransaction.amount,
      dateFrom: importHunt.dateFrom,
      dateTo: importHunt.dateTo,
    })
    .from(importHunt)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, importHunt.financialTransactionId),
    )
    .where(
      and(
        eq(importHunt.vendorAccountId, scope.public.vendorAccountId),
        eq(importHunt.state, "browser_queued"),
      ),
    )
    .orderBy(asc(importHunt.updatedAt))
    .limit(1);
  const hints = vendorAgentHints.parse(scope.public.navigationHints);
  const startUrl = hints.ordersListUrl ?? scope.website;
  if (hunt && startUrl) return { kind: "hunt" as const, startUrl, ...hunt };
  // Listed orders come before enrichment and before walking further pages:
  // the worklist is what a listing produced, and finishing while one is
  // pending is refused.
  const [order] = await getDb(db)
    .select({
      orderId: runOrderCandidate.orderId,
      orderUrl: runOrderCandidate.orderUrl,
      orderedAt: runOrderCandidate.orderedAt,
    })
    .from(runOrderCandidate)
    .where(
      and(
        eq(runOrderCandidate.runId, scope.public.runId),
        eq(runOrderCandidate.state, "pending"),
      ),
    )
    .orderBy(desc(runOrderCandidate.orderedAt), asc(runOrderCandidate.listedAt))
    .limit(1);
  if (order) return { kind: "order" as const, ...order };
  const enrichment = await getDb(db)
    .selectDistinct({
      productId: product.id,
      productName: product.name,
      startUrl: productExternalId.url,
    })
    .from(runMutation)
    .innerJoin(
      product,
      and(eq(product.id, runMutation.targetId), notDeleted(product)),
    )
    .innerJoin(
      productExternalId,
      and(
        eq(productExternalId.productId, product.id),
        isNotNull(productExternalId.url),
        notDeleted(productExternalId),
      ),
    )
    .leftJoin(
      entityAttachment,
      and(
        eq(entityAttachment.subjectEntityId, product.id),
        notDeleted(entityAttachment),
      ),
    )
    .where(
      and(
        eq(runMutation.runId, scope.public.runId),
        eq(runMutation.targetType, "product"),
        isNull(entityAttachment.id),
      ),
    )
    .limit(1);
  if (enrichment[0]?.startUrl)
    return { kind: "product_enrichment" as const, ...enrichment[0] };
  const [scanFinished] = await getDb(db)
    .select({ id: runOperation.id })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.public.runId),
        eq(runOperation.kind, "mark_history_expired"),
        eq(runOperation.state, "completed"),
      ),
    )
    .limit(1);
  if (scanFinished) return { kind: "none" as const };
  const [history] = await getDb(db)
    .select({
      cursorUrl: runTable.historyCursorUrl,
      exhaustedAt: runTable.historyExhaustedAt,
    })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .limit(1);
  if (history?.exhaustedAt) return { kind: "none" as const };
  const walkFrom = history?.cursorUrl ?? startUrl;
  return walkFrom
    ? { kind: "cursor_walk" as const, startUrl: walkFrom }
    : { kind: "none" as const };
}

/**
 * Record an order-history page as worklist rows. An order the vendor already
 * has a Purchase for is `covered`; the rest are `pending`. `ordersSeen` counts
 * the listing, not commits — the agent's "95 on the page, 12 imported" gap was
 * invisible while the writer owned that counter.
 */
async function recordOrderListing(
  db: Database,
  input: {
    runId: RunId;
    vendorId: VendorId;
    orders: ReadonlyArray<{
      orderId: string;
      orderUrl: string | null;
      orderedAt: string | null;
    }>;
  },
) {
  if (input.orders.length > 0) {
    const covered = new Set(
      (
        await getDb(db)
          .select({ orderId: purchase.orderId })
          .from(purchase)
          .where(
            and(
              eq(purchase.vendorId, input.vendorId),
              inArray(
                purchase.orderId,
                input.orders.map((order) => order.orderId),
              ),
              notDeleted(purchase),
            ),
          )
      ).map((row) => row.orderId),
    );
    await getDb(db)
      .insert(runOrderCandidate)
      .values(
        input.orders.map((order) => ({
          runId: input.runId,
          orderId: order.orderId,
          orderUrl: order.orderUrl,
          orderedAt: order.orderedAt,
          state: covered.has(order.orderId) ? "covered" : "pending",
        })),
      )
      .onConflictDoNothing();
  }
  const [seen] = await getDb(db)
    .select({ value: count() })
    .from(runOrderCandidate)
    .where(eq(runOrderCandidate.runId, input.runId));
  await getDb(db)
    .update(runTable)
    .set({ ordersSeen: seen?.value ?? 0, updatedAt: new Date() })
    .where(eq(runTable.id, input.runId));
  return seen?.value ?? 0;
}

// eslint-disable-next-line complexity -- Browser commands are fenced by purpose, target, and allowlisted operation type here.
export async function issueBrowserCommand(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: {
    runId: string;
    operationId: string;
    operation: BrowserBridgeOperation;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (!scope.public.vendorAccountId)
    throw new Error("This import run has no browser account");
  const operation = browserBridgeOperation.parse(input.operation);
  const allowedHosts = scope.public.allowedHosts;
  const [captureTarget] =
    operation.type === "capture" && scope.public.purpose !== "account_sync"
      ? await getDb(db)
          .select({ id: runTarget.id })
          .from(runTarget)
          .where(
            and(
              eq(runTarget.runId, runEntityId.parse(input.runId)),
              inArray(runTarget.state, [
                "pending",
                "prepared",
                "needs_evidence",
              ]),
            ),
          )
          .orderBy(asc(runTarget.createdAt))
          .limit(1)
      : [];
  if (
    operation.type === "capture" &&
    scope.public.purpose !== "account_sync" &&
    !captureTarget
  )
    throw new Error("Targeted browser capture has no eligible explicit target");
  const scopedOperation =
    operation.type === "navigate"
      ? { ...operation, allowedHosts }
      : operation.type === "follow_captured_link"
        ? { ...operation, allowedHosts }
        : operation.type === "capture"
          ? {
              ...operation,
              allowedHosts,
              evidenceScope: captureTarget
                ? {
                    runId: scope.public.shortcode,
                    targetId: captureTarget.id,
                  }
                : undefined,
            }
          : operation;
  const boundedNavigationURL =
    scopedOperation.type === "navigate"
      ? scopedOperation.url
      : scopedOperation.type === "capture"
        ? scopedOperation.recoveryURL
        : undefined;
  if (boundedNavigationURL) {
    const host = new URL(boundedNavigationURL).hostname.toLowerCase();
    if (!allowedHosts.includes(host))
      throw new Error("Navigation URL is outside the vendor allowlist");
  }
  const commandId = await operationUuid(input.runId, input.operationId);
  const fingerprint = await sha256Hex(
    JSON.stringify({
      protocolVersion: 2,
      id: commandId,
      operationId: input.operationId,
      runID: input.runId,
      operation: scopedOperation,
    }),
  );
  const database = getDb(db);
  const [recorded] = await database
    .select({
      inputFingerprint: runOperation.inputFingerprint,
      result: runOperation.result,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(input.runId)),
        eq(runOperation.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (
    recorded?.inputFingerprint !== undefined &&
    recorded.inputFingerprint !== fingerprint
  )
    throw new Error("Operation id was replayed with different input");
  const command = recorded
    ? browserBridgeRequest.parse(
        z.object({ command: browserBridgeRequest }).parse(recorded.result)
          .command,
      )
    : browserBridgeRequest.parse({
        protocolVersion: 2,
        id: commandId,
        operationId: input.operationId,
        runID: input.runId,
        // The web-owned offline detector fires at 24 hours. Keep a queued
        // command valid slightly beyond that window so reconnect can replay it.
        deadline: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
        operation: scopedOperation,
      });
  if (!recorded) {
    await database.insert(runOperation).values({
      runId: runEntityId.parse(input.runId),
      operationId: input.operationId,
      kind: "browser_command",
      inputFingerprint: fingerprint,
      result: { command, commandId },
    });
  }
  const broker = namespace.getByName(scope.public.vendorAccountId);
  const connected = await broker.connected();
  await broker.enqueue(command);
  if (!connected) {
    await Promise.all([
      database
        .update(runTable)
        .set({ status: "paused_offline", updatedAt: new Date() })
        .where(eq(runTable.id, runEntityId.parse(input.runId))),
      database
        .update(vendorAccount)
        .set({ status: "paused_offline", updatedAt: new Date() })
        .where(
          eq(
            vendorAccount.id,
            vendorAccountId.parse(scope.public.vendorAccountId),
          ),
        ),
    ]);
  }
  await database
    .update(runOperation)
    .set({
      state: "completed",
      result: { command, commandId },
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(input.runId)),
        eq(runOperation.operationId, input.operationId),
      ),
    );
  return { commandId, state: connected ? "dispatched" : "paused_offline" };
}

export async function readBrowserCommandResult(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: { runId: string; operationId: string },
) {
  const scope = await loadRunScope(db, input.runId);
  if (!scope.public.vendorAccountId)
    throw new Error("This import run has no browser account");
  const [row] = await getDb(db)
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(input.runId)),
        eq(runOperation.operationId, input.operationId),
      ),
    )
    .limit(1);
  const parsed = z
    .object({ commandId: z.uuid(), command: browserBridgeRequest })
    .safeParse(row?.result);
  if (!parsed.success) return { state: "missing" as const };
  const result = await namespace
    .getByName(scope.public.vendorAccountId)
    .result(parsed.data.commandId);
  if (result?.outcome.status === "failed") {
    const authRequired = result.outcome.code === "authentication_required";
    const paused =
      authRequired ||
      result.outcome.retryable ||
      result.outcome.code === "deadline_exceeded" ||
      result.outcome.code === "browser_unavailable";
    if (paused) {
      await getDb(db)
        .update(runTable)
        .set({
          status: authRequired ? "paused_auth" : "paused_offline",
          failureCode: result.outcome.code,
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.public.runId));
      await getDb(db)
        .update(vendorAccount)
        .set({
          status: authRequired ? "paused_auth" : "paused_offline",
          updatedAt: new Date(),
        })
        .where(
          eq(
            vendorAccount.id,
            vendorAccountId.parse(scope.public.vendorAccountId),
          ),
        );
      if (authRequired) {
        await namespace
          .getByName(scope.public.vendorAccountId)
          .requestAuthentication(scope.public.runId);
      }
      return {
        state: authRequired
          ? ("paused_auth" as const)
          : ("paused_offline" as const),
        result,
      };
    }
    // A non-pausing failure (bad link, disallowed URL, capture unavailable,
    // upload failed) is the command's terminal outcome. The agent sees it in
    // the tool result; the operation row is where Activity and the transcript
    // read it from.
    await getDb(db)
      .update(runOperation)
      .set({
        state: "failed",
        error: `${result.outcome.code}: ${result.outcome.message}`.slice(
          0,
          2_000,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, scope.public.runId),
          eq(runOperation.operationId, input.operationId),
        ),
      );
  }
  return result
    ? { state: "completed" as const, result }
    : { state: "pending" as const, commandId: parsed.data.commandId };
}

// eslint-disable-next-line complexity -- Evidence import validates every browser and target provenance branch at this boundary.
export async function importBrowserOrderEvidence(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: { runId: string; operationId: string; commandId: string },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (!scope.public.vendorAccountId || !scope.vendorId || !scope.actorUserId)
    throw new Error("Import run ownership is incomplete");
  const commandId = z.uuid().parse(input.commandId);
  const commandOperations = await getDb(db)
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(input.runId)),
        eq(runOperation.kind, "browser_command"),
      ),
    );
  const commandRecord = commandOperations
    .map(({ result }) =>
      z
        .object({
          commandId: z.uuid(),
          command: browserBridgeRequest,
        })
        .safeParse(result),
    )
    .find((parsed) => parsed.success && parsed.data.commandId === commandId);
  if (!commandRecord?.success)
    throw new Error(
      "Browser evidence command was not issued by this import run",
    );
  const result = await namespace
    .getByName(scope.public.vendorAccountId)
    .result(commandId);
  if (result?.runID !== input.runId)
    throw new Error("Browser evidence belongs to a different import run");
  if (
    !result ||
    result.outcome.status !== "completed" ||
    !result.outcome.capture
  )
    throw new Error("Browser evidence is not complete");
  const capture = result.outcome.capture;
  if (scope.public.purpose !== "account_sync") {
    const evidenceScope =
      commandRecord.data.command.operation.type === "capture"
        ? commandRecord.data.command.operation.evidenceScope
        : undefined;
    if (!evidenceScope || evidenceScope.runId !== scope.public.shortcode)
      throw new Error(
        "Browser command has no matching targeted evidence scope",
      );
    const [target] = await getDb(db)
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, runEntityId.parse(input.runId)),
          eq(runTarget.id, evidenceScope.targetId),
        ),
      )
      .limit(1);
    if (!target)
      throw new Error(
        "Browser evidence does not match a targeted import source",
      );
    const evidenceIds = capture.evidence.flatMap((reference) => {
      const parsed = z.uuid().safeParse(reference.id);
      return parsed.success ? [parsed.data] : [];
    });
    if (evidenceIds.length === 0)
      throw new Error("Targeted browser capture retained no run evidence");
    await getDb(db)
      .update(runEvidence)
      .set({
        sourceMetadata: {
          canonicalUrl: capture.canonicalUrl ?? null,
          requestedAmazonAsin: capture.requestedAmazonAsin ?? null,
          servedAmazonAsin: capture.servedAmazonAsin ?? null,
          variantMarkers: capture.variantMarkers,
          images: capture.images.map((image) => ({
            url: image.url,
            naturalWidth: image.naturalWidth ?? null,
            naturalHeight: image.naturalHeight ?? null,
            highResolutionUrl: image.highResolutionUrl ?? null,
          })),
        },
      })
      .where(
        and(
          inArray(runEvidence.id, evidenceIds),
          eq(runEvidence.runId, runEntityId.parse(input.runId)),
          eq(runEvidence.targetId, target.id),
          eq(runEvidence.kind, "browser_capture"),
        ),
      );
    // Capturing is operational state only. Targeted validation deliberately
    // never enters the import writer, and enrichment waits for its bounded,
    // typed commit rather than attaching the first image the browser found.
    await getDb(db)
      .update(runTarget)
      .set({
        state: "prepared",
        outcome:
          scope.public.purpose === "purchase_validation"
            ? "semantic_drift"
            : null,
        warning:
          "Browser evidence captured; awaiting the purpose-specific comparison or bounded enrichment commit.",
        updatedAt: new Date(),
      })
      .where(eq(runTarget.id, target.id));
    return {
      kind: "targeted_evidence" as const,
      targetId: target.id,
    };
  }
  const captureInput = browserCapture.parse({
    url: capture.sourceURL,
    title: capture.title,
    text: capture.readableText,
    links: capture.links.map((link) => ({
      id: link.id,
      href: link.url,
      text: link.label ?? "",
    })),
    images: capture.images.map((image) => ({
      src: image.url,
      alt: image.alt ?? "",
    })),
    capturedAt: capture.capturedAt,
  });
  const classified = classifyOrderCapture(captureInput, {
    allowedHosts: scope.public.allowedHosts,
  });
  if (classified.kind === "order_list") {
    // A page listing orders is a worklist, never an order: the single-order
    // extractor read one as "unreadable" and the writer then refused it.
    const cursor = scope.public.vendorAccountId
      ? vendorAccountCursor.parse(
          (
            await getDb(db)
              .select({ cursor: vendorAccount.cursor })
              .from(vendorAccount)
              .where(
                eq(
                  vendorAccount.id,
                  vendorAccountId.parse(scope.public.vendorAccountId),
                ),
              )
              .limit(1)
          )[0]?.cursor,
        )
      : null;
    const newestKnown = cursor?.newestOrderAt?.slice(0, 10) ?? null;
    // Stop paging once a whole page predates the account cursor: everything
    // older was covered by an earlier run.
    const reachedCursor =
      newestKnown !== null &&
      classified.orders.length > 0 &&
      classified.orders.every(
        (order) => order.orderedAt !== null && order.orderedAt < newestKnown,
      );
    const seen = await recordOrderListing(db, {
      runId: runEntityId.parse(input.runId),
      vendorId: scope.vendorId,
      orders: classified.orders,
    });
    const pending = await getDb(db)
      .select({ value: count() })
      .from(runOrderCandidate)
      .where(
        and(
          eq(runOrderCandidate.runId, runEntityId.parse(input.runId)),
          eq(runOrderCandidate.state, "pending"),
        ),
      );
    const nextPageUrl = reachedCursor ? null : classified.nextPageUrl;
    await getDb(db)
      .update(runTable)
      .set({
        historyCursorUrl: nextPageUrl,
        historyExhaustedAt: nextPageUrl ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runTable.id, runEntityId.parse(input.runId)));
    return {
      kind: "order_list" as const,
      orders: classified.orders,
      ordersSeen: seen,
      pending: pending[0]?.value ?? 0,
      nextPageUrl,
    };
  }
  const screenshot = capture.evidence.find(
    (item) => item.kind === "screenshot",
  );
  const primary = capture.evidence.find(
    (item) => item.kind === "rendered_pdf" || item.kind === "normalized_pdf",
  );
  const [{ extractPurchaseCapture }, { resolveOrThrow }] = await Promise.all([
    import("~/server/agents/purchase-import/extract"),
    import("~/server/repo/shortcode-resolver"),
  ]);
  const extraction = await extractPurchaseCapture({
    db,
    runId: input.runId,
    capture: captureInput,
    screenshotImageId: screenshot?.id,
  });
  if (extraction.status === "unreadable" && !extraction.candidate) {
    // Nothing typed to write; the writer would only throw. The agent gets the
    // extractor's reason and decides between another capture and review.
    return {
      kind: "unreadable" as const,
      detail: extraction.detail,
      classification: classified.kind,
    };
  }
  const stableEvidence = {
    sourceURL: capture.sourceURL,
    title: capture.title,
    readableText: capture.readableText,
    links: capture.links.map(({ url, label }) => ({ url, label })),
    images: capture.images.map(({ url, alt }) => ({ url, alt })),
  };
  const checksum = await sha256Hex(JSON.stringify(stableEvidence));
  const writeResult = await importVendorOrder(
    db,
    {
      runId: runEntityId.parse(input.runId),
      ledgerPartyId: scope.ledgerPartyId,
      vendorId: scope.vendorId,
      vendorAccountId: scope.public.vendorAccountId,
      source: {
        kind: "browser_order",
        externalKey: capture.sourceURL,
        checksum,
      },
      extraction,
      primaryDocumentImageId: primary
        ? await resolveOrThrow(db, "image", primary.id)
        : null,
      screenshotImageId: screenshot
        ? await resolveOrThrow(db, "image", screenshot.id)
        : null,
    },
    scope.actorUserId,
  );
  if (writeResult.purchaseId && extraction.candidate?.orderId) {
    const [written] = await getDb(db)
      .select({ shortcode: purchase.shortcode })
      .from(purchase)
      .where(eq(purchase.id, purchaseId.parse(writeResult.purchaseId)))
      .limit(1);
    if (written) {
      await attachPendingOrderMailEvidence(db, {
        ledgerPartyId: scope.ledgerPartyId,
        vendorId: scope.vendorId,
        orderId: extraction.candidate.orderId,
        purchaseShortcode: written.shortcode,
      });
    }
  }
  if (extraction.candidate?.orderId) {
    await getDb(db)
      .update(runOrderCandidate)
      .set({ state: "imported", updatedAt: new Date() })
      .where(
        and(
          eq(runOrderCandidate.runId, runEntityId.parse(input.runId)),
          eq(runOrderCandidate.orderId, extraction.candidate.orderId),
          eq(runOrderCandidate.state, "pending"),
        ),
      );
  }
  await settleAllocatedBrowserHunt(
    db,
    vendorAccountId.parse(scope.public.vendorAccountId),
  );
  return { extraction, writeResult };
}

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function saveNavigationHints(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    patch: unknown;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (scope.public.purpose !== "account_sync")
    throw new Error(
      "Targeted import runs cannot change shared navigation hints",
    );
  if (!scope.vendorId) throw new Error("Import run has no vendor");
  const patch = vendorAgentHints.partial().parse(input.patch);
  if (patch.ordersListUrl) {
    const host = new URL(patch.ordersListUrl).hostname.toLowerCase();
    if (!scope.public.allowedHosts.includes(host))
      throw new Error("Navigation hints cannot expand browser authority");
  }
  const current = vendorAgentHints.parse(scope.public.navigationHints);
  const next = vendorAgentHints.parse({ ...current, ...patch });
  await getDb(db)
    .update(vendor)
    .set({ agentHints: next, updatedAt: new Date() })
    .where(eq(vendor.id, scope.vendorId));
  return next;
}

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function markHistoryExpired(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    earliestAvailableOrderAt: string;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (scope.public.purpose !== "account_sync")
    throw new Error("Targeted import runs cannot change account history state");
  if (!scope.public.vendorAccountId || !scope.actorUserId)
    throw new Error("Import run ownership is incomplete");
  const earliest = z.iso.datetime().parse(input.earliestAvailableOrderAt);
  const [account] = await getDb(db)
    .select({ cursor: vendorAccount.cursor })
    .from(vendorAccount)
    .where(
      eq(vendorAccount.id, vendorAccountId.parse(scope.public.vendorAccountId)),
    )
    .limit(1);
  const cursor = vendorAccountCursor.parse(account?.cursor);
  await getDb(db)
    .update(vendorAccount)
    .set({
      cursor: { ...cursor, earliestAvailableOrderAt: earliest },
      updatedAt: new Date(),
    })
    .where(
      eq(vendorAccount.id, vendorAccountId.parse(scope.public.vendorAccountId)),
    );

  const rows = await getDb(db)
    .select({ shortcode: purchase.shortcode })
    .from(purchase)
    .where(
      and(
        eq(
          purchase.vendorAccountId,
          vendorAccountId.parse(scope.public.vendorAccountId),
        ),
        sql`${purchase.date} < ${earliest.slice(0, 10)}`,
        notDeleted(purchase),
      ),
    );
  const { setDataException } = await import("~/server/repo/data-quality");
  const actor = buildActorContext(scope.actorUserId, "mcp", {
    runId: runEntityId.parse(input.runId),
  });
  let marked = 0;
  for (const row of rows) {
    for (const check of ["primary_document", "empty_expenses"] as const) {
      try {
        await setDataException(
          db,
          {
            entityId: row.shortcode,
            check,
            reason: "history_expired",
            note: `Vendor history begins ${earliest.slice(0, 10)}.`,
          },
          actor,
        );
        marked += 1;
      } catch (error) {
        if (
          !(error instanceof Error && error.message.includes("not an active"))
        )
          throw error;
      }
    }
  }
  return { marked };
}

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function auditImportBatch(
  db: Database,
  input: { runId: string; operationId: string; offset: number },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (!scope.actorUserId) throw new Error("Import run actor is unavailable");
  const runId = runEntityId.parse(input.runId);
  const renderedBatch = await loadPurchaseAuditBatch(
    db,
    runId,
    z.number().int().nonnegative().parse(input.offset),
  );
  if (renderedBatch.length === 0) return { findings: 0, nextOffset: null };
  const purchaseIds = renderedBatch.map(({ id }) => id);
  const { auditPurchaseImportBatch } =
    await import("~/server/agents/purchase-import/extract");
  const audit = await auditPurchaseImportBatch({
    db,
    runId: input.runId,
    renderedBatch,
  });
  const actor = buildActorContext(scope.actorUserId, "mcp", {
    runId: runEntityId.parse(input.runId),
  });
  const batchExpenseIds = new Set(
    renderedBatch.flatMap((purchaseRow) =>
      purchaseRow.expenses.map((expenseRow) => expenseRow.id),
    ),
  );
  let stored = 0;
  for (const finding of audit.findings) {
    if (!purchaseIds.includes(purchaseId.parse(finding.targetPurchaseId)))
      continue;
    const relinkExpenseId =
      finding.proposedFix?.kind === "relink_product"
        ? finding.proposedFix.expenseId
        : null;
    if (
      relinkExpenseId &&
      !batchExpenseIds.has(parseEntityId("expense", relinkExpenseId))
    )
      continue;
    const evidenceFingerprint = await sha256Hex(JSON.stringify(finding));
    const [inserted] = await getDb(db)
      .insert(runFinding)
      .values({
        runId: runId,
        ledgerPartyId: scope.ledgerPartyId,
        targetType: relinkExpenseId ? "expense" : "purchase",
        targetId: relinkExpenseId ?? finding.targetPurchaseId,
        kind: finding.kind,
        summary: finding.summary,
        proposedFix: finding.proposedFix,
        evidenceFingerprint,
        probability: finding.probability,
      })
      .onConflictDoNothing()
      .returning({ id: runFinding.id });
    if (!inserted) continue;
    stored += 1;
    if (
      finding.probability >= 0.95 &&
      finding.proposedFix?.kind === "relink_product"
    ) {
      try {
        await resolveRunFinding(
          db,
          { id: inserted.id, action: "apply" },
          actor,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Automated fix was refused";
        await getDb(db)
          .update(runFinding)
          .set({
            summary: `${finding.summary} Auto-fix refused: ${detail}`.slice(
              0,
              1_000,
            ),
            proposedFix: null,
            updatedAt: new Date(),
          })
          .where(eq(runFinding.id, inserted.id));
      }
    }
  }
  return {
    findings: stored,
    nextOffset: renderedBatch.length === 25 ? input.offset + 25 : null,
  };
}

/** Server-side finalization guard: every run mutation is audited in pages of 25. */
export async function auditAllImportBatches(
  db: Database,
  input: { runId: string; operationId: string },
) {
  let offset = 0;
  let findings = 0;
  while (true) {
    const page = await auditImportBatch(db, {
      ...input,
      operationId: `${input.operationId}:${offset}`,
      offset,
    });
    findings += page.findings;
    if (page.nextOffset === null) return { findings };
    offset = page.nextOffset;
  }
}

export async function stopRunForReview(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    summary: string;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  const runId = runEntityId.parse(input.runId);
  const summary = z.string().trim().min(1).max(1_000).parse(input.summary);
  const kind = z
    .enum([
      "auth_required",
      "expected_order_not_found",
      "unclassified_vendor",
      "other",
    ])
    .parse(input.kind);
  const fingerprint = await sha256Hex(`${kind}:${summary}`);
  if (scope.public.purpose === "account_sync") {
    await auditAllImportBatches(db, {
      runId: input.runId,
      operationId: `${input.operationId}:required-audit`,
    });
  }
  const auditedAt = new Date();
  return withTransaction(db, async (tx) => {
    if (scope.public.status !== "needs_review")
      assertRunActive(scope.public.status);
    const [finding] = await tx
      .insert(runFinding)
      .values({
        runId: runId,
        ledgerPartyId: scope.ledgerPartyId,
        targetType: "run",
        targetId: runId,
        kind,
        summary,
        evidenceFingerprint: fingerprint,
      })
      .onConflictDoNothing()
      .returning({ id: runFinding.id });
    const [existingFinding] = finding
      ? []
      : await tx
          .select({ id: runFinding.id })
          .from(runFinding)
          .where(
            and(
              eq(runFinding.runId, runId),
              eq(runFinding.targetType, "run"),
              eq(runFinding.targetId, runId),
              eq(runFinding.kind, kind),
              eq(runFinding.evidenceFingerprint, fingerprint),
              eq(runFinding.status, "open"),
            ),
          )
          .limit(1);
    if (
      scope.public.purpose === "account_sync" &&
      scope.public.vendorAccountId
    ) {
      await tx
        .update(importHunt)
        .set({ state: "exhausted", error: summary, updatedAt: new Date() })
        .where(
          and(
            eq(
              importHunt.vendorAccountId,
              vendorAccountId.parse(scope.public.vendorAccountId),
            ),
            eq(importHunt.state, "browser_queued"),
          ),
        );
    }
    if (scope.public.purpose !== "account_sync") {
      await tx
        .update(runTarget)
        .set({ state: "unresolved", outcome: null, updatedAt: new Date() })
        .where(
          and(
            eq(runTarget.runId, runId),
            inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
          ),
        );
    }
    await tx
      .update(runTable)
      .set({
        status: "needs_review",
        auditedAt,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTable.id, runId),
          inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    return { findingId: finding?.id ?? existingFinding?.id ?? null };
  });
}

/**
 * Move the account cursor forward to the newest order this run handled
 * (imported or already covered). Only forward: a run that walked an old page
 * never rewinds `newestOrderAt`, and `orderIdsOnNewestDate` disambiguates
 * same-day orders on the next listing.
 */
async function advanceAccountCursor(
  db: Database,
  input: { runId: string; vendorAccountId: VendorAccountId },
) {
  const handled = await getDb(db)
    .select({
      orderId: runOrderCandidate.orderId,
      orderedAt: runOrderCandidate.orderedAt,
    })
    .from(runOrderCandidate)
    .where(
      and(
        eq(runOrderCandidate.runId, input.runId),
        inArray(runOrderCandidate.state, ["imported", "covered"]),
        isNotNull(runOrderCandidate.orderedAt),
      ),
    );
  const newest = handled.reduce<string | null>(
    (acc, row) =>
      row.orderedAt && (!acc || row.orderedAt > acc) ? row.orderedAt : acc,
    null,
  );
  if (!newest) return null;
  const [account] = await getDb(db)
    .select({ cursor: vendorAccount.cursor })
    .from(vendorAccount)
    .where(eq(vendorAccount.id, input.vendorAccountId))
    .limit(1);
  const cursor = vendorAccountCursor.parse(account?.cursor);
  const current = cursor.newestOrderAt?.slice(0, 10) ?? null;
  if (current && newest < current) return cursor;
  const sameDay = handled
    .filter((row) => row.orderedAt === newest)
    .map((row) => row.orderId);
  const next = vendorAccountCursor.parse({
    ...cursor,
    newestOrderAt: `${newest}T00:00:00.000Z`,
    orderIdsOnNewestDate:
      current === newest
        ? [...new Set([...cursor.orderIdsOnNewestDate, ...sameDay])].slice(
            0,
            500,
          )
        : sameDay.slice(0, 500),
  });
  await getDb(db)
    .update(vendorAccount)
    .set({ cursor: next, updatedAt: new Date() })
    .where(eq(vendorAccount.id, input.vendorAccountId));
  return next;
}

export async function finishRun(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: { runId: string; operationId: string },
) {
  const scope = await loadRunScope(db, input.runId);
  const runId = runEntityId.parse(input.runId);
  if (scope.public.status !== "completed") {
    assertRunActive(scope.public.status);
    if (scope.public.purpose !== "account_sync") {
      const targets = await getDb(db)
        .select({ state: runTarget.state })
        .from(runTarget)
        .where(eq(runTarget.runId, runId));
      if (targets.length === 0)
        throw new Error("Targeted import run has no explicit targets");
      const validation = scope.public.purpose === "purchase_validation";
      const incomplete = targets.some(({ state }) =>
        validation
          ? !new Set(["completed", "unavailable"]).has(state)
          : !new Set(["completed", "skipped", "unresolved"]).has(state),
      );
      if (incomplete)
        throw new Error("Targeted import run has unresolved target work");
      const hasUnresolved = targets.some(({ state }) => state === "unresolved");
      const status = hasUnresolved ? "needs_review" : "completed";
      // Targeted validation is deliberately read-only. Its audit is the
      // completed comparison recorded on each target, not account-sync's
      // mutating repair audit.
      await getDb(db)
        .update(runTable)
        .set({
          status,
          auditedAt: new Date(),
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(runTable.id, runId), eq(runTable.status, "running")));
    } else {
      const [pendingHunt] = scope.public.vendorAccountId
        ? await getDb(db)
            .select({ id: importHunt.id })
            .from(importHunt)
            .where(
              and(
                eq(
                  importHunt.vendorAccountId,
                  vendorAccountId.parse(scope.public.vendorAccountId),
                ),
                eq(importHunt.state, "browser_queued"),
              ),
            )
            .limit(1)
        : [];
      if (pendingHunt)
        throw new Error("Import run still has unsettled browser hunt work");
      const [pendingReceipt] = await getDb(db)
        .select({ id: importHunt.id })
        .from(importHunt)
        .where(
          and(
            eq(importHunt.receiptRunId, runId),
            eq(importHunt.state, "processing_receipt"),
          ),
        )
        .limit(1);
      if (pendingReceipt)
        throw new Error("Import run still has unsettled receipt evidence");
      const [pendingOrder] = await getDb(db)
        .select({ value: count() })
        .from(runOrderCandidate)
        .where(
          and(
            eq(runOrderCandidate.runId, runId),
            eq(runOrderCandidate.state, "pending"),
          ),
        );
      if (pendingOrder && pendingOrder.value > 0)
        throw new Error(
          `Import run still has ${pendingOrder.value} listed order(s) to import or stop for review`,
        );

      await auditAllImportBatches(db, {
        runId: input.runId,
        operationId: `${input.operationId}:audit`,
      });
      const auditedAt = new Date();
      await getDb(db)
        .update(runTable)
        .set({
          status: "completed",
          auditedAt,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runTable.id, runId),
            sql`${runTable.status} IN ('running', 'paused_auth', 'paused_offline')`,
          ),
        );
      if (scope.public.vendorAccountId)
        await advanceAccountCursor(db, {
          runId,
          vendorAccountId: vendorAccountId.parse(scope.public.vendorAccountId),
        });
    }
  }
  const [run] = await getDb(db)
    .select({
      imported: runTable.imported,
      updated: runTable.updated,
      skipped: runTable.skipped,
      status: runTable.status,
    })
    .from(runTable)
    .where(eq(runTable.id, runId))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const [findingCount] = await getDb(db)
    .select({ value: count() })
    .from(runFinding)
    .where(and(eq(runFinding.runId, runId), eq(runFinding.status, "open")));
  if (scope.public.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({
        status: "active",
        lastSuccessAt: run.status === "completed" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(
        eq(
          vendorAccount.id,
          vendorAccountId.parse(scope.public.vendorAccountId),
        ),
      );
    await namespace.getByName(scope.public.vendorAccountId).notifyRunCompleted({
      runID: input.runId,
      terminalStatus: z
        .enum(["completed", "needs_review", "failed", "dispatch_failed"])
        .parse(run.status),
      ...run,
      findingCount: findingCount?.value ?? 0,
    });
  }
  return { ...run, findingCount: findingCount?.value ?? 0 };
}

/** @lintignore Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function markRunFailed(
  db: Database,
  input: {
    runId: string;
    failureCode: "flue_failed" | "flue_aborted";
    detail?: string;
    dispatchEventId?: string;
  },
) {
  const runId = runEntityId.parse(input.runId);
  const [run] = await getDb(db)
    .update(runTable)
    .set({
      status: "failed",
      failureCode: input.failureCode,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runTable.id, runId),
        eq(runTable.status, "running"),
        input.dispatchEventId
          ? eq(runTable.dispatchEventId, input.dispatchEventId)
          : undefined,
      ),
    )
    .returning({ vendorAccountId: runTable.vendorAccountId });
  if (run?.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({ status: "active", updatedAt: new Date() })
      .where(sql`${vendorAccount.id} = ${run.vendorAccountId}`);
  }
  return { failed: Boolean(run), detail: input.detail ?? null };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * The run detail every browser and native surface reads: the kernel
 * `run` row plus its child collections, projected once. Private UUIDs
 * and operation payloads never cross this boundary.
 */
export async function loadRunDetail(
  db: Database,
  shortcode: string,
): Promise<RunDetail> {
  const publicId = runShortcode.parse(shortcode);
  const database = getDb(db);
  const [header, [run]] = await Promise.all([
    getRunByShortcode(db, publicId),
    database
      .select({
        id: runTable.id,
        dispatchEventId: runTable.dispatchEventId,
        actorLedgerPartyShortcode: runTable.actorLedgerPartyShortcode,
        actorLedgerPartyName: runTable.actorLedgerPartyName,
      })
      .from(runTable)
      .where(and(eq(runTable.shortcode, publicId), notDeleted(runTable)))
      .limit(1),
  ]);
  if (!header || !run) throw new Error("Import run was not found");

  const [
    successor,
    operations,
    approvals,
    preparedOrders,
    progress,
    affectedPurchases,
    findings,
    controlHistory,
    targets,
    evidence,
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
        operationId: runOperation.operationId,
        kind: runOperation.kind,
        state: runOperation.state,
        error: runOperation.error,
        startedAt: runOperation.startedAt,
        completedAt: runOperation.completedAt,
      })
      .from(runOperation)
      .where(eq(runOperation.runId, run.id))
      .orderBy(asc(runOperation.startedAt)),
    database
      .select({
        id: runApproval.id,
        operationId: runApproval.operationId,
        operationKind: runApproval.operationKind,
        args: runApproval.args,
        state: runApproval.state,
        decidedAt: runApproval.decidedAt,
        rejectedAt: runApproval.rejectedAt,
        consumedAt: runApproval.consumedAt,
        invalidatedAt: runApproval.invalidatedAt,
      })
      .from(runApproval)
      .where(eq(runApproval.runId, run.id))
      .orderBy(asc(runApproval.createdAt)),
    database
      .select({
        stableOrderId: importPreparedOrder.stableOrderId,
        itemOperationId: importPreparedOrder.itemOperationId,
        sourceKind: importPreparedOrder.sourceKind,
        externalKey: importPreparedOrder.sourceExternalKey,
        preparedAt: importPreparedOrder.createdAt,
        lineCount: count(importPreparedLine.id),
      })
      .from(importPreparedOrder)
      .leftJoin(
        importPreparedLine,
        eq(importPreparedLine.preparedOrderId, importPreparedOrder.id),
      )
      .where(eq(importPreparedOrder.runId, run.id))
      .groupBy(importPreparedOrder.id)
      .orderBy(asc(importPreparedOrder.createdAt)),
    database
      .select({
        eventId: runProgress.eventId,
        phase: runProgress.phase,
        currentItem: runProgress.currentItem,
        awaitingApproval: runProgress.awaitingApproval,
        detail: runProgress.detail,
        createdAt: runProgress.createdAt,
      })
      .from(runProgress)
      .where(eq(runProgress.runId, run.id))
      .orderBy(asc(runProgress.createdAt), asc(runProgress.id)),
    database
      .selectDistinct({
        shortcode: purchase.shortcode,
        displayName: purchase.displayLabel,
        orderId: purchase.orderId,
      })
      .from(runMutation)
      .innerJoin(
        purchase,
        and(eq(purchase.id, runMutation.targetId), notDeleted(purchase)),
      )
      .where(
        and(
          eq(runMutation.runId, run.id),
          eq(runMutation.targetType, "purchase"),
        ),
      ),
    database
      .select({
        id: runFinding.id,
        kind: runFinding.kind,
        summary: runFinding.summary,
        status: runFinding.status,
        autoApplied: runFinding.autoApplied,
        probability: runFinding.probability,
        createdAt: runFinding.createdAt,
        expiresAt: runFinding.expiresAt,
      })
      .from(runFinding)
      .where(eq(runFinding.runId, run.id))
      .orderBy(asc(runFinding.createdAt)),
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
    database
      .select({
        id: runTarget.id,
        purchaseId: purchase.shortcode,
        productId: product.shortcode,
        vendorAccountId: vendorAccount.shortcode,
        sourceKind: runTarget.sourceKind,
        sourceExternalKey: runTarget.sourceExternalKey,
        state: runTarget.state,
        targetFingerprint: runTarget.targetFingerprint,
        outcome: runTarget.outcome,
        warning: runTarget.warning,
        diff: runTarget.diff,
        completedAt: runTarget.completedAt,
      })
      .from(runTarget)
      .leftJoin(purchase, eq(purchase.id, runTarget.purchaseId))
      .leftJoin(product, eq(product.id, runTarget.productId))
      .leftJoin(vendorAccount, eq(vendorAccount.id, runTarget.vendorAccountId))
      .where(eq(runTarget.runId, run.id))
      .orderBy(asc(runTarget.createdAt)),
    database
      .select({
        id: runEvidence.id,
        kind: runEvidence.kind,
        checksum: runEvidence.checksum,
        mediaType: runEvidence.mediaType,
        createdAt: runEvidence.createdAt,
      })
      .from(runEvidence)
      .where(eq(runEvidence.runId, run.id))
      .orderBy(asc(runEvidence.createdAt)),
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
    selectRestartTargets(database, run.id),
  ]);
  const controller = (event: (typeof controlHistory)[number]) => ({
    name: event.name,
    ledgerParty: { id: event.ledgerPartyId, name: event.ledgerPartyName },
  });
  const browserProgress = progress.map((event) => ({
    ...event,
    createdAt: event.createdAt.toISOString(),
  }));
  return {
    publicId,
    status: header.status,
    purpose: header.purpose,
    trigger: header.trigger,
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
    dispatch: {
      eventId: run.dispatchEventId,
      state: header.coordinatorStartedAt
        ? "started"
        : header.dispatchError
          ? "failed"
          : "pending",
      attempts: header.dispatchAttempts,
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
    restartInputs: flueImportRunPurpose.safeParse(header.purpose).success
      ? {
          purpose: header.purpose,
          trigger: "manual",
          coordinatorModel: coordinatorModelFor(header.purpose),
          vendorAccount: header.vendorAccountId,
          notes: header.notes,
          skillRevision: header.skillRevision,
          runtimeRevision: header.runtimeRevision,
          targets: restartTargets.map((target) => ({
            position: target.position,
            image: target.imageCode,
            purchase: target.purchaseCode,
            product: target.productCode,
            vendorAccount: target.vendorAccountCode,
            sourceKind: target.sourceKind,
            sourceExternalKey: target.sourceExternalKey,
            targetFingerprint: target.targetFingerprint,
          })),
        }
      : null,
    coordinatorModel: header.coordinatorModel,
    skillRevision: header.skillRevision,
    runtimeRevision: header.runtimeRevision,
    agentModelMs: Number(agentModelUsage[0]?.durationMs ?? 0),
    operations: operations.map((operation) => ({
      ...operation,
      startedAt: operation.startedAt.toISOString(),
      completedAt: iso(operation.completedAt),
    })),
    preparedOrders: preparedOrders.map((order) => ({
      ...order,
      preparedAt: order.preparedAt.toISOString(),
    })),
    targets: targets.map((target) => ({
      id: target.id,
      // A photo-inventory run's targets are always images — it never creates a
      // purchase or product target row, so the run's purpose alone disambiguates.
      targetType: target.purchaseId
        ? "purchase"
        : header.purpose === "photo_inventory"
          ? "image"
          : "product",
      targetShortcode: target.purchaseId ?? target.productId,
      targetName: null,
      sourceId: null,
      sourceLabel: target.sourceKind
        ? `${target.sourceKind}${target.sourceExternalKey ? ` · ${target.sourceExternalKey}` : ""}`
        : null,
      vendorAccountLabel: target.vendorAccountId,
      state: target.state,
      fingerprint: target.targetFingerprint,
      outcome: target.outcome,
      warning: target.warning,
      diff: z
        .json()
        .nullable()
        .parse(target.diff ?? null),
      completedAt: iso(target.completedAt),
    })),
    evidence: evidence.map((item) => ({
      id: item.id,
      // Run-target UUIDs are internal. Evidence still renders under the run.
      targetId: null,
      sourceKind: item.kind,
      filename: null,
      mediaType: item.mediaType,
      checksum: item.checksum,
      createdAt: item.createdAt.toISOString(),
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      operationId: approval.operationId,
      operationKind: approval.operationKind,
      args: z.json().parse(approval.args),
      state: approval.state,
      grantedAt: approval.state === "granted" ? iso(approval.decidedAt) : null,
      consumedAt: iso(approval.consumedAt),
      invalidatedAt: iso(approval.invalidatedAt),
      rejectedAt: iso(approval.rejectedAt),
    })),
    affectedPurchases,
    findings: findings.map((finding) => ({
      ...finding,
      createdAt: finding.createdAt.toISOString(),
      expiresAt: iso(finding.expiresAt),
    })),
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

const DEBUG_EVENT_KIND = "__debug_event";
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

function operationLogEntry(
  operation: Pick<
    typeof runOperation.$inferSelect,
    "id" | "operationId" | "kind" | "state" | "result" | "error" | "startedAt"
  >,
): RunLogEntry | null {
  if (operation.kind === DEBUG_EVENT_KIND) {
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
    .where(eq(runOperation.runId, run.id))
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
    "approve",
    "reject",
    "retry",
    "restart",
    "retry_dispatch",
    "upload_evidence",
    "no_evidence_available",
    "escalate_sol",
  ]),
  operationId: z.string().trim().min(1).max(200).optional(),
  approvalId: z.uuid().optional(),
});

const runControlAction = z.enum([
  "prompt",
  "abort",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
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
  const scope = await loadRunScopeByShortcode(db, input.runPublicId);
  const [controller] = await getDb(db)
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      ledgerPartyId: ledgerParty.id,
      ledgerPartyShortcode: ledgerParty.shortcode,
      ledgerPartyName: ledgerParty.name,
      ledgerPartyKind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  const [event] = await getDb(db)
    .insert(runControlEvent)
    .values({
      runId: scope.public.runId,
      action: input.action,
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: ledgerPartyId.parse(controller.ledgerPartyId),
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

// Every control action shares one locked run and controller-attribution record;
// splitting the switch would weaken the cancellation and approval fences.
export async function controlRun(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof runControlInput>,
) {
  const input = runControlInput.parse(rawInput);
  const scope = await loadRunScopeByShortcode(db, input.runPublicId);
  const [controller] = await getDb(db)
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      ledgerPartyId: ledgerParty.id,
      ledgerPartyShortcode: ledgerParty.shortcode,
      ledgerPartyName: ledgerParty.name,
      ledgerPartyKind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  if (
    input.action === "retry_dispatch" &&
    scope.public.dispatchError === "Awaiting manual evidence upload"
  ) {
    const [evidence] = await getDb(db)
      .select({
        objectKey: runEvidence.objectKey,
        checksum: runEvidence.checksum,
        byteSize: runEvidence.byteSize,
      })
      .from(runEvidence)
      .where(eq(runEvidence.runId, scope.public.runId))
      .orderBy(desc(runEvidence.createdAt))
      .limit(1);
    if (!evidence) throw new Error("Manual evidence has not been uploaded");
    const response = await fetch(getR2PublicUrl(evidence.objectKey));
    if (!response.ok) throw new Error("Manual evidence bytes are unavailable");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== evidence.byteSize)
      throw new Error("Manual evidence size does not match its upload record");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (checksum !== evidence.checksum)
      throw new Error(
        "Manual evidence checksum does not match its upload record",
      );
  }
  return withTransaction(
    db,
    // eslint-disable-next-line complexity
    async (tx) => {
      const [locked] = await tx
        .select({
          status: runTable.status,
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
          notes: runTable.notes,
          skillRevision: runTable.skillRevision,
          runtimeRevision: runTable.runtimeRevision,
          dispatchEventId: runTable.dispatchEventId,
          coordinatorStartedAt: runTable.coordinatorStartedAt,
          decisionRevision: runTable.decisionRevision,
        })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Purchase import run was not found");
      if (input.action === "restart") {
        if (
          !new Set([
            "completed",
            "failed",
            "needs_review",
            "dispatch_failed",
          ]).has(locked.status)
        )
          throw new Error(
            `Only a finished run can be started again (${locked.status})`,
          );
        if (!flueImportRunPurpose.safeParse(locked.purpose).success)
          throw new Error("Only agent import runs can be started again");
        const sourceTargets = (
          await selectRestartTargets(tx, scope.public.runId)
        ).map((target) => ({
          purchaseId: target.purchaseId,
          productId: target.productId,
          imageId: target.imageId,
          position: target.position,
          vendorAccountId: target.vendorAccountId,
          sourceKind: target.sourceKind,
          sourceExternalKey: target.sourceExternalKey,
          targetFingerprint: target.targetFingerprint,
        }));
        if (locked.purpose !== "account_sync" && sourceTargets.length === 0)
          throw new Error("This run has no inputs to start again");
        if (
          locked.purpose === "photo_inventory" &&
          sourceTargets.some((target) => !target.imageId)
        )
          throw new Error("Photo run inputs are incomplete");
        if (locked.purpose === "account_sync" && !locked.vendorAccountId)
          throw new Error(
            "This account run has no vendor account to start again",
          );
        const successorId = runEntityId.parse(crypto.randomUUID());
        const dispatchEventId = crypto.randomUUID();
        const [successor] = await tx
          .insert(runTable)
          .values({
            id: successorId,
            shortcode: generateShortcode("run"),
            ledgerPartyId: locked.ledgerPartyId,
            actorUserId: userId.parse(controller.userId),
            actorName: controller.name,
            actorEmail: controller.email,
            actorLedgerPartyShortcode: controller.ledgerPartyShortcode,
            actorLedgerPartyName: controller.ledgerPartyName,
            actorLedgerPartyKind: controller.ledgerPartyKind,
            vendorAccountId: locked.vendorAccountId,
            vendorId: locked.vendorId,
            predecessorRunId: scope.public.runId,
            purpose: locked.purpose,
            trigger: "manual",
            notes: locked.notes,
            coordinatorModel: coordinatorModelFor(locked.purpose),
            skillRevision: locked.skillRevision,
            runtimeRevision: locked.runtimeRevision,
            dispatchEventId,
            agentSessionId: importRunAgentIdentity(
              successorId,
              flueImportRunPurpose.parse(locked.purpose),
            ),
          })
          .returning({
            publicId: runTable.shortcode,
            status: runTable.status,
          });
        if (!successor) throw new Error("New import run was not created");
        if (sourceTargets.length)
          await tx.insert(runTarget).values(
            sourceTargets.map((target) => ({
              ...target,
              runId: successorId,
              state: "pending" as const,
            })),
          );
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: successorId,
          successorRunPublicId: successor.publicId,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          created: true,
          dispatchRunId: successorId,
          dispatchPublicId: successor.publicId,
          dispatchPurpose: locked.purpose,
          dispatchCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchEventId,
        };
      }
      await tx.insert(runControlEvent).values({
        runId: scope.public.runId,
        action: input.action,
        controllerUserId: userId.parse(controller.userId),
        controllerName: controller.name,
        controllerEmail: controller.email,
        controllerLedgerPartyId: ledgerPartyId.parse(controller.ledgerPartyId),
        controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
        controllerLedgerPartyName: controller.ledgerPartyName,
        controllerLedgerPartyKind: controller.ledgerPartyKind,
      });
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
          .where(eq(runTable.id, scope.public.runId));
        return {
          publicId: input.runPublicId,
          status: "running" as const,
          dispatchRunId: scope.public.runId,
          dispatchPublicId: input.runPublicId,
          dispatchPurpose: locked.purpose,
          dispatchCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchEventId,
        };
      }
      if (
        input.action === "upload_evidence" ||
        input.action === "no_evidence_available"
      ) {
        if (locked.purpose !== "purchase_validation")
          throw new Error("Only purchase validation runs can request evidence");
        if (
          !new Set(["needs_review", "completed", "failed"]).has(locked.status)
        )
          throw new Error(
            `Purchase import run is not terminal in ${locked.status}`,
          );
        const sourceTargets = await tx
          .select({
            purchaseId: runTarget.purchaseId,
            vendorAccountId: runTarget.vendorAccountId,
            sourceKind: runTarget.sourceKind,
            sourceExternalKey: runTarget.sourceExternalKey,
            targetFingerprint: runTarget.targetFingerprint,
            evidenceFingerprint: runTarget.evidenceFingerprint,
          })
          .from(runTarget)
          .where(eq(runTarget.runId, scope.public.runId));
        if (sourceTargets.length === 0)
          throw new Error("Purchase validation run has no explicit target");
        if (sourceTargets.some((target) => !target.purchaseId))
          throw new Error("Purchase validation runs require Purchase targets");

        const successorId = runEntityId.parse(crypto.randomUUID());
        const isUnavailable = input.action === "no_evidence_available";
        const dispatchEventId = isUnavailable ? null : crypto.randomUUID();
        const [successor] = await tx
          .insert(runTable)
          .values({
            id: successorId,
            shortcode: generateShortcode("run"),
            ledgerPartyId: locked.ledgerPartyId,
            actorUserId: locked.actorUserId,
            actorName: locked.actorName,
            actorEmail: locked.actorEmail,
            actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
            actorLedgerPartyName: locked.actorLedgerPartyName,
            actorLedgerPartyKind: locked.actorLedgerPartyKind,
            vendorAccountId: locked.vendorAccountId,
            vendorId: locked.vendorId,
            predecessorRunId: scope.public.runId,
            purpose: "purchase_validation",
            trigger: "manual",
            status: isUnavailable ? "needs_review" : "dispatch_failed",
            coordinatorModel: coordinatorModelFor(locked.purpose),
            dispatchEventId,
            failureCode: isUnavailable ? "no_evidence_available" : null,
            dispatchError: isUnavailable
              ? null
              : "Awaiting manual evidence upload",
            endedAt: isUnavailable ? new Date() : null,
            skillRevision: locked.skillRevision,
            runtimeRevision: locked.runtimeRevision,
            decisionRevision: locked.decisionRevision + 1,
            agentSessionId: importRunAgentIdentity(
              successorId,
              "purchase_validation",
            ),
          })
          .returning({
            publicId: runTable.shortcode,
            status: runTable.status,
          });
        if (!successor)
          throw new Error("Evidence successor run was not created");
        await tx.insert(runTarget).values(
          await Promise.all(
            sourceTargets.map(async (target) => ({
              runId: successorId,
              purchaseId: target.purchaseId,
              productId: null,
              vendorAccountId: target.vendorAccountId,
              sourceKind: target.sourceKind,
              sourceExternalKey: target.sourceExternalKey,
              targetFingerprint: target.targetFingerprint,
              state: isUnavailable ? "unavailable" : "needs_evidence",
              outcome: isUnavailable ? "unavailable" : null,
              evidenceFingerprint: isUnavailable
                ? await sha256Hex(
                    `unavailable:${target.evidenceFingerprint ?? target.targetFingerprint}`,
                  )
                : null,
              completedAt: isUnavailable ? new Date() : null,
            })),
          ),
        );
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: successorId,
          successorRunPublicId: successor.publicId,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchRunId: null,
          dispatchPublicId: successor.publicId,
          dispatchPurpose: "purchase_validation" as const,
          dispatchCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchEventId,
          created: true,
        };
      }
      if (input.action === "retry" || input.action === "escalate_sol") {
        if (
          !new Set(["needs_review", "completed", "failed"]).has(locked.status)
        )
          throw new Error(
            `Purchase import run is not terminal in ${locked.status}`,
          );
        if (!locked.vendorAccountId && !locked.vendorId)
          throw new Error("Purchase import run has no vendor to retry");
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
          .where(eq(runTable.predecessorRunId, scope.public.runId))
          .orderBy(desc(runTable.startedAt))
          .limit(1);
        if (existingSuccessor) {
          return {
            publicId: input.runPublicId,
            status: locked.status,
            successorRunId: existingSuccessor.id,
            successorRunPublicId: existingSuccessor.publicId,
            successorStatus: existingSuccessor.status,
            successorCoordinatorModel: coordinatorModelFor(locked.purpose),
            created: false,
          };
        }
        const successorId = runEntityId.parse(crypto.randomUUID());
        const dispatchEventId = crypto.randomUUID();
        const [successor] = await tx
          .insert(runTable)
          .values({
            id: successorId,
            shortcode: generateShortcode("run"),
            ledgerPartyId: locked.ledgerPartyId,
            actorUserId: locked.actorUserId,
            actorName: locked.actorName,
            actorEmail: locked.actorEmail,
            actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
            actorLedgerPartyName: locked.actorLedgerPartyName,
            actorLedgerPartyKind: locked.actorLedgerPartyKind,
            vendorAccountId: successorVendorAccountId,
            vendorId: locked.vendorId,
            predecessorRunId: scope.public.runId,
            purpose: locked.purpose,
            trigger: locked.trigger,
            dispatchEventId,
            coordinatorModel: coordinatorModelFor(locked.purpose),
            skillRevision: locked.skillRevision,
            runtimeRevision: locked.runtimeRevision,
            decisionRevision: locked.decisionRevision + 1,
            agentSessionId: importRunAgentIdentity(
              successorId,
              flueImportRunPurpose.parse(locked.purpose),
            ),
          })
          .returning({
            publicId: runTable.shortcode,
            status: runTable.status,
          });
        if (!successor) throw new Error("Successor import run was not created");
        if (locked.purpose !== "account_sync") {
          const unresolvedTargets = await tx
            .select({
              purchaseId: runTarget.purchaseId,
              productId: runTarget.productId,
              vendorAccountId: runTarget.vendorAccountId,
              sourceKind: runTarget.sourceKind,
              sourceExternalKey: runTarget.sourceExternalKey,
              targetFingerprint: runTarget.targetFingerprint,
            })
            .from(runTarget)
            .where(
              and(
                eq(runTarget.runId, scope.public.runId),
                inArray(runTarget.state, [
                  "pending",
                  "prepared",
                  "unresolved",
                  "needs_evidence",
                  "unavailable",
                ]),
              ),
            );
          if (unresolvedTargets.length === 0)
            throw new Error("Targeted import run has no unresolved targets");
          await tx.insert(runTarget).values(
            unresolvedTargets.map((target) => ({
              runId: successorId,
              ...target,
              state: "pending" as const,
            })),
          );
        }
        if (successorVendorAccountId) {
          await tx
            .update(vendorAccount)
            .set({
              status: "active",
              lastRunAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(vendorAccount.id, successorVendorAccountId));
        } else {
          await tx
            .update(importHunt)
            .set({
              receiptRunId: successorId,
              state: "processing_receipt",
              error: null,
              updatedAt: new Date(),
            })
            .where(eq(importHunt.receiptRunId, scope.public.runId));
        }
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: successorId,
          successorRunPublicId: successor.publicId,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          created: true,
          dispatchRunId: successorId,
          dispatchPublicId: successor.publicId,
          dispatchPurpose: locked.purpose,
          dispatchCoordinatorModel: coordinatorModelFor(locked.purpose),
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
          throw new Error(
            `Purchase import run is immutable in ${locked.status}`,
          );
        const browserOperations = await tx
          .select({ result: runOperation.result })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              eq(runOperation.kind, "browser_command"),
              inArray(runOperation.state, ["started", "completed"]),
            ),
          );
        await tx
          .update(runTable)
          .set({
            status: "failed",
            failureCode: dispatchAbort ? "dispatch_aborted" : "user_cancelled",
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(runTable.id, scope.public.runId));
        await tx
          .update(runApproval)
          .set({ state: "invalidated", invalidatedAt: new Date() })
          .where(
            and(
              eq(runApproval.runId, scope.public.runId),
              inArray(runApproval.state, ["pending", "granted"]),
            ),
          );
        await tx
          .update(runOperation)
          .set({
            state: "failed",
            error: dispatchAbort
              ? "Dispatch aborted by its owner"
              : "Run cancelled by its owner",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              inArray(runOperation.state, ["started", "paused_approval"]),
            ),
          );
        return {
          publicId: input.runPublicId,
          status: "failed" as const,
          cancelledBrowserCommandIds: browserOperations.flatMap(
            ({ result }) => {
              const parsed = z
                .object({ commandId: z.uuid() })
                .safeParse(result);
              return parsed.success ? [parsed.data.commandId] : [];
            },
          ),
        };
      }
      if (input.action === "pause") {
        if (locked.status !== "running")
          throw new Error(`Purchase import run is fenced in ${locked.status}`);
        await tx
          .update(runTable)
          .set({ status: "paused_approval", updatedAt: new Date() })
          .where(eq(runTable.id, scope.public.runId));
        return {
          publicId: input.runPublicId,
          status: "paused_approval" as const,
        };
      }
      if (input.action === "resume") {
        if (!new Set(["paused_auth", "paused_offline"]).has(locked.status))
          throw new Error(`Purchase import run is fenced in ${locked.status}`);
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
          .where(eq(runTable.id, scope.public.runId));
        return {
          publicId: input.runPublicId,
          status: "running" as const,
          dispatchRunId: scope.public.runId,
          dispatchPublicId: input.runPublicId,
          dispatchPurpose: locked.purpose,
          dispatchCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchEventId,
        };
      }

      if (!input.operationId)
        throw new Error("Approval decision requires an operation id");
      const [operation] = await tx
        .select({
          inputFingerprint: runOperation.inputFingerprint,
          state: runOperation.state,
          kind: runOperation.kind,
          result: runOperation.result,
        })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, scope.public.runId),
            eq(runOperation.operationId, input.operationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!operation || operation.state !== "paused_approval")
        throw new Error("Approval proposal is missing or no longer pending");
      const proposal = z
        .object({
          approvalProposal: z.object({
            operationKind: z.string().min(1),
            args: z.unknown(),
            targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
            evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          }),
        })
        .parse(operation.result).approvalProposal;
      const [existing] = input.approvalId
        ? await tx
            .select({
              id: runApproval.id,
              state: runApproval.state,
            })
            .from(runApproval)
            .where(
              and(
                eq(runApproval.id, input.approvalId),
                eq(runApproval.runId, scope.public.runId),
                eq(runApproval.operationId, input.operationId),
              ),
            )
            .limit(1)
        : await tx
            .select({
              id: runApproval.id,
              state: runApproval.state,
            })
            .from(runApproval)
            .where(
              and(
                eq(runApproval.runId, scope.public.runId),
                eq(runApproval.operationId, input.operationId),
              ),
            )
            .limit(1);
      let approvalId = existing?.id;
      if (!approvalId) {
        const [created] = await tx
          .insert(runApproval)
          .values({
            runId: scope.public.runId,
            operationId: input.operationId,
            operationKind: proposal.operationKind,
            args: proposal.args,
            argsFingerprint: operation.inputFingerprint,
            targetFingerprint: proposal.targetFingerprint,
            evidenceFingerprint: proposal.evidenceFingerprint,
            state: "pending",
          })
          .returning({ id: runApproval.id });
        approvalId = created?.id;
      }
      if (!approvalId) throw new Error("Approval was not recorded");
      if (input.action === "reject") {
        if (
          existing &&
          existing.state !== "pending" &&
          existing.state !== "granted"
        )
          throw new Error(`Approval is already ${existing.state}`);
        const decidedAt = new Date();
        await tx
          .update(runApproval)
          .set({
            state: "rejected",
            decidedByUserId: actor.userId,
            decidedAt,
            rejectedAt: decidedAt,
          })
          .where(eq(runApproval.id, approvalId));
        await tx
          .update(runOperation)
          .set({
            state: "failed",
            error: "Mutation proposal rejected by a household member",
            updatedAt: decidedAt,
          })
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              eq(runOperation.operationId, input.operationId),
            ),
          );
        const pending = await tx
          .select({ id: runApproval.id })
          .from(runApproval)
          .where(
            and(
              eq(runApproval.runId, scope.public.runId),
              inArray(runApproval.state, ["pending", "granted"]),
            ),
          )
          .limit(1);
        const status = pending.length > 0 ? "paused_approval" : "running";
        await tx
          .update(runTable)
          .set({ status, updatedAt: decidedAt })
          .where(eq(runTable.id, scope.public.runId));
        return {
          publicId: input.runPublicId,
          status,
          approvalId,
          decision: "rejected" as const,
        };
      }
      if (
        existing &&
        existing.state !== "pending" &&
        existing.state !== "granted"
      )
        throw new Error(`Approval is already ${existing.state}`);
      if (operation.kind.startsWith("mcp:")) {
        const { purchaseAgentTargetFingerprint } =
          await import("~/server/mcp/purchase-agent-protocol");
        const currentTarget = await purchaseAgentTargetFingerprint(
          databaseForTransaction(tx),
          z.json().parse(proposal.args),
        );
        if (currentTarget !== proposal.targetFingerprint) {
          await tx
            .update(runApproval)
            .set({ state: "invalidated", invalidatedAt: new Date() })
            .where(eq(runApproval.id, approvalId));
          await tx
            .update(runOperation)
            .set({
              state: "failed",
              error: "Mutation target changed after proposal",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(runOperation.runId, scope.public.runId),
                eq(runOperation.operationId, input.operationId),
              ),
            );
          await tx
            .update(runTable)
            .set({ status: "running", updatedAt: new Date() })
            .where(eq(runTable.id, scope.public.runId));
          return {
            publicId: input.runPublicId,
            status: "running" as const,
            approvalId,
            decision: "invalidated" as const,
          };
        }
      }
      await tx
        .update(runApproval)
        .set({
          state: "granted",
          decidedByUserId: actor.userId,
          decidedAt: new Date(),
        })
        .where(eq(runApproval.id, approvalId));
      await tx
        .update(runOperation)
        .set({
          result: {
            ...z.record(z.string(), z.unknown()).parse(operation.result),
            approvalId,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runOperation.runId, scope.public.runId),
            eq(runOperation.operationId, input.operationId),
          ),
        );
      return {
        publicId: input.runPublicId,
        status: "paused_approval" as const,
        approvalId,
        decision: "approved" as const,
      };
    },
  );
}
