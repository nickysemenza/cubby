import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  ledgerPartyId,
  purchaseId,
  userId,
  vendorAccountId,
  type LedgerPartyId,
  type VendorAccountId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  browserBridgeOperation,
  browserBridgeRequest,
  browserCapture,
  importRunPublicId,
  importRunTrigger,
  purchaseImportRunScope,
  type BrowserBridgeOperation,
  type ImportRunTrigger,
} from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
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
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  financialTransaction,
  financialTransactionAllocation,
  aiUsage,
  importFinding,
  importHunt,
  importRun,
  importRunApproval,
  importRunControlEvent,
  importRunOperation,
  importRunProgress,
  importPreparedLine,
  importPreparedOrder,
  ledgerParty,
  purchase,
  vendor,
  vendorAccount,
  expense,
  purchasePaymentEvidence,
  importRunMutation,
  product,
  productExternalId,
  productImage,
  user,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

import type { PurchaseImportDurableObjectRpc } from "./contracts";
import { resolveImportFinding } from "./findings";
import { attachPendingOrderMailEvidence } from "./gmail/process";
import { loadReceiptEvidenceForRun } from "./receipt-evidence";
import { mintImportRunPublicId } from "./run-identifiers";
import { importVendorOrder } from "./writer";

const ACTIVE_RUN_STATUSES = [
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
] as const;

const OFFLINE_EXPIRY_MS = 24 * 60 * 60_000;

const usageCursorSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

