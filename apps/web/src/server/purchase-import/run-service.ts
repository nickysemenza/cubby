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
  agentImportRunPurpose,
  importRunAgentIdentity,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import {
  type AgentProgressEvent,
  agentProgressEvent,
} from "@cubby/schemas/purchase-agent-services";
import {
  proposedImportFix,
  extractedPurchaseLine,
  preparePurchaseImportOut,
  commitPurchaseImportOut,
} from "@cubby/schemas/purchase-import";
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
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  CHARGE_HUNT_STATE,
  chargeHuntOutcomeOf,
  chargeHuntRunInput,
  orderBackfillRunInput,
  orderMailImportRunInput,
} from "@cubby/schemas/run-fields";
import type { Trade } from "@cubby/schemas/task-fields";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
import { sha256Hex, sha256Uuid } from "@cubby/shared/sha256";
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
  auditLog,
  entityAttachment,
  entityExternalId,
  entityIdentity,
  financialTransaction,
  financialTransactionAllocation,
  image,
  importHunt,
  importPreparedLine,
  importPreparedOrder,
  ledgerParty,
  photoGroupProposal,
  product,
  purchase,
  run as runTable,
  runApproval,
  runControlEvent,
  runEvidence,
  runFinding,
  runOperation,
  runOrderCandidate,
  runProgress,
  runTarget,
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
import {
  completeOperation,
  DEBUG_EVENT_KIND,
  failOperation,
  failOperationsForRun,
  insertOperation,
  readOperation,
  setOperationResult,
} from "~/server/repo/run-operation";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import { publishImageProcessingWakeups } from "~/server/services/image-processing.service";
import {
  productionPhotoImportCommitPorts,
  verifyStagedImages,
  type PhotoImportCommitPorts,
} from "~/server/services/photo-import-commit.service";
import { finalizeImportedImages } from "~/server/services/photo-import-finalize.service";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { loadPurchaseAuditBatch } from "./audit-batch";
import {
  notHeldByChargeRun,
  unfinishedChargeRunOwns,
} from "./charge-hunt-state";
import type { PurchaseImportDurableObjectRpc } from "./contracts";
import { resolveRunFinding } from "./findings";
import {
  loadOrderMailImportEvidence,
  markOrderMailCandidateImported,
  orderMailImportedPurchase,
} from "./gmail/import";
import { attachPendingOrderMailEvidence } from "./gmail/process";
import { classifyOrderCapture } from "./order-list";
import { loadReceiptEvidenceForRun } from "./receipt-evidence";
import { importVendorOrder } from "./writer";

/** The coordinator model for a run purpose; purchase-agent reads the same manifest. */
function coordinatorModelFor(purpose: string) {
  const parsed = agentImportRunPurpose.safeParse(purpose);
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
      entityId: runTarget.entityId,
      entityKind: runTarget.entityKind,
      position: runTarget.position,
      vendorAccountId: runTarget.vendorAccountId,
      sourceKind: runTarget.sourceKind,
      sourceExternalKey: runTarget.sourceExternalKey,
      targetFingerprint: runTarget.targetFingerprint,
      entityCode: entityIdentity.shortcode,
      vendorAccountCode: vendorAccount.shortcode,
    })
    .from(runTarget)
    .leftJoin(entityIdentity, eq(entityIdentity.id, runTarget.entityId))
    .leftJoin(vendorAccount, eq(vendorAccount.id, runTarget.vendorAccountId))
    .where(eq(runTarget.runId, runId))
    .orderBy(asc(runTarget.position), asc(runTarget.createdAt));
}

export const ACTIVE_RUN_STATUSES = [
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
] as const;

/** Statuses in which a charge run holds its hunts (a failed dispatch is retried). */
export const CHARGE_HOLDING_STATUSES = [
  ...ACTIVE_RUN_STATUSES,
  "dispatch_failed",
] as const;

/** An implicit start, restart, or retry must not work a charge run's account. */
async function assertNoHoldingChargeRun(
  tx: DrizzleTransaction,
  accountId: VendorAccountId,
  exceptRunId?: RunId,
) {
  const [held] = await tx
    .select({ shortcode: runTable.shortcode })
    .from(runTable)
    .where(
      and(
        eq(runTable.vendorAccountId, accountId),
        inArray(runTable.status, [...CHARGE_HOLDING_STATUSES]),
        sql`${runTable.input}->>'kind' = 'charge_hunts'`,
        exceptRunId ? ne(runTable.id, exceptRunId) : undefined,
      ),
    )
    .limit(1);
  if (held) throw new ActiveChargeRunError(held.shortcode);
}

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

