import { buildActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  purchaseId,
  vendorAccountId,
  type LedgerPartyId,
  type VendorAccountId,
} from "@cubby/schemas/identifiers";
import {
  browserBridgeOperation,
  browserBridgeRequest,
  browserCapture,
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
  eq,
  inArray,
  isNotNull,
  isNull,
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
  importRunOperation,
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
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

import type { PurchaseImportDurableObjectRpc } from "./contracts";
import { resolveImportFinding } from "./findings";
import { attachPendingOrderMailEvidence } from "./gmail/process";
import { importVendorOrder } from "./writer";

const ACTIVE_RUN_STATUSES = [
  "running",
  "paused_auth",
  "paused_offline",
] as const;

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
  },
) {
  const trigger = importRunTrigger.parse(input.trigger);
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.vendorAccountId}))`,
    );
    const [scope] = await tx
      .select({ id: vendorAccount.id })
      .from(vendorAccount)
      .where(
        and(
          eq(vendorAccount.id, input.vendorAccountId),
          eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
          notDeleted(vendorAccount),
        ),
      )
      .limit(1);
    if (!scope) throw new Error("Vendor account is not owned by this member");
    const [existing] = await tx
      .select({ id: importRun.id, status: importRun.status })
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
    const [created] = await tx
      .insert(importRun)
      .values({
        id,
        ledgerPartyId: input.ledgerPartyId,
        vendorAccountId: input.vendorAccountId,
        trigger,
        agentSessionId: `import-run:${id}`,
      })
      .returning({ id: importRun.id, status: importRun.status });
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
      agentId: importRun.agentSessionId,
      trigger: importRun.trigger,
      status: importRun.status,
      vendorAccountId: importRun.vendorAccountId,
      vendorLabel: vendorAccount.label,
      allowedHosts: vendor.browserDomains,
      navigationHints: vendor.agentHints,
      cursor: vendorAccount.cursor,
      website: vendor.website,
      ledgerPartyId: importRun.ledgerPartyId,
      vendorId: vendor.id,
      actorUserId: ledgerParty.userId,
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
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
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
      agentId: row.agentId,
      trigger: row.trigger,
      status: row.status,
      vendorAccountId: row.vendorAccountId,
      vendorLabel: row.vendorLabel,
      allowedHosts: row.allowedHosts ?? [],
      navigationHints: row.navigationHints,
    }),
    website: row.website,
    cursor: row.cursor,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    actorUserId: row.actorUserId,
  };
}

const assertRunActive = (status: string) => {
  if (!ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status))
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
  if (!scope.public.vendorAccountId || !scope.vendorId)
    return { kind: "none" as const };
  if (
    scope.public.status === "paused_auth" ||
    scope.public.status === "paused_offline"
  ) {
    const connected = await namespace
      .getByName(scope.public.vendorAccountId)
      .connected();
    if (!connected) return { kind: "paused_offline" as const };
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
  const result = await namespace
    .getByName(scope.public.vendorAccountId)
    .result(z.uuid().parse(input.commandId));
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

    await auditAllImportBatches(db, {
      runId: input.runId,
      operationId: `${input.operationId}:audit`,
    });
    await getDb(db)
      .update(importRun)
      .set({ status: "completed", endedAt: new Date(), updatedAt: new Date() })
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

export async function recordOrchestrationUsage(
  db: Database,
  input: {
    runId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost: number;
  },
) {
  const runId = z.uuid().parse(input.runId);
  const usage = z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      estimatedCost: z.number().nonnegative(),
    })
    .parse(input);
  await getDb(db)
    .insert(aiUsage)
    .values({
      feature: "purchase-import-orchestration",
      provider: "cloudflare-ai-gateway",
      model: "gpt-5.6-luna",
      operation: "purchaseImport.flue",
      jobKind: "purchase_import_run",
      jobId: runId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost: usage.estimatedCost,
      durationMs: 0,
      cacheStatus:
        usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
          ? "hit"
          : "none",
    });
  return { recorded: true };
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
    .where(
      and(
        eq(importRun.id, runId),
        inArray(importRun.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .returning({ vendorAccountId: importRun.vendorAccountId });
  if (run?.vendorAccountId) {
    await getDb(db)
      .update(vendorAccount)
      .set({ status: "active", updatedAt: new Date() })
      .where(sql`${vendorAccount.id} = ${run.vendorAccountId}`);
  }
  return { failed: Boolean(run), detail: input.detail ?? null };
}