const encodeUsageCursor = (value: z.infer<typeof usageCursorSchema>) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decodeUsageCursor = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return usageCursorSchema.parse(JSON.parse(atob(padded)));
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

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
  },
  work: () => Promise<T>,
): Promise<T> {
  const runId = z.uuid().parse(input.runId);
  const fingerprint = await sha256(JSON.stringify(input.payload));
  const database = getDb(db);
  const [inserted] = await database
    .insert(importRunOperation)
    .values({
      runId,
      operationId: input.operationId,
      kind: input.kind,
      inputFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: importRunOperation.id });
  if (!inserted) {
    const [recorded] = await database
      .select({
        inputFingerprint: importRunOperation.inputFingerprint,
        state: importRunOperation.state,
        result: importRunOperation.result,
        updatedAt: importRunOperation.updatedAt,
      })
      .from(importRunOperation)
      .where(
        and(
          eq(importRunOperation.runId, runId),
          eq(importRunOperation.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (!recorded || recorded.inputFingerprint !== fingerprint)
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
    await database
      .update(importRunOperation)
      .set({ state: "started", error: null, updatedAt: new Date() })
      .where(
        and(
          eq(importRunOperation.runId, runId),
          eq(importRunOperation.operationId, input.operationId),
        ),
      );
  }
  try {
    const result = await work();
    await database
      .update(importRunOperation)
      .set({
        state: "completed",
        result,
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRunOperation.runId, runId),
          eq(importRunOperation.operationId, input.operationId),
        ),
      );
    return result;
  } catch (error) {
    await database
      .update(importRunOperation)
      .set({
        state: "failed",
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "unknown",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRunOperation.runId, runId),
          eq(importRunOperation.operationId, input.operationId),
        ),
      );
    throw error;
  }
}

const operationUuid = async (runId: string, operationId: string) => {
  const hex = await sha256(`${runId}:${operationId}`);
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

export async function startOrResumeImportRun(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorAccountId: VendorAccountId;
    trigger: ImportRunTrigger;
    predecessorRunId?: string;
    coordinatorModel?: string;
    skillRevision?: string;
    runtimeRevision?: string;
  },
) {
  const trigger = importRunTrigger.parse(input.trigger);
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
        id: importRun.id,
        publicId: importRun.publicId,
        status: importRun.status,
      })
      .from(importRun)
      .where(
        and(
          eq(importRun.vendorAccountId, input.vendorAccountId),
          inArray(importRun.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (existing) return { ...existing, created: false };
    const id = crypto.randomUUID();
    let created: { id: string; publicId: string; status: string } | undefined;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      [created] = await tx
        .insert(importRun)
        .values({
          id,
          publicId: mintImportRunPublicId(),
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
            ? z.uuid().parse(input.predecessorRunId)
            : null,
          trigger,
          coordinatorModel: input.coordinatorModel ?? "gpt-5.6-terra",
          skillRevision: input.skillRevision ?? "purchase-import@1",
          runtimeRevision: input.runtimeRevision ?? "flue@1",
          agentSessionId: `import-run:${id}`,
        })
        .onConflictDoNothing()
        .returning({
          id: importRun.id,
          publicId: importRun.publicId,
          status: importRun.status,
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

export async function loadRunScope(db: Database, runId: string) {
  const parsedRunId = z.uuid().parse(runId);
  const [row] = await getDb(db)
    .select({
      runId: importRun.id,
      publicId: importRun.publicId,
      agentId: importRun.agentSessionId,
      trigger: importRun.trigger,
      status: importRun.status,
      vendorAccountId: importRun.vendorAccountId,
      vendorId: sql<VendorId | null>`coalesce(${importRun.vendorId}, ${vendor.id})`,
      vendorLabel: vendorAccount.label,
      allowedHosts: vendor.browserDomains,
      navigationHints: vendor.agentHints,
      cursor: vendorAccount.cursor,
      website: vendor.website,
      ledgerPartyId: importRun.ledgerPartyId,
      actorUserId: importRun.actorUserId,
      coordinatorModel: importRun.coordinatorModel,
      skillRevision: importRun.skillRevision,
      runtimeRevision: importRun.runtimeRevision,
      runUpdatedAt: importRun.updatedAt,
    })
    .from(importRun)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importRun.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(
        or(
          eq(vendor.id, importRun.vendorId),
          eq(vendor.id, vendorAccount.vendorId),
        ),
        notDeleted(vendor),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(eq(ledgerParty.id, importRun.ledgerPartyId), notDeleted(ledgerParty)),
    )
    .where(eq(importRun.id, parsedRunId))
    .limit(1);
  if (!row || !row.agentId || !row.actorUserId)
    throw new Error("Import run ownership is unavailable");
  return {
    public: purchaseImportRunScope.parse({
      runId: row.runId,
      publicId: row.publicId,
      agentId: row.agentId,
      trigger: row.trigger,
      status: row.status,
      vendorAccountId: row.vendorAccountId,
      vendorLabel: row.vendorLabel,
      allowedHosts: row.allowedHosts ?? [],
      navigationHints: row.navigationHints,
      coordinatorModel: row.coordinatorModel,
      skillRevision: row.skillRevision,
      runtimeRevision: row.runtimeRevision,
    }),
    website: row.website,
    cursor: row.cursor,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    actorUserId: row.actorUserId,
    runUpdatedAt: row.runUpdatedAt,
  };
}

export async function loadRunScopeByPublicId(db: Database, publicId: string) {
  const parsedPublicId = importRunPublicId.parse(publicId);
  const [row] = await getDb(db)
    .select({ id: importRun.id })
    .from(importRun)
    .where(eq(importRun.publicId, parsedPublicId))
    .limit(1);
  if (!row) throw new Error("Purchase import run was not found");
  return loadRunScope(db, row.id);
}

const agentProgressInput = z.object({
  runId: z.uuid(),
  eventId: z.string().trim().min(1).max(256),
  phase: z.string().trim().min(1).max(200),
  currentItem: z.string().trim().min(1).max(500).optional(),
  awaitingApproval: z.boolean().optional(),
  detail: z.string().trim().min(1).max(2_000).optional(),
});

export async function updateAgentProgress(
  db: Database,
  rawInput: z.input<typeof agentProgressInput>,
) {
  const input = agentProgressInput.parse(rawInput);
  const [inserted] = await getDb(db)
    .insert(importRunProgress)
    .values({
      runId: input.runId,
      eventId: input.eventId,
      phase: input.phase,
      currentItem: input.currentItem,
      awaitingApproval: input.awaitingApproval ?? false,
      detail: input.detail,
    })
    .onConflictDoNothing()
    .returning({ id: importRunProgress.id });
  return { recorded: Boolean(inserted) };
}

export async function listImportRunProgress(db: Database, runId: string) {
  return getDb(db)
    .select({
      eventId: importRunProgress.eventId,
      phase: importRunProgress.phase,
      currentItem: importRunProgress.currentItem,
      awaitingApproval: importRunProgress.awaitingApproval,
      detail: importRunProgress.detail,
      createdAt: importRunProgress.createdAt,
    })
    .from(importRunProgress)
    .where(eq(importRunProgress.runId, z.uuid().parse(runId)))
    .orderBy(asc(importRunProgress.createdAt), asc(importRunProgress.id));
}

export async function latestImportRunProgress(db: Database, runId: string) {
  const [latest] = await getDb(db)
    .select({
      eventId: importRunProgress.eventId,
      phase: importRunProgress.phase,
      currentItem: importRunProgress.currentItem,
      awaitingApproval: importRunProgress.awaitingApproval,
      detail: importRunProgress.detail,
      createdAt: importRunProgress.createdAt,
    })
    .from(importRunProgress)
    .where(eq(importRunProgress.runId, z.uuid().parse(runId)))
    .orderBy(desc(importRunProgress.createdAt), desc(importRunProgress.id))
    .limit(1);
  return latest ?? null;
}

export async function pauseImportRunForAuthorization(
  db: Database,
  runId: string,
) {
  const [run] = await getDb(db)
    .update(importRun)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(importRun.id, z.uuid().parse(runId)),
        eq(importRun.status, "running"),
      ),
    )
    .returning({ publicId: importRun.publicId });
  return run ?? null;
}

export async function resumeAuthorizedImportRuns(
  db: Database,
  actorUserId: string,
) {
  return getDb(db)
    .update(importRun)
    .set({ status: "running", updatedAt: new Date() })
    .where(
      and(
        eq(importRun.actorUserId, userId.parse(actorUserId)),
        eq(importRun.status, "paused_auth"),
      ),
    )
    .returning({ id: importRun.id, publicId: importRun.publicId });
}

export async function pauseAuthorizedImportRuns(
  db: Database,
  actorUserId: string,
) {
  return getDb(db)
    .update(importRun)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(importRun.actorUserId, userId.parse(actorUserId)),
        eq(importRun.status, "running"),
      ),
    )
    .returning({ id: importRun.id });
}

export async function expireOfflineImportRuns(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - OFFLINE_EXPIRY_MS);
  const expired = await getDb(db)
    .update(importRun)
    .set({
      status: "failed",
      failureCode: "offline_expired",
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(importRun.status, "paused_offline"),
        lt(importRun.updatedAt, cutoff),
      ),
    )
    .returning({ id: importRun.id });
  return { expired: expired.length };
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
  if (!scope.public.vendorAccountId || !scope.vendorId)
    return { kind: "none" as const };
  if (scope.public.status === "paused_approval")
    return { kind: "paused_approval" as const };
  if (
    scope.public.status === "paused_auth" ||
    scope.public.status === "paused_offline"
  ) {
    const connected = await namespace
      .getByName(scope.public.vendorAccountId)
      .connected();
    if (!connected) {
      if (
        scope.public.status === "paused_offline" &&
        Date.now() - scope.runUpdatedAt.getTime() >= OFFLINE_EXPIRY_MS
      ) {
        await getDb(db)
          .update(importRun)
          .set({
            status: "failed",
            failureCode: "offline_expired",
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(importRun.id, scope.public.runId),
              eq(importRun.status, "paused_offline"),
            ),
          );
        return { kind: "failed" as const, failureCode: "offline_expired" };
      }
      return { kind: "paused_offline" as const };
    }
    await getDb(db)
      .update(importRun)
      .set({ status: "running", failureCode: null, updatedAt: new Date() })
      .where(eq(importRun.id, scope.public.runId));
  } else {
    assertRunActive(scope.public.status);
  }
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
  const [enrichment] = await getDb(db)
    .selectDistinct({
      productId: product.id,
      productName: product.name,
      startUrl: productExternalId.url,
    })
    .from(importRunMutation)
    .innerJoin(
      product,
      and(eq(product.id, importRunMutation.targetId), notDeleted(product)),
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
      productImage,
      and(eq(productImage.productId, product.id), notDeleted(productImage)),
    )
    .where(
      and(
        eq(importRunMutation.runId, scope.public.runId),
        eq(importRunMutation.targetType, "product"),
        isNull(productImage.id),
      ),
    )
    .limit(1);
  if (enrichment?.startUrl)
    return { kind: "product_enrichment" as const, ...enrichment };
  const [scanFinished] = await getDb(db)
    .select({ id: importRunOperation.id })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, scope.public.runId),
        eq(importRunOperation.kind, "mark_history_expired"),
        eq(importRunOperation.state, "completed"),
      ),
    )
    .limit(1);
  if (scanFinished) return { kind: "none" as const };
  return startUrl
    ? { kind: "cursor_walk" as const, startUrl }
    : { kind: "none" as const };
}

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
  const scopedOperation =
    operation.type === "navigate"
      ? { ...operation, allowedHosts }
      : operation.type === "follow_captured_link"
        ? { ...operation, allowedHosts }
        : operation.type === "capture"
          ? { ...operation, allowedHosts }
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
  const fingerprint = await sha256(
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
      inputFingerprint: importRunOperation.inputFingerprint,
      result: importRunOperation.result,
    })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, z.uuid().parse(input.runId)),
        eq(importRunOperation.operationId, input.operationId),
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
    await database.insert(importRunOperation).values({
      runId: z.uuid().parse(input.runId),
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
        .update(importRun)
        .set({ status: "paused_offline", updatedAt: new Date() })
        .where(eq(importRun.id, z.uuid().parse(input.runId))),
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
    .update(importRunOperation)
    .set({
      state: "completed",
      result: { command, commandId },
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importRunOperation.runId, z.uuid().parse(input.runId)),
        eq(importRunOperation.operationId, input.operationId),
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
    .select({ result: importRunOperation.result })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, z.uuid().parse(input.runId)),
        eq(importRunOperation.operationId, input.operationId),
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
        .update(importRun)
        .set({
          status: authRequired ? "paused_auth" : "paused_offline",
          failureCode: result.outcome.code,
          updatedAt: new Date(),
        })
        .where(eq(importRun.id, scope.public.runId));
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
  }
  return result
    ? { state: "completed" as const, result }
    : { state: "pending" as const, commandId: parsed.data.commandId };
}

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
    .select({ result: importRunOperation.result })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, z.uuid().parse(input.runId)),
        eq(importRunOperation.kind, "browser_command"),
      ),
    );
  const commandBelongsToRun = commandOperations.some(({ result }) => {
    const parsed = z.object({ commandId: z.uuid() }).safeParse(result);
    return parsed.success && parsed.data.commandId === commandId;
  });
  if (!commandBelongsToRun)
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
  const [enrichmentTarget] = await getDb(db)
    .selectDistinct({ id: product.id, shortcode: product.shortcode })
    .from(importRunMutation)
    .innerJoin(
      product,
      and(eq(product.id, importRunMutation.targetId), notDeleted(product)),
    )
    .innerJoin(
      productExternalId,
      and(
        eq(productExternalId.productId, product.id),
        eq(productExternalId.url, capture.sourceURL),
        notDeleted(productExternalId),
      ),
    )
    .leftJoin(
      productImage,
      and(eq(productImage.productId, product.id), notDeleted(productImage)),
    )
    .where(
      and(
        eq(importRunMutation.runId, z.uuid().parse(input.runId)),
        eq(importRunMutation.targetType, "product"),
        isNull(productImage.id),
      ),
    )
    .limit(1);
  const enrichmentImage = capture.images[0]?.url;
  if (enrichmentTarget && enrichmentImage) {
    const { attachFileToEntity } =
      await import("~/server/services/image-storage.service");
    const attached = await attachFileToEntity(db, {
      entityType: "product",
      entityId: enrichmentTarget.shortcode,
      url: enrichmentImage,
      expectedImageCount: 0,
      idempotencyKey: `purchase-import-enrichment:${input.runId}:${enrichmentTarget.id}`,
    });
    return {
      kind: "product_enrichment" as const,
      productId: enrichmentTarget.id,
      imageId: attached.imageId,
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
  const stableEvidence = {
    sourceURL: capture.sourceURL,
    title: capture.title,
    readableText: capture.readableText,
    links: capture.links.map(({ url, label }) => ({ url, label })),
    images: capture.images.map(({ url, alt }) => ({ url, alt })),
  };
  const checksum = await sha256(JSON.stringify(stableEvidence));
  const writeResult = await importVendorOrder(
    db,
    {
      runId: z.uuid().parse(input.runId),
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
  const actor = buildActorContext(scope.actorUserId, "api");
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
  const runId = z.uuid().parse(input.runId);
  const importedPurchases = await getDb(db)
    .selectDistinct({
      id: purchase.id,
      orderId: purchase.orderId,
      statedTotal: purchase.statedTotal,
      displayLabel: purchase.displayLabel,
    })
    .from(importRunMutation)
    .innerJoin(
      purchase,
      and(eq(purchase.id, importRunMutation.targetId), notDeleted(purchase)),
    )
    .where(
      and(
        eq(importRunMutation.runId, runId),
        eq(importRunMutation.targetType, "purchase"),
      ),
    )
    .orderBy(asc(purchase.id))
    .limit(25)
    .offset(z.number().int().nonnegative().parse(input.offset));
  if (importedPurchases.length === 0) return { findings: 0, nextOffset: null };
  const purchaseIds = importedPurchases.map(({ id }) => id);
  const [expenseRows, paymentRows] = await Promise.all([
    getDb(db)
      .select({
        purchaseId: expense.purchaseId,
        id: expense.id,
        name: expense.name,
        amount: expense.cost,
        lineKind: expense.lineKind,
        quantity: expense.productQuantity,
        productId: product.id,
        productName: product.name,
        productManufacturer: product.manufacturer,
        productModel: product.model,
      })
      .from(expense)
      .leftJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .where(
        and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)),
      ),
    getDb(db)
      .select({
        purchaseId: purchasePaymentEvidence.purchaseId,
        amount: purchasePaymentEvidence.amount,
        chargedAt: purchasePaymentEvidence.chargedAt,
        cardLastFour: purchasePaymentEvidence.cardLastFour,
        description: purchasePaymentEvidence.description,
      })
      .from(purchasePaymentEvidence)
      .where(inArray(purchasePaymentEvidence.purchaseId, purchaseIds)),
  ]);
  const renderedBatch = importedPurchases.map((row) => ({
    ...row,
    expenses: expenseRows
      .filter((expenseRow) => expenseRow.purchaseId === row.id)
      .map((expenseRow) => ({
        id: expenseRow.id,
        name: expenseRow.name,
        amount: expenseRow.amount,
        lineKind: expenseRow.lineKind,
        quantity: expenseRow.quantity,
        product: expenseRow.productId
          ? {
              id: expenseRow.productId,
              name: expenseRow.productName,
              manufacturer: expenseRow.productManufacturer,
              model: expenseRow.productModel,
            }
          : null,
      })),
    paymentEvidence: paymentRows
      .filter((payment) => payment.purchaseId === row.id)
      .map(({ purchaseId: _purchaseId, ...payment }) => payment),
  }));
  const { auditPurchaseImportBatch } =
    await import("~/server/agents/purchase-import/extract");
  const audit = await auditPurchaseImportBatch({
    db,
    runId: input.runId,
    renderedBatch,
  });
  const actor = buildActorContext(scope.actorUserId, "api");
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
    const evidenceFingerprint = await sha256(JSON.stringify(finding));
    const [inserted] = await getDb(db)
      .insert(importFinding)
      .values({
        importRunId: runId,
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
      .returning({ id: importFinding.id });
    if (!inserted) continue;
    stored += 1;
    if (
      finding.probability >= 0.95 &&
      finding.proposedFix?.kind === "relink_product"
    ) {
      try {
        await resolveImportFinding(
          db,
          { id: inserted.id, action: "apply" },
          actor,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Automated fix was refused";
        await getDb(db)
          .update(importFinding)
          .set({
            summary: `${finding.summary} Auto-fix refused: ${detail}`.slice(
              0,
              1_000,
            ),
            proposedFix: null,
            updatedAt: new Date(),
          })
          .where(eq(importFinding.id, inserted.id));
      }
    }
  }
  return {
    findings: stored,
    nextOffset: importedPurchases.length === 25 ? input.offset + 25 : null,
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

export async function stopImportRunForReview(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    summary: string;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  const runId = z.uuid().parse(input.runId);
  const summary = z.string().trim().min(1).max(1_000).parse(input.summary);
  const kind = z
    .enum([
      "auth_required",
      "expected_order_not_found",
      "unclassified_vendor",
      "other",
    ])
    .parse(input.kind);
  const fingerprint = await sha256(`${kind}:${summary}`);
  await auditAllImportBatches(db, {
    runId: input.runId,
    operationId: `${input.operationId}:required-audit`,
  });
  const auditedAt = new Date();
  return withTransaction(db, async (tx) => {
    if (scope.public.status !== "needs_review")
      assertRunActive(scope.public.status);
    const [finding] = await tx
      .insert(importFinding)
      .values({
        importRunId: runId,
        ledgerPartyId: scope.ledgerPartyId,
        targetType: "import_run",
        targetId: runId,
        kind,
        summary,
        evidenceFingerprint: fingerprint,
      })
      .onConflictDoNothing()
      .returning({ id: importFinding.id });
    const [existingFinding] = finding
      ? []
      : await tx
          .select({ id: importFinding.id })
          .from(importFinding)
          .where(
            and(
              eq(importFinding.importRunId, runId),
              eq(importFinding.targetType, "import_run"),
              eq(importFinding.targetId, runId),
              eq(importFinding.kind, kind),
              eq(importFinding.evidenceFingerprint, fingerprint),
              eq(importFinding.status, "open"),
            ),
          )
          .limit(1);
    if (scope.public.vendorAccountId) {
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
    await tx
      .update(importRun)
      .set({
        status: "needs_review",
        auditedAt,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRun.id, runId),
          inArray(importRun.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    return { findingId: finding?.id ?? existingFinding?.id ?? null };
  });
}

export async function finishImportRun(
  db: Database,
  namespace: PurchaseImportNamespace,
  input: { runId: string; operationId: string },
) {
  const scope = await loadRunScope(db, input.runId);
  const runId = z.uuid().parse(input.runId);
  if (scope.public.status !== "completed") {
    assertRunActive(scope.public.status);
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

    await auditAllImportBatches(db, {
      runId: input.runId,
      operationId: `${input.operationId}:audit`,
    });
    const auditedAt = new Date();
    await getDb(db)
      .update(importRun)
      .set({
        status: "completed",
        auditedAt,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRun.id, runId),
          sql`${importRun.status} IN ('running', 'paused_auth', 'paused_offline')`,
        ),
      );
  }
  const [run] = await getDb(db)
    .select({
      imported: importRun.imported,
      updated: importRun.updated,
      skipped: importRun.skipped,
    })
    .from(importRun)
    .where(eq(importRun.id, runId))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const [findingCount] = await getDb(db)
    .select({ value: count() })
    .from(importFinding)
    .where(
      and(
        eq(importFinding.importRunId, runId),
        eq(importFinding.status, "open"),
      ),
    );
  if (scope.public.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({
        status: "active",
        lastSuccessAt: new Date(),
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
      ...run,
      findingCount: findingCount?.value ?? 0,
    });
  }
  return { ...run, findingCount: findingCount?.value ?? 0 };
}

export async function markImportRunFailed(
  db: Database,
  input: {
    runId: string;
    failureCode: "flue_failed" | "flue_aborted";
    detail?: string;
  },
) {
  const runId = z.uuid().parse(input.runId);
  const [run] = await getDb(db)
    .update(importRun)
    .set({
      status: "failed",
      failureCode: input.failureCode,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(importRun.id, runId), eq(importRun.status, "running")))
    .returning({ vendorAccountId: importRun.vendorAccountId });
  if (run?.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({ status: "active", updatedAt: new Date() })
      .where(sql`${vendorAccount.id} = ${run.vendorAccountId}`);
  }
  return { failed: Boolean(run), detail: input.detail ?? null };
}

export async function loadImportRunByPublicId(
  db: Database,
  actor: ActorContext,
  rawPublicId: string,
  options: { usageCursor?: string; usageLimit?: number } = {},
) {
  const publicId = importRunPublicId.parse(rawPublicId);
  const database = getDb(db);
  const [run] = await database
    .select({
      id: importRun.id,
      publicId: importRun.publicId,
      ledgerPartyId: importRun.ledgerPartyId,
      actorUserId: importRun.actorUserId,
      predecessorRunId: importRun.predecessorRunId,
      vendorAccountId: importRun.vendorAccountId,
      vendorAccountShortcode: vendorAccount.shortcode,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: importRun.trigger,
      status: importRun.status,
      coordinatorModel: importRun.coordinatorModel,
      skillRevision: importRun.skillRevision,
      runtimeRevision: importRun.runtimeRevision,
      decisionRevision: importRun.decisionRevision,
      startedAt: importRun.startedAt,
      endedAt: importRun.endedAt,
      auditedAt: importRun.auditedAt,
      ordersSeen: importRun.ordersSeen,
      imported: importRun.imported,
      updated: importRun.updated,
      skipped: importRun.skipped,
      failureCode: importRun.failureCode,
      actorName: importRun.actorName,
      actorEmail: importRun.actorEmail,
      actorLedgerPartyShortcode: importRun.actorLedgerPartyShortcode,
      actorLedgerPartyName: importRun.actorLedgerPartyName,
      actorLedgerPartyKind: importRun.actorLedgerPartyKind,
      controllerPartyShortcode: ledgerParty.shortcode,
      controllerPartyName: ledgerParty.name,
      controllerPartyKind: ledgerParty.kind,
    })
    .from(importRun)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importRun.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .where(eq(importRun.publicId, publicId))
    .limit(1);
  if (!run) throw new Error("Purchase import run was not found");

  const usageLimit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.usageLimit ?? 25);
  const usageCursor = options.usageCursor
    ? decodeUsageCursor(options.usageCursor)
    : null;
  const [
    predecessor,
    successor,
    operations,
    approvals,
    preparedOrders,
    progress,
    affectedPurchases,
    findings,
    usageTotals,
    usageRows,
    controlHistory,
  ] = await Promise.all([
    run.predecessorRunId
      ? database
          .select({ publicId: importRun.publicId })
          .from(importRun)
          .where(eq(importRun.id, run.predecessorRunId))
          .limit(1)
      : Promise.resolve([]),
    database
      .select({ publicId: importRun.publicId })
      .from(importRun)
      .where(eq(importRun.predecessorRunId, run.id))
      .orderBy(desc(importRun.startedAt))
      .limit(1),
    database
      .select({
        id: importRunOperation.id,
        operationId: importRunOperation.operationId,
        kind: importRunOperation.kind,
        state: importRunOperation.state,
        result: importRunOperation.result,
        error: importRunOperation.error,
        startedAt: importRunOperation.startedAt,
        completedAt: importRunOperation.completedAt,
      })
      .from(importRunOperation)
      .where(eq(importRunOperation.runId, run.id))
      .orderBy(asc(importRunOperation.startedAt)),
    database
      .select({
        id: importRunApproval.id,
        operationId: importRunApproval.operationId,
        operationKind: importRunApproval.operationKind,
        args: importRunApproval.args,
        state: importRunApproval.state,
        createdAt: importRunApproval.createdAt,
        decidedByUserId: importRunApproval.decidedByUserId,
        decidedAt: importRunApproval.decidedAt,
        rejectedAt: importRunApproval.rejectedAt,
        consumedAt: importRunApproval.consumedAt,
        invalidatedAt: importRunApproval.invalidatedAt,
      })
      .from(importRunApproval)
      .where(eq(importRunApproval.runId, run.id))
      .orderBy(asc(importRunApproval.createdAt)),
    database
      .select({
        id: importPreparedOrder.id,
        stableOrderId: importPreparedOrder.stableOrderId,
        itemOperationId: importPreparedOrder.itemOperationId,
        prepareOperationId: importPreparedOrder.prepareOperationId,
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
    listImportRunProgress(db, run.id),
    database
      .selectDistinct({
        id: purchase.shortcode,
        displayLabel: purchase.displayLabel,
        orderId: purchase.orderId,
      })
      .from(importRunMutation)
      .innerJoin(
        purchase,
        and(eq(purchase.id, importRunMutation.targetId), notDeleted(purchase)),
      )
      .where(
        and(
          eq(importRunMutation.runId, run.id),
          eq(importRunMutation.targetType, "purchase"),
        ),
      ),
    database
      .select({
        id: importFinding.id,
        kind: importFinding.kind,
        summary: importFinding.summary,
        status: importFinding.status,
        autoApplied: importFinding.autoApplied,
        probability: importFinding.probability,
        createdAt: importFinding.createdAt,
        expiresAt: importFinding.expiresAt,
      })
      .from(importFinding)
      .where(eq(importFinding.importRunId, run.id))
      .orderBy(asc(importFinding.createdAt)),
    database
      .select({
        pricedSubtotal: sql<number>`coalesce(sum(${aiUsage.estimatedCost}) filter (where ${aiUsage.estimatedCost} is not null), 0)`,
        unpricedCount: sql<number>`count(*) filter (where ${aiUsage.estimatedCost} is null and ${aiUsage.status} = 'succeeded')`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.jobKind, "purchase_import_run"),
          eq(aiUsage.jobId, run.id),
          notDeleted(aiUsage),
        ),
      ),
    database
      .select({
        id: aiUsage.id,
        createdAt: aiUsage.createdAt,
        feature: aiUsage.feature,
        operation: aiUsage.operation,
        provider: aiUsage.provider,
        model: aiUsage.model,
        inputTokens: aiUsage.inputTokens,
        outputTokens: aiUsage.outputTokens,
        cacheReadTokens: aiUsage.cacheReadTokens,
        cacheWriteTokens: aiUsage.cacheWriteTokens,
        attempt: aiUsage.attempt,
        status: aiUsage.status,
        gatewayLogId: aiUsage.gatewayLogId,
        durationMs: aiUsage.durationMs,
        estimatedCost: aiUsage.estimatedCost,
        cacheStatus: aiUsage.cacheStatus,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.jobKind, "purchase_import_run"),
          eq(aiUsage.jobId, run.id),
          notDeleted(aiUsage),
          usageCursor
            ? or(
                lt(aiUsage.createdAt, new Date(usageCursor.createdAt)),
                and(
                  eq(aiUsage.createdAt, new Date(usageCursor.createdAt)),
                  lt(aiUsage.id, usageCursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id))
      .limit(usageLimit + 1),
    database
      .select({
        action: importRunControlEvent.action,
        userId: importRunControlEvent.controllerUserId,
        name: importRunControlEvent.controllerName,
        email: importRunControlEvent.controllerEmail,
        ledgerPartyId: importRunControlEvent.controllerLedgerPartyShortcode,
        ledgerPartyName: importRunControlEvent.controllerLedgerPartyName,
        ledgerPartyKind: importRunControlEvent.controllerLedgerPartyKind,
        createdAt: importRunControlEvent.createdAt,
      })
      .from(importRunControlEvent)
      .where(eq(importRunControlEvent.runId, run.id))
      .orderBy(asc(importRunControlEvent.createdAt)),
  ]);
  const hasMoreUsage = usageRows.length > usageLimit;
  const pageUsage = usageRows.slice(0, usageLimit);
  return {
    publicId: run.publicId,
    status: run.status,
    trigger: run.trigger,
    source: {
      kind: run.trigger,
      vendorName: run.vendorName,
    },
    actor: {
      id: run.actorUserId,
      name: run.actorName,
      email: run.actorEmail,
      ledgerParty: {
        id: run.actorLedgerPartyShortcode,
        name: run.actorLedgerPartyName,
        kind: run.actorLedgerPartyKind,
      },
    },
    controllingMembers: [
      ...new Map(
        controlHistory.map((event) => [
          event.userId,
          {
            userId: event.userId,
            name: event.name,
            email: event.email,
            ledgerParty: {
              id: event.ledgerPartyId,
              name: event.ledgerPartyName,
              kind: event.ledgerPartyKind,
            },
          },
        ]),
      ).values(),
    ],
    controlHistory,
    vendorAccount: run.vendorAccountShortcode
      ? { id: run.vendorAccountShortcode, label: run.vendorAccountLabel }
      : null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    auditedAt: run.auditedAt,
    ordersSeen: run.ordersSeen,
    imported: run.imported,
    updated: run.updated,
    skipped: run.skipped,
    failureCode: run.failureCode,
    predecessorRunPublicId: predecessor[0]?.publicId ?? null,
    successorRunPublicId: successor[0]?.publicId ?? null,
    coordinatorModel: run.coordinatorModel,
    skillRevision: run.skillRevision,
    runtimeRevision: run.runtimeRevision,
    decisionRevision: run.decisionRevision,
    operations,
    approvals,
    preparedOrders,
    progress,
    latestProgress: progress.at(-1) ?? null,
    affectedPurchases,
    findings,
    usage: {
      pricedSubtotal: usageTotals[0]?.pricedSubtotal ?? 0,
      unpricedCount: usageTotals[0]?.unpricedCount ?? 0,
      records: pageUsage,
      nextCursor: hasMoreUsage
        ? (() => {
            const last = pageUsage.at(-1);
            return last
              ? encodeUsageCursor({
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                })
              : null;
          })()
        : null,
    },
  };
}

const runControlInput = z.object({
  runPublicId: importRunPublicId,
  action: z.enum([
    "pause",
    "resume",
    "cancel",
    "approve",
    "reject",
    "retry",
    "escalate_sol",
  ]),
  operationId: z.string().trim().min(1).max(200).optional(),
  approvalId: z.uuid().optional(),
});

const importRunControlAction = z.enum([
  "prompt",
  "abort",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "retry",
  "escalate_sol",
]);

export async function recordImportRunControlEvent(
  db: Database,
  actor: ActorContext,
  rawInput: {
    runPublicId: string;
    action: z.input<typeof importRunControlAction>;
  },
) {
  const input = z
    .object({ runPublicId: importRunPublicId, action: importRunControlAction })
    .parse(rawInput);
  const scope = await loadRunScopeByPublicId(db, input.runPublicId);
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
    .insert(importRunControlEvent)
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
      id: importRunControlEvent.id,
      createdAt: importRunControlEvent.createdAt,
    });
  if (!event) throw new Error("Import run control event was not recorded");
  return event;
}

// Every control action shares one locked run and controller-attribution record;
// splitting the switch would weaken the cancellation and approval fences.
export async function controlImportRun(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof runControlInput>,
) {
  const input = runControlInput.parse(rawInput);
  const scope = await loadRunScopeByPublicId(db, input.runPublicId);
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
  return withTransaction(
    db,
    // eslint-disable-next-line complexity
    async (tx) => {
      const [locked] = await tx
        .select({
          status: importRun.status,
          ledgerPartyId: importRun.ledgerPartyId,
          actorUserId: importRun.actorUserId,
          actorName: importRun.actorName,
          actorEmail: importRun.actorEmail,
          actorLedgerPartyShortcode: importRun.actorLedgerPartyShortcode,
          actorLedgerPartyName: importRun.actorLedgerPartyName,
          actorLedgerPartyKind: importRun.actorLedgerPartyKind,
          vendorAccountId: importRun.vendorAccountId,
          vendorId: importRun.vendorId,
          trigger: importRun.trigger,
          skillRevision: importRun.skillRevision,
          runtimeRevision: importRun.runtimeRevision,
          decisionRevision: importRun.decisionRevision,
        })
        .from(importRun)
        .where(eq(importRun.id, scope.public.runId))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Purchase import run was not found");
      await tx.insert(importRunControlEvent).values({
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
            id: importRun.id,
            publicId: importRun.publicId,
            status: importRun.status,
            coordinatorModel: importRun.coordinatorModel,
          })
          .from(importRun)
          .where(eq(importRun.predecessorRunId, scope.public.runId))
          .orderBy(desc(importRun.startedAt))
          .limit(1);
        if (existingSuccessor) {
          return {
            publicId: input.runPublicId,
            status: locked.status,
            successorRunId: existingSuccessor.id,
            successorRunPublicId: existingSuccessor.publicId,
            successorStatus: existingSuccessor.status,
            successorCoordinatorModel: z
              .enum(["gpt-5.6-terra", "gpt-5.6-sol"])
              .parse(existingSuccessor.coordinatorModel),
            created: false,
          };
        }
        const successorId = crypto.randomUUID();
        const [successor] = await tx
          .insert(importRun)
          .values({
            id: successorId,
            publicId: mintImportRunPublicId(),
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
            trigger: locked.trigger,
            coordinatorModel:
              input.action === "escalate_sol" ? "gpt-5.6-sol" : "gpt-5.6-terra",
            skillRevision: locked.skillRevision,
            runtimeRevision: locked.runtimeRevision,
            decisionRevision: locked.decisionRevision + 1,
            agentSessionId: `import-run:${successorId}`,
          })
          .returning({
            publicId: importRun.publicId,
            status: importRun.status,
          });
        if (!successor) throw new Error("Successor import run was not created");
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
          successorCoordinatorModel:
            input.action === "escalate_sol" ? "gpt-5.6-sol" : "gpt-5.6-terra",
          created: true,
        };
      }
      if (input.action === "cancel") {
        if (!ACTIVE_RUN_STATUSES.some((status) => status === locked.status))
          throw new Error(
            `Purchase import run is immutable in ${locked.status}`,
          );
        const browserOperations = await tx
          .select({ result: importRunOperation.result })
          .from(importRunOperation)
          .where(
            and(
              eq(importRunOperation.runId, scope.public.runId),
              eq(importRunOperation.kind, "browser_command"),
              inArray(importRunOperation.state, ["started", "completed"]),
            ),
          );
        await tx
          .update(importRun)
          .set({
            status: "failed",
            failureCode: "user_cancelled",
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(importRun.id, scope.public.runId));
        await tx
          .update(importRunApproval)
          .set({ state: "invalidated", invalidatedAt: new Date() })
          .where(
            and(
              eq(importRunApproval.runId, scope.public.runId),
              inArray(importRunApproval.state, ["pending", "granted"]),
            ),
          );
        await tx
          .update(importRunOperation)
          .set({
            state: "failed",
            error: "Run cancelled by its owner",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(importRunOperation.runId, scope.public.runId),
              inArray(importRunOperation.state, ["started", "paused_approval"]),
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
          .update(importRun)
          .set({ status: "paused_approval", updatedAt: new Date() })
          .where(eq(importRun.id, scope.public.runId));
        return {
          publicId: input.runPublicId,
          status: "paused_approval" as const,
        };
      }
      if (input.action === "resume") {
        if (!new Set(["paused_auth", "paused_offline"]).has(locked.status))
          throw new Error(`Purchase import run is fenced in ${locked.status}`);
        await tx
          .update(importRun)
          .set({ status: "running", failureCode: null, updatedAt: new Date() })
          .where(eq(importRun.id, scope.public.runId));
        return { publicId: input.runPublicId, status: "running" as const };
      }

      if (!input.operationId)
        throw new Error("Approval decision requires an operation id");
      const [operation] = await tx
        .select({
          inputFingerprint: importRunOperation.inputFingerprint,
          state: importRunOperation.state,
          kind: importRunOperation.kind,
          result: importRunOperation.result,
        })
        .from(importRunOperation)
        .where(
          and(
            eq(importRunOperation.runId, scope.public.runId),
            eq(importRunOperation.operationId, input.operationId),
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
              id: importRunApproval.id,
              state: importRunApproval.state,
            })
            .from(importRunApproval)
            .where(
              and(
                eq(importRunApproval.id, input.approvalId),
                eq(importRunApproval.runId, scope.public.runId),
                eq(importRunApproval.operationId, input.operationId),
              ),
            )
            .limit(1)
        : await tx
            .select({
              id: importRunApproval.id,
              state: importRunApproval.state,
            })
            .from(importRunApproval)
            .where(
              and(
                eq(importRunApproval.runId, scope.public.runId),
                eq(importRunApproval.operationId, input.operationId),
              ),
            )
            .limit(1);
      let approvalId = existing?.id;
      if (!approvalId) {
        const [created] = await tx
          .insert(importRunApproval)
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
          .returning({ id: importRunApproval.id });
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
          .update(importRunApproval)
          .set({
            state: "rejected",
            decidedByUserId: actor.userId,
            decidedAt,
            rejectedAt: decidedAt,
          })
          .where(eq(importRunApproval.id, approvalId));
        await tx
          .update(importRunOperation)
          .set({
            state: "failed",
            error: "Mutation proposal rejected by a household member",
            updatedAt: decidedAt,
          })
          .where(
            and(
              eq(importRunOperation.runId, scope.public.runId),
              eq(importRunOperation.operationId, input.operationId),
            ),
          );
        const pending = await tx
          .select({ id: importRunApproval.id })
          .from(importRunApproval)
          .where(
            and(
              eq(importRunApproval.runId, scope.public.runId),
              inArray(importRunApproval.state, ["pending", "granted"]),
            ),
          )
          .limit(1);
        const status = pending.length > 0 ? "paused_approval" : "running";
        await tx
          .update(importRun)
          .set({ status, updatedAt: decidedAt })
          .where(eq(importRun.id, scope.public.runId));
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
            .update(importRunApproval)
            .set({ state: "invalidated", invalidatedAt: new Date() })
            .where(eq(importRunApproval.id, approvalId));
          await tx
            .update(importRunOperation)
            .set({
              state: "failed",
              error: "Mutation target changed after proposal",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(importRunOperation.runId, scope.public.runId),
                eq(importRunOperation.operationId, input.operationId),
              ),
            );
          await tx
            .update(importRun)
            .set({ status: "running", updatedAt: new Date() })
            .where(eq(importRun.id, scope.public.runId));
          return {
            publicId: input.runPublicId,
            status: "running" as const,
            approvalId,
            decision: "invalidated" as const,
          };
        }
      }
      await tx
        .update(importRunApproval)
        .set({
          state: "granted",
          decidedByUserId: actor.userId,
          decidedAt: new Date(),
        })
        .where(eq(importRunApproval.id, approvalId));
      await tx
        .update(importRunOperation)
        .set({
          result: {
            ...z.record(z.string(), z.unknown()).parse(operation.result),
            approvalId,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importRunOperation.runId, scope.public.runId),
            eq(importRunOperation.operationId, input.operationId),
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