const operationUuid = async (runId: string, operationId: string) => {
  return z.uuid().parse(await sha256Uuid(`${runId}:${operationId}`));
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
    /** Inclusive order-date range for an explicit `backfill` run. */
    backfill?: { from: string; to: string };
    /**
     * Charge hunts a member selected: the run's only work. Never joins a run
     * already holding the account, which would silently drop the selection.
     */
    chargeHuntIds?: readonly string[];
    predecessorRunId?: string;
  },
) {
  const trigger = runTrigger.parse(input.trigger);
  const backfill = input.backfill
    ? orderBackfillRunInput.parse({ kind: "order_backfill", ...input.backfill })
    : null;
  if ((trigger === "backfill") !== (backfill !== null))
    throw new Error("A backfill run requires exactly one explicit date range");
  const chargeHunts = input.chargeHuntIds
    ? chargeHuntRunInput.parse({
        kind: "charge_hunts",
        huntIds: [...input.chargeHuntIds],
      })
    : null;
  if (chargeHunts && backfill)
    throw new Error("A run cannot be both a backfill and a charge search");
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.vendorAccountId}))`,
    );
    const [scope] = await tx
      .select({
        id: vendorAccount.id,
        vendorId: vendorAccount.vendorId,
        browserSyncEnabled: vendorAccount.browserSyncEnabled,
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
    const actorUserId = scope?.actorUserId;
    if (!actorUserId)
      throw new Error("Vendor account is not owned by an authenticated member");
    if (!scope.browserSyncEnabled)
      throw new Error("Browser sync is not enabled for this Vendor account");
    if (backfill) {
      // A backfill never joins a different active run: resuming an
      // incremental sync or another range would silently drop the request.
      const [active] = await tx
        .select({ input: runTable.input })
        .from(runTable)
        .where(
          and(
            eq(runTable.vendorAccountId, input.vendorAccountId),
            inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .limit(1);
      const activeRange = orderBackfillRunInput.safeParse(active?.input);
      if (
        active &&
        !(
          activeRange.success &&
          activeRange.data.from === backfill.from &&
          activeRange.data.to === backfill.to
        )
      )
        throw new Error(
          "Vendor account already has an active import run; finish or stop it before starting this backfill",
        );
    }
    if (!chargeHunts) await assertNoHoldingChargeRun(tx, input.vendorAccountId);
    if (chargeHunts) {
      const [active] = await tx
        .select({ shortcode: runTable.shortcode })
        .from(runTable)
        .where(
          and(
            eq(runTable.vendorAccountId, input.vendorAccountId),
            inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .limit(1);
      if (active)
        throw new Error(
          `Vendor account already has an active import run (${active.shortcode}); finish or stop it before searching for selected charges`,
        );
    }
    const result = await findOrCreateWithShortcode(tx, "run", {
      where: and(
        eq(runTable.vendorAccountId, input.vendorAccountId),
        inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
      ),
      values: () => {
        const id = runEntityId.parse(crypto.randomUUID());
        return {
          id,
          ledgerPartyId: input.ledgerPartyId,
          actorUserId,
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
          input: backfill ?? chargeHunts,
          coordinatorModel: coordinatorModelFor("account_sync"),
          agentSessionId: importRunAgentIdentity(id, "account_sync"),
          dispatchEventId: crypto.randomUUID(),
        };
      },
    });
    const run = {
      id: result.row.id,
      publicId: result.row.shortcode,
      status: result.row.status,
      dispatchEventId: result.row.dispatchEventId,
    };
    if (!result.created) return { ...run, created: false };
    await tx
      .update(vendorAccount)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(vendorAccount.id, input.vendorAccountId));
    return { ...run, created: true };
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
    const run = await insertWithShortcode(tx, "run", {
      id,
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
        agentImportRunPurpose.parse(purpose),
      ),
    });
    await tx.insert(runTarget).values(
      input.targets.map((target) => ({
        runId: id,
        entityKind: target.kind,
        entityId:
          target.kind === "purchase"
            ? purchaseId.parse(target.purchaseId)
            : productId.parse(target.productId),
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
    return {
      created: true as const,
      run: {
        id: run.id,
        publicId: run.shortcode,
        status: run.status,
        purpose: run.purpose,
        dispatchEventId: run.dispatchEventId,
      },
    };
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
        sql`EXISTS (SELECT 1 FROM ${runTarget} WHERE ${runTarget.runId} = ${runTable.id} AND ${runTarget.entityKind} = 'image' AND ${runTarget.state} = 'pending')`,
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
              entityKind: "image" as const,
              entityId: imageId.parse(entry.row.id),
              position: detail?.position ?? 0,
              state: runTargetState.enum.pending,
              targetFingerprint: detail?.sha256 ?? entry.integrity.sha256,
            };
          }),
        )
        // Conflicts land on the `(runId, entityId)` unique index — a
        // retried chunk re-selecting an already-targeted image is a no-op,
        // not a failure. The bare form matches every constraint on the
        // table, same as `persistLocalImageAnalysis`'s idempotent upsert.
        .onConflictDoNothing()
        .returning({ entityId: runTarget.entityId });
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
      runId: scope.public.runId,
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

export async function updateAgentProgress(
  db: Database,
  rawInput: AgentProgressEvent,
) {
  const input = agentProgressEvent.parse(rawInput);
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
  for (const { id } of expired)
    await deferQueuedChargeHunts(db, id, "Run expired while offline");
  return { expired: expired.length };
}

const STALE_RUN_MS = 2 * 60 * 60_000;

/** The approval decision a `controlRun` wake event names (`approvalWakeEvent`). */
const APPROVAL_WAKE_DECISION = new Map([
  ["granted", "approved"],
  ["consumed", "approved"],
  ["rejected", "rejected"],
  ["invalidated", "invalidated"],
]);

/**
 * Whether the server issued a wake the reporting agent has not received: the
 * current dispatch generation, a member's approval decision, or a Mac answer
 * to a browser command. Each is a queue event that resumes the conversation,
 * so the stop the settled submission reported is not where the run ends.
 * Event ids, not clocks: the two Workers' clocks are not comparable.
 */
async function unreceivedWake(
  db: Database,
  scope: Awaited<ReturnType<typeof loadRunScope>>,
  received: ReadonlySet<string>,
  broker: ReturnType<PurchaseImportNamespace["getByName"]> | undefined,
): Promise<boolean> {
  const runId = scope.public.runId;
  if (
    scope.public.dispatchEventId &&
    !received.has(scope.public.dispatchEventId)
  )
    return true;
  const decided = await getDb(db)
    .select({ id: runApproval.id, state: runApproval.state })
    .from(runApproval)
    .where(
      and(
        eq(runApproval.runId, runId),
        inArray(runApproval.state, [...APPROVAL_WAKE_DECISION.keys()]),
      ),
    );
  for (const { id, state } of decided) {
    const decision = APPROVAL_WAKE_DECISION.get(state);
    if (!received.has(`approval:${id}:${decision}`)) return true;
  }
  if (!broker) return false;
  const commands = await getDb(db)
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runId),
        eq(runOperation.kind, "browser_command"),
      ),
    );
  for (const { result } of commands) {
    const command = z.object({ commandId: z.uuid() }).safeParse(result);
    if (!command.success) continue;
    const { commandId } = command.data;
    // An answered command's result event resumes the conversation; until
    // the agent has received it, that answer is still in flight.
    if (
      !received.has(`browser-result:${commandId}`) &&
      (await broker.result(commandId))
    )
      return true;
  }
  return false;
}

/**
 * A run still `running` after its agent submission settled means the
 * coordinator stopped without a terminal tool call: a `review` progress
 * report, a turn budget, or a model that simply ended its turn. The
 * legitimate ways to settle while running are a wake the agent has not
 * received yet (`unreceivedWake`), a browser command still in flight, and
 * photo groups awaiting a household review, so those cases are left alone.
 * A pending approval never reaches here: it moves the run to
 * `paused_approval` first.
 */
export async function reconcileSettledRun(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: {
    runId: string;
    operationId: string;
    detail?: string;
    /**
     * Every queue event id the reporting agent has received; absent for the
     * stale-run sweep, which reconciles regardless.
     */
    receivedEventIds?: ReadonlySet<string>;
    /** The settled submission went unanswered: fail the run instead. */
    failure?: {
      failureCode: "agent_failed" | "agent_aborted";
      detail?: string;
    };
    /** Cancel bridge commands nobody answered before this instant. */
    abandonCommandsBefore?: Date;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  if (scope.public.status !== "running")
    return { reconciled: false as const, status: scope.public.status };
  const broker = scope.public.vendorAccountId
    ? namespace.getByName(scope.public.vendorAccountId)
    : undefined;
  // Snapshot unanswered commands before looking for answered ones, so a Mac
  // answer landing between the two reads is seen as an undelivered wake.
  const pending = broker
    ? await broker.pendingCommands(scope.public.runId)
    : [];
  if (
    input.receivedEventIds &&
    (await unreceivedWake(db, scope, input.receivedEventIds, broker))
  )
    return { reconciled: false as const, status: "running" as const };
  // A command still awaiting the Mac will resume the conversation with its
  // result; the sweep's cutoff abandons only commands nobody answered.
  const cutoff = input.abandonCommandsBefore?.getTime();
  if (
    pending.some(
      (command) => cutoff === undefined || command.createdAt >= cutoff,
    )
  )
    return { reconciled: false as const, status: "running" as const };
  if (input.failure) {
    const { failed } = await markRunFailed(db, {
      runId: input.runId,
      ...input.failure,
    });
    return failed
      ? { reconciled: true as const, status: "failed" as const }
      : {
          reconciled: false as const,
          status: (await loadRunScope(db, input.runId)).public.status,
        };
  }
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
  if (broker) {
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

/** The hunts a charge-search run was assigned, or null for every other run. */
async function runChargeHuntIds(
  db: Database,
  runId: string,
): Promise<string[] | null> {
  const [row] = await getDb(db)
    .select({ input: runTable.input })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  const parsed = chargeHuntRunInput.safeParse(row?.input);
  return parsed.success ? parsed.data.huntIds : null;
}

/**
 * A selected hunt whose charge is now allocated has nothing left to find,
 * whichever path allocated it (this run's commit, retained evidence, or a
 * member). Only a queued hunt moves; a recorded outcome stays.
 */
async function resolveAllocatedChargeHunts(
  db: Database,
  huntIds: readonly string[],
) {
  await getDb(db)
    .update(importHunt)
    .set({ state: CHARGE_HUNT_STATE.resolved, updatedAt: new Date() })
    .where(
      and(
        inArray(importHunt.id, [...huntIds]),
        eq(importHunt.state, CHARGE_HUNT_STATE.queued),
        sql`EXISTS (
          SELECT 1 FROM "FinancialTransactionAllocation" a
          WHERE a."transactionId" = ${importHunt.financialTransactionId}
            AND a."deletedAt" IS NULL
        )`,
      ),
    );
}

/**
 * A charge run that ends without finishing (cancelled, failed, expired) leaves
 * its still-queued selected hunts for review: they stay reselectable and a
 * restart can carry them, instead of being queued under a dead run.
 */
async function deferQueuedChargeHunts(
  db: Database,
  runId: string,
  reason: string,
) {
  const huntIds = await runChargeHuntIds(db, runId);
  if (!huntIds) return;
  await getDb(db)
    .update(importHunt)
    .set({
      state: CHARGE_HUNT_STATE.deferred,
      error: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(importHunt.id, huntIds),
        eq(importHunt.state, CHARGE_HUNT_STATE.queued),
      ),
    );
}

/** An implicit start must not silently join a member's selected-charges run. */
export class ActiveChargeRunError extends Error {
  constructor(runShortcode: string) {
    super(
      `Vendor account is running a selected charge search (${runShortcode}); finish or stop it first`,
    );
    this.name = "ActiveChargeRunError";
  }
}

// eslint-disable-next-line complexity -- Purpose-specific work selection is an explicit authority boundary.
export async function claimNextImportWork(
  db: Database,
  namespace: PurchaseImportNamespace,
  runId: string,
) {
  const scope = await loadRunScope(db, runId);
  if (scope.public.status === "paused_approval")
    return { kind: "paused_approval" as const };
  const mail = await loadOrderMailImportEvidence(db, scope.public.runId, {
    allowComplete: true,
  });
  if (mail) {
    assertRunActive(scope.public.status);
    const purchaseId = await orderMailImportedPurchase(db, mail);
    // A selected order another run already imported is settled work here.
    if (purchaseId && mail.selected)
      await markOrderMailCandidateImported(
        db,
        scope.public.runId,
        mail.orderId,
      );
    return purchaseId
      ? {
          kind: "settlement_verification" as const,
          purchaseId,
          orderId: mail.orderId,
        }
      : {
          kind: "mail_evidence" as const,
          orderId: mail.orderId,
          evidenceChecksum: mail.evidenceChecksum,
        };
  }
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
        await deferQueuedChargeHunts(
          db,
          scope.public.runId,
          "Run expired while offline",
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
        and(eq(purchase.id, runTarget.entityId), notDeleted(purchase)),
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
        and(eq(product.id, runTarget.entityId), notDeleted(product)),
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
          eq(runTarget.entityKind, "image"),
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
  // A charge-search run works exactly its selected hunts and never walks
  // order history, so unselected hunts and unrelated orders stay out of it.
  const chargeHuntIds = await runChargeHuntIds(db, scope.public.runId);
  if (chargeHuntIds) await resolveAllocatedChargeHunts(db, chargeHuntIds);
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
        chargeHuntIds
          ? inArray(importHunt.id, chargeHuntIds)
          : notHeldByChargeRun,
      ),
    )
    .orderBy(
      // Selected charges are searched oldest first, so a restart is stable.
      ...(chargeHuntIds
        ? [asc(importHunt.dateFrom), asc(importHunt.id)]
        : [asc(importHunt.updatedAt)]),
    )
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
      startUrl: entityExternalId.url,
    })
    .from(auditLog)
    .innerJoin(
      product,
      and(eq(product.id, auditLog.entityId), notDeleted(product)),
    )
    .innerJoin(
      entityExternalId,
      and(
        eq(entityExternalId.entityId, product.id),
        isNotNull(entityExternalId.url),
        notDeleted(entityExternalId),
      ),
    )
    .leftJoin(
      entityAttachment,
      and(
        eq(entityAttachment.entityId, product.id),
        notDeleted(entityAttachment),
      ),
    )
    .where(
      and(
        eq(auditLog.runId, scope.public.runId),
        eq(auditLog.entityKind, "product"),
        isNull(entityAttachment.id),
      ),
    )
    .limit(1);
  if (enrichment[0]?.startUrl)
    return { kind: "product_enrichment" as const, ...enrichment[0] };
  if (chargeHuntIds) return { kind: "none" as const };
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
  if (!walkFrom) return { kind: "none" as const };
  const backfill = await runBackfillRange(db, scope.public.runId);
  return backfill
    ? {
        kind: "cursor_walk" as const,
        startUrl: walkFrom,
        backfill: { from: backfill.from, to: backfill.to },
      }
    : { kind: "cursor_walk" as const, startUrl: walkFrom };
}

/** The explicit date range of a backfill run, or null for any other run. */
async function runBackfillRange(db: Database, runId: string) {
  const [row] = await getDb(db)
    .select({ input: runTable.input })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  const parsed = orderBackfillRunInput.safeParse(row?.input);
  return parsed.success ? parsed.data : null;
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
  const key = {
    runId: runEntityId.parse(input.runId),
    operationId: input.operationId,
  };
  const recorded = await readOperation(database, key);
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
    await insertOperation(database, {
      ...key,
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
  // A replay re-enqueues a command the broker already answered; its recorded
  // terminal failure (`readBrowserCommandResult`) is still the diagnostic.
  await completeOperation(
    database,
    key,
    { command, commandId },
    { keepError: true },
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
  const key = {
    runId: runEntityId.parse(input.runId),
    operationId: input.operationId,
  };
  const row = await readOperation(getDb(db), key);
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
    await failOperation(
      getDb(db),
      key,
      `${result.outcome.code}: ${result.outcome.message}`,
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
  input: {
    runId: string;
    operationId: string;
    commandId: string;
    defaultTrade?: Trade;
    defaultProjectId?: string;
  },
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
          sourceURL: capture.sourceURL,
          structuredProducts: capture.structuredProducts ?? null,
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
    const backfill = await runBackfillRange(db, input.runId);
    // Stop paging once a whole page predates the walk's lower bound: the
    // backfill range's start, otherwise the account cursor (everything older
    // was covered by an earlier run). One older order on a page is not
    // enough, because a vendor's history is not strictly date ordered.
    const lowerBound =
      backfill?.from ?? cursor?.newestOrderAt?.slice(0, 10) ?? null;
    const reachedCursor =
      lowerBound !== null &&
      classified.orders.length > 0 &&
      classified.orders.every(
        (order) => order.orderedAt !== null && order.orderedAt < lowerBound,
      );
    // A backfill works only its range. An undated listing row stays: its
    // detail page decides, and importing it is replay-safe.
    const listedOrders = backfill
      ? classified.orders.filter(
          (order) =>
            order.orderedAt === null ||
            (order.orderedAt >= backfill.from &&
              order.orderedAt <= backfill.to),
        )
      : classified.orders;
    const seen = await recordOrderListing(db, {
      runId: runEntityId.parse(input.runId),
      vendorId: scope.vendorId,
      orders: listedOrders,
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
      orders: listedOrders,
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
      defaultTrade: input.defaultTrade,
      defaultProjectId: input.defaultProjectId
        ? await resolveOrThrow(db, "project", input.defaultProjectId)
        : undefined,
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
  const { setDataException } =
    await import("~/server/repo/data-quality/exceptions");
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
        entityKind: relinkExpenseId ? "expense" : "purchase",
        entityId: relinkExpenseId ?? finding.targetPurchaseId,
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
        entityKind: "run",
        entityId: runId,
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
              eq(runFinding.entityKind, "run"),
              eq(runFinding.entityId, runId),
              eq(runFinding.kind, kind),
              eq(runFinding.evidenceFingerprint, fingerprint),
              eq(runFinding.status, "open"),
            ),
          )
          .limit(1);
    const stoppedHuntIds = await runChargeHuntIds(
      databaseForTransaction(tx),
      runId,
    );
    if (stoppedHuntIds) {
      // A stopped charge search found nothing wrong with its charges, so its
      // unfinished ones are left for review and carried by a restart.
      await tx
        .update(importHunt)
        .set({
          state: CHARGE_HUNT_STATE.deferred,
          error: summary,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(importHunt.id, stoppedHuntIds),
            eq(importHunt.state, CHARGE_HUNT_STATE.queued),
          ),
        );
    } else if (
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
            // Hunts a member's selected-charges run holds are not this run's.
            notHeldByChargeRun,
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
 * Leave one listed order for human review while the run continues with the
 * rest of its worklist. The order keeps a durable finding and becomes
 * `skipped`; a restart carries it forward as pending work.
 */
export async function deferOrderForReview(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    orderId: string;
    summary: string;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  if (scope.public.purpose !== "account_sync")
    throw new Error("Only an account-sync run has an order worklist");
  const runId = runEntityId.parse(input.runId);
  const orderId = z.string().trim().min(1).max(200).parse(input.orderId);
  const summary = z.string().trim().min(1).max(1_000).parse(input.summary);
  const fingerprint = await sha256Hex(`deferred-order:${orderId}`);
  return withTransaction(db, async (tx) => {
    const [candidate] = await tx
      .select({ state: runOrderCandidate.state })
      .from(runOrderCandidate)
      .where(
        and(
          eq(runOrderCandidate.runId, runId),
          eq(runOrderCandidate.orderId, orderId),
        ),
      )
      .limit(1)
      .for("update");
    if (!candidate || !["pending", "skipped"].includes(candidate.state))
      throw new Error(
        `Order ${orderId} is not a pending order on this run's worklist`,
      );
    await tx
      .insert(runFinding)
      .values({
        runId,
        ledgerPartyId: scope.ledgerPartyId,
        entityKind: "run",
        entityId: runId,
        kind: "other",
        summary: `Order ${orderId} needs review: ${summary}`,
        evidenceFingerprint: fingerprint,
      })
      .onConflictDoNothing();
    const [finding] = await tx
      .select({ id: runFinding.id })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.runId, runId),
          eq(runFinding.entityKind, "run"),
          eq(runFinding.entityId, runId),
          eq(runFinding.evidenceFingerprint, fingerprint),
          eq(runFinding.status, "open"),
        ),
      )
      .limit(1);
    await tx
      .update(runOrderCandidate)
      .set({ state: "skipped", updatedAt: new Date() })
      .where(
        and(
          eq(runOrderCandidate.runId, runId),
          eq(runOrderCandidate.orderId, orderId),
        ),
      );
    return {
      orderId,
      state: "skipped" as const,
      findingId: finding?.id ?? null,
    };
  });
}

/**
 * Record one selected charge hunt's outcome when its evidence did not settle
 * it, then let the run continue with the rest. A charge the server already
 * settled reads as resolved whatever the agent said, so a later allocation is
 * never overwritten by a stale "not found". `not_found` is searched-and-absent
 * (surfaced as an expected-order Problem); `needs_review` leaves one finding
 * naming the charge. Neither is resolved: the run ends in review and a restart
 * carries both forward.
 */
export async function settleChargeHunt(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    huntId: string;
    outcome: "not_found" | "needs_review";
    summary: string;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  assertRunActive(scope.public.status);
  const huntIds = await runChargeHuntIds(db, input.runId);
  if (!huntIds) throw new Error("Only a charge-search run has charge hunts");
  const huntId = z.uuid().parse(input.huntId);
  if (!huntIds.includes(huntId))
    throw new Error(`Charge hunt ${huntId} is not on this run`);
  const summary = z.string().trim().min(1).max(1_000).parse(input.summary);
  const runId = runEntityId.parse(input.runId);
  const fingerprint = await sha256Hex(`deferred-charge:${huntId}`);
  return withTransaction(db, async (tx) => {
    const [hunt] = await tx
      .select({
        state: importHunt.state,
        charge: financialTransaction.shortcode,
      })
      .from(importHunt)
      .innerJoin(
        financialTransaction,
        eq(financialTransaction.id, importHunt.financialTransactionId),
      )
      .where(eq(importHunt.id, huntId))
      .limit(1)
      .for("update", { of: importHunt });
    if (!hunt) throw new Error(`Charge hunt ${huntId} was not found`);
    // Decide on the allocation under the row lock, not before it.
    await resolveAllocatedChargeHunts(databaseForTransaction(tx), [huntId]);
    const [current] = await tx
      .select({ state: importHunt.state })
      .from(importHunt)
      .where(eq(importHunt.id, huntId));
    hunt.state = current?.state ?? hunt.state;
    const state =
      input.outcome === "not_found"
        ? CHARGE_HUNT_STATE.notFound
        : CHARGE_HUNT_STATE.deferred;
    // Replays and already-recorded outcomes are answered, not rewritten.
    if (hunt.state !== CHARGE_HUNT_STATE.queued)
      return { huntId, outcome: chargeHuntOutcomeOf(hunt.state) };
    await tx
      .update(importHunt)
      .set({ state, error: summary, updatedAt: new Date() })
      .where(eq(importHunt.id, huntId));
    if (input.outcome === "needs_review")
      await tx
        .insert(runFinding)
        .values({
          runId,
          ledgerPartyId: scope.ledgerPartyId,
          entityKind: "run",
          entityId: runId,
          kind: "other",
          summary: `Charge ${hunt.charge} needs review: ${summary}`,
          evidenceFingerprint: fingerprint,
        })
        .onConflictDoNothing();
    return { huntId, outcome: chargeHuntOutcomeOf(state) };
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
  // A backfill walks older history; only incremental runs own the
  // newest-order cursor, which therefore never rewinds or jumps.
  if (await runBackfillRange(db, input.runId)) return null;
  // A charge search imports what it was pointed at, not a listing prefix.
  if (await runChargeHuntIds(db, input.runId)) return null;
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

/**
 * A deferred order is not imported, so an account sync that deferred any
 * order must not read as a complete import; its finding names the order.
 */
async function accountSyncFinishStatus(db: Database, runId: RunId) {
  const huntIds = await runChargeHuntIds(db, runId);
  if (huntIds) {
    const [unresolved] = await getDb(db)
      .select({ value: count() })
      .from(importHunt)
      .where(
        and(
          inArray(importHunt.id, huntIds),
          sql`${importHunt.state} <> ${CHARGE_HUNT_STATE.resolved}`,
        ),
      );
    const [skipped] = await getDb(db)
      .select({ value: count() })
      .from(runOrderCandidate)
      .where(
        and(
          eq(runOrderCandidate.runId, runId),
          eq(runOrderCandidate.state, "skipped"),
        ),
      );
    return (unresolved?.value ?? 0) + (skipped?.value ?? 0) > 0
      ? "needs_review"
      : "completed";
  }
  const [deferred] = await getDb(db)
    .select({ value: count() })
    .from(runOrderCandidate)
    .where(
      and(
        eq(runOrderCandidate.runId, runId),
        eq(runOrderCandidate.state, "skipped"),
      ),
    );
  return (deferred?.value ?? 0) > 0 ? "needs_review" : "completed";
}

/** A single-confirmation mail run finishes only once its order is committed. */
async function assertSingleMailImported(db: Database, runId: RunId) {
  // A selected-orders run is gated by its pending candidates instead.
  const mail = await loadOrderMailImportEvidence(db, runId, {
    allowComplete: true,
  });
  if (mail && !mail.selected && !(await orderMailImportedPurchase(db, mail)))
    throw new Error(
      "Import run still has uncommitted order confirmation mail.",
    );
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
      await assertSingleMailImported(db, runId);
      const chargeHuntIds = await runChargeHuntIds(db, runId);
      if (chargeHuntIds) await resolveAllocatedChargeHunts(db, chargeHuntIds);
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
                // A charge run answers only for its own selection.
                chargeHuntIds
                  ? inArray(importHunt.id, chargeHuntIds)
                  : notHeldByChargeRun,
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
      const status = await accountSyncFinishStatus(db, runId);
      const auditedAt = new Date();
      await getDb(db)
        .update(runTable)
        .set({
          status,
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

/**  Called through the `PurchaseImportService` RPC namespace in cf-server.ts. */
export async function markRunFailed(
  db: Database,
  input: {
    runId: string;
    failureCode: "agent_failed" | "agent_aborted";
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
  if (run) await deferQueuedChargeHunts(db, runId, "Run failed");
  if (run?.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({ status: "active", updatedAt: new Date() })
      .where(sql`${vendorAccount.id} = ${run.vendorAccountId}`);
  }
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
        result: runOperation.result,
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
    loadPreparedReviewRows(db, run.id),
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
      .from(auditLog)
      .innerJoin(
        purchase,
        and(eq(purchase.id, auditLog.entityId), notDeleted(purchase)),
      )
      .where(
        and(eq(auditLog.runId, run.id), eq(auditLog.entityKind, "purchase")),
      ),
    database
      .select({
        id: runFinding.id,
        kind: runFinding.kind,
        summary: runFinding.summary,
        status: runFinding.status,
        proposedFix: runFinding.proposedFix,
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
        entityKind: runTarget.entityKind,
        entityCode: entityIdentity.shortcode,
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
      .leftJoin(entityIdentity, eq(entityIdentity.id, runTarget.entityId))
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
    restartInputs: agentImportRunPurpose.safeParse(header.purpose).success
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
            image: target.entityKind === "image" ? target.entityCode : null,
            purchase:
              target.entityKind === "purchase" ? target.entityCode : null,
            product: target.entityKind === "product" ? target.entityCode : null,
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
    operations: operations.map(({ result: _result, ...operation }) => ({
      ...operation,
      startedAt: operation.startedAt.toISOString(),
      completedAt: iso(operation.completedAt),
    })),
    preparedOrders: projectPreparedOrders(preparedOrders, operations),
    targets: targets.map((target) => ({
      id: target.id,
      targetType: target.entityKind,
      // Image targets have never carried a public code in the run detail.
      targetShortcode: target.entityKind === "image" ? null : target.entityCode,
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
      proposedFix:
        finding.proposedFix === null
          ? null
          : proposedImportFix.parse(finding.proposedFix),
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

/**
 * The queue event an approval decision delivers to its parked conversation.
 * Without it the coordinator only resumes when a member prompts it. A retry
 * signal is not fenced by the dispatch generation, and its id names the
 * decision so the agent reads the persisted approval before continuing.
 */
export function approvalWakeEvent(
  control: Awaited<ReturnType<typeof controlRun>>,
): Extract<PurchaseAgentEvent, { type: "retry" }> | null {
  if (!("wakeRunId" in control) || !control.wakeRunId) return null;
  return {
    version: 1,
    runId: control.wakeRunId,
    eventId: `approval:${control.approvalId}:${control.decision}`,
    type: "retry",
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
    const checksum = await sha256Hex(bytes);
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
          input: runTable.input,
          skillRevision: runTable.skillRevision,
          runtimeRevision: runTable.runtimeRevision,
          dispatchEventId: runTable.dispatchEventId,
          coordinatorStartedAt: runTable.coordinatorStartedAt,
          decisionRevision: runTable.decisionRevision,
          historyCursorUrl: runTable.historyCursorUrl,
        })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .limit(1)
        // A key-preserving lock: this transaction also touches child rows
        // whose foreign keys share-lock the Run, so a full lock could deadlock.
        .for("no key update");
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
        if (!agentImportRunPurpose.safeParse(locked.purpose).success)
          throw new Error("Only agent import runs can be started again");
        const sourceTargets = (
          await selectRestartTargets(tx, scope.public.runId)
        ).map((target) => ({
          entityId: target.entityId,
          entityKind: target.entityKind,
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
          sourceTargets.some((target) => target.entityKind !== "image")
        )
          throw new Error("Photo run inputs are incomplete");
        if (
          locked.purpose === "account_sync" &&
          !locked.vendorAccountId &&
          !orderMailImportRunInput.safeParse(locked.input).success
        )
          throw new Error(
            "This account run has no vendor account to start again",
          );
        const restartCharges = chargeHuntRunInput.safeParse(locked.input);
        let carriedChargeHuntIds: string[] = [];
        if (locked.vendorAccountId) {
          // Same admission fence as starting a run on this account.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${locked.vendorAccountId}))`,
          );
          if (!restartCharges.success)
            await assertNoHoldingChargeRun(tx, locked.vendorAccountId);
        }
        if (restartCharges.success && locked.vendorAccountId) {
          const [active] = await tx
            .select({ shortcode: runTable.shortcode })
            .from(runTable)
            .where(
              and(
                eq(runTable.vendorAccountId, locked.vendorAccountId),
                inArray(runTable.status, [...CHARGE_HOLDING_STATUSES]),
                ne(runTable.id, scope.public.runId),
              ),
            )
            .limit(1);
          if (active)
            throw new Error(
              `Vendor account already has an active import run (${active.shortcode}); finish or stop it before restarting`,
            );
          // Carry only unresolved charges that no other unfinished run holds.
          const carried = await tx
            .select({ id: importHunt.id })
            .from(importHunt)
            .where(
              and(
                inArray(importHunt.id, restartCharges.data.huntIds),
                inArray(importHunt.state, [
                  CHARGE_HUNT_STATE.queued,
                  CHARGE_HUNT_STATE.deferred,
                  CHARGE_HUNT_STATE.notFound,
                ]),
                sql`NOT ${unfinishedChargeRunOwns({
                  exceptRunId: scope.public.runId,
                  includeReview: true,
                })}`,
              ),
            );
          carriedChargeHuntIds = carried.map((hunt) => hunt.id);
          if (carriedChargeHuntIds.length === 0)
            throw new Error(
              "This charge search has no unresolved charges to carry; select charges again",
            );
        }
        const successorId = runEntityId.parse(crypto.randomUUID());
        const dispatchEventId = crypto.randomUUID();
        // An unfinished backfill resumes from the history page it reached; a
        // completed one, or an incremental sync, walks from the newest page.
        const backfill = orderBackfillRunInput.safeParse(locked.input).success;
        const resumeHistoryUrl =
          backfill && locked.status !== "completed"
            ? locked.historyCursorUrl
            : null;
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
          predecessorRunId: scope.public.runId,
          purpose: locked.purpose,
          trigger: backfill ? "backfill" : "manual",
          notes: locked.notes,
          input: restartCharges.success
            ? chargeHuntRunInput.parse({
                kind: "charge_hunts",
                huntIds: carriedChargeHuntIds,
              })
            : locked.input,
          historyCursorUrl: resumeHistoryUrl,
          coordinatorModel: coordinatorModelFor(locked.purpose),
          skillRevision: locked.skillRevision,
          runtimeRevision: locked.runtimeRevision,
          dispatchEventId,
          agentSessionId: importRunAgentIdentity(
            successorId,
            agentImportRunPurpose.parse(locked.purpose),
          ),
        });
        if (sourceTargets.length)
          await tx.insert(runTarget).values(
            sourceTargets.map((target) => ({
              ...target,
              runId: successorId,
              state: "pending" as const,
            })),
          );
        if (locked.purpose === "account_sync") {
          // Listed orders the predecessor never imported (still pending, or
          // deferred for review) are the successor's first work, so resuming
          // from a later history page cannot lose them.
          const unfinished = await tx
            .select({
              orderId: runOrderCandidate.orderId,
              orderUrl: runOrderCandidate.orderUrl,
              orderedAt: runOrderCandidate.orderedAt,
            })
            .from(runOrderCandidate)
            .where(
              and(
                eq(runOrderCandidate.runId, scope.public.runId),
                inArray(runOrderCandidate.state, ["pending", "skipped"]),
              ),
            );
          if (unfinished.length)
            await tx.insert(runOrderCandidate).values(
              unfinished.map((order) => ({
                ...order,
                runId: successorId,
                state: "pending" as const,
              })),
            );
          // Selected charges the predecessor never resolved (still queued,
          // deferred, or not found) are searched again; a resolved one stays.
          if (carriedChargeHuntIds.length > 0)
            await tx
              .update(importHunt)
              .set({
                state: CHARGE_HUNT_STATE.queued,
                error: null,
                attempts: sql`${importHunt.attempts} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  inArray(importHunt.id, carriedChargeHuntIds),
                  inArray(importHunt.state, [
                    CHARGE_HUNT_STATE.queued,
                    CHARGE_HUNT_STATE.deferred,
                    CHARGE_HUNT_STATE.notFound,
                  ]),
                ),
              );
        }
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: successorId,
          successorRunPublicId: successor.shortcode,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          created: true,
          dispatchRunId: successorId,
          dispatchPublicId: successor.shortcode,
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
          locked.vendorAccountId &&
          !chargeHuntRunInput.safeParse(locked.input).success
        ) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${locked.vendorAccountId}))`,
          );
          await assertNoHoldingChargeRun(tx, locked.vendorAccountId);
        }
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
            entityId: runTarget.entityId,
            entityKind: runTarget.entityKind,
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
        if (sourceTargets.some((target) => target.entityKind !== "purchase"))
          throw new Error("Purchase validation runs require Purchase targets");

        const successorId = runEntityId.parse(crypto.randomUUID());
        const isUnavailable = input.action === "no_evidence_available";
        const dispatchEventId = isUnavailable ? null : crypto.randomUUID();
        const successor = await insertWithShortcode(tx, "run", {
          id: successorId,
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
        });
        await tx.insert(runTarget).values(
          await Promise.all(
            sourceTargets.map(async (target) => ({
              runId: successorId,
              entityId: target.entityId,
              entityKind: target.entityKind,
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
          successorRunPublicId: successor.shortcode,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          dispatchRunId: null,
          dispatchPublicId: successor.shortcode,
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
          predecessorRunId: scope.public.runId,
          purpose: locked.purpose,
          trigger: locked.trigger,
          input: locked.input,
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
        if (locked.purpose !== "account_sync") {
          const unresolvedTargets = await tx
            .select({
              entityId: runTarget.entityId,
              entityKind: runTarget.entityKind,
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
          successorRunPublicId: successor.shortcode,
          successorStatus: successor.status,
          successorCoordinatorModel: coordinatorModelFor(locked.purpose),
          created: true,
          dispatchRunId: successorId,
          dispatchPublicId: successor.shortcode,
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
        await deferQueuedChargeHunts(
          databaseForTransaction(tx),
          scope.public.runId,
          "Run cancelled by its owner",
        );
        await tx
          .update(runApproval)
          .set({ state: "invalidated", invalidatedAt: new Date() })
          .where(
            and(
              eq(runApproval.runId, scope.public.runId),
              inArray(runApproval.state, ["pending", "granted"]),
            ),
          );
        await failOperationsForRun(
          tx,
          scope.public.runId,
          dispatchAbort
            ? "Dispatch aborted by its owner"
            : "Run cancelled by its owner",
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
      const operationKey = {
        runId: scope.public.runId,
        operationId: input.operationId,
      };
      const operation = await readOperation(tx, operationKey, {
        forUpdate: true,
      });
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
        await failOperation(
          tx,
          operationKey,
          "Mutation proposal rejected by a household member",
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
          wakeRunId: scope.public.runId,
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
          await failOperation(
            tx,
            operationKey,
            "Mutation target changed after proposal",
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
            wakeRunId: scope.public.runId,
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
      await setOperationResult(tx, operationKey, {
        ...z.record(z.string(), z.unknown()).parse(operation.result),
        approvalId,
      });
      return {
        publicId: input.runPublicId,
        status: "paused_approval" as const,
        approvalId,
        decision: "approved" as const,
        wakeRunId: scope.public.runId,
      };
    },
  );
}
