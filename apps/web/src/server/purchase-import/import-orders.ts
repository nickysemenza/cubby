import type { ActorContext } from "@cubby/schemas/context";
import {
  type LedgerPartyId,
  parseEntityId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  extractedPurchaseLine,
  importExtractionOutcome,
  importSourceKind,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  purchaseImportOperationStatusInput,
  purchaseImportOperationStatusOut,
  type CommitPurchaseImportInput,
  type PreparePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  expense,
  importPreparedLine,
  importPreparedOrder,
  importHunt,
  importRun,
  importRunOperation,
  importSourceClaim,
  product,
  productExternalId,
  purchase,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { attachPendingOrderMailEvidence } from "./gmail/process";
import { auditAllImportBatches, loadRunScopeByPublicId } from "./run-service";
import { importVendorOrder } from "./writer";

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const operationArgs = (input: {
  prepareOperationId: string;
  resolutions: CommitPurchaseImportInput["resolutions"];
}) => ({
  prepareOperationId: input.prepareOperationId,
  resolutions: input.resolutions,
});

const assertOwnedRun = async (
  db: Database,
  actor: ActorContext,
  runPublicId: string,
) => {
  const scope = await loadRunScopeByPublicId(db, runPublicId);
  if (scope.actorUserId !== actor.userId)
    throw new Error("Purchase import run is not owned by this member");
  return scope;
};

const externalSource = (url: string | undefined, vendorId: string): string => {
  if (!url) return `vendor-${vendorId}`;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  return (
    host
      .split(".")[0]
      ?.replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "") || "vendor"
  );
};

const productSearchPatterns = (title: string) =>
  title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .slice(0, 3)
    .map((token) => `%${token.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);

const amazonAsin = (url: string | undefined): string | null => {
  if (!url) return null;
  const parsed = new URL(url);
  if (!/(^|\.)amazon\./u.test(parsed.hostname.toLowerCase())) return null;
  return (
    /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/iu
      .exec(parsed.pathname)?.[1]
      ?.toUpperCase() ?? null
  );
};

async function productCandidates(
  db: Database,
  vendorId: VendorId,
  line: z.infer<typeof extractedPurchaseLine>,
) {
  const database = getDb(db);
  const source = externalSource(line.productUrl, vendorId);
  const asin = amazonAsin(line.productUrl);
  const exactIds = [
    ...new Set([line.sku, asin].filter((id): id is string => Boolean(id))),
  ];
  const exact = exactIds.length
    ? await database
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          manufacturer: product.manufacturer,
          model: product.model,
        })
        .from(productExternalId)
        .innerJoin(
          product,
          and(eq(product.id, productExternalId.productId), notDeleted(product)),
        )
        .where(
          and(
            eq(productExternalId.source, source),
            inArray(productExternalId.kind, ["retailer_sku", "asin"]),
            inArray(productExternalId.externalId, exactIds),
            notDeleted(productExternalId),
          ),
        )
        .limit(1)
    : [];
  const patterns = productSearchPatterns(line.title);
  const fuzzy = patterns.length
    ? await database
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          manufacturer: product.manufacturer,
          model: product.model,
        })
        .from(product)
        .where(
          and(
            notDeleted(product),
            or(...patterns.map((pattern) => ilike(product.name, pattern))),
          ),
        )
        .orderBy(asc(product.name))
        .limit(20)
    : [];
  const exactProductIds = new Set(exact.map(({ id }) => id));
  return [...exact, ...fuzzy.filter(({ id }) => !exactProductIds.has(id))]
    .slice(0, 20)
    .map(({ id, shortcode, ...candidate }) => ({
      productId: shortcode,
      ...candidate,
      exactIdentifierMatch: exactProductIds.has(id),
    }));
}

async function computeTargetFingerprint(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: VendorId;
    sourceKind: z.infer<typeof importSourceKind>;
    sourceExternalKey: string;
    orderId: string | null;
  },
) {
  const database = getDb(db);
  const [claim] = await database
    .select({
      id: importSourceClaim.id,
      checksum: importSourceClaim.checksum,
      purchaseId: importSourceClaim.purchaseId,
      updatedAt: importSourceClaim.updatedAt,
    })
    .from(importSourceClaim)
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, input.ledgerPartyId),
        eq(importSourceClaim.kind, input.sourceKind),
        eq(importSourceClaim.externalKey, input.sourceExternalKey),
      ),
    )
    .limit(1);
  const [target] = input.orderId
    ? await database
        .select({
          id: purchase.id,
          vendorAccountId: purchase.vendorAccountId,
          updatedAt: purchase.updatedAt,
        })
        .from(purchase)
        .where(
          and(
            eq(purchase.vendorId, input.vendorId),
            eq(purchase.orderId, input.orderId),
            notDeleted(purchase),
          ),
        )
        .limit(1)
    : [];
  const expenses = target
    ? await database
        .select({ id: expense.id, updatedAt: expense.updatedAt })
        .from(expense)
        .where(and(eq(expense.purchaseId, target.id), notDeleted(expense)))
        .orderBy(asc(expense.id))
    : [];
  return sha256(
    JSON.stringify({
      claim: claim
        ? { ...claim, updatedAt: claim.updatedAt.toISOString() }
        : null,
      target: target
        ? { ...target, updatedAt: target.updatedAt.toISOString() }
        : null,
      expenses: expenses.map((row) => ({
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
      })),
    }),
  );
}

const computeEvidenceFingerprint = (input: {
  source: unknown;
  evidenceChecksum: string;
  extractionRevision: string;
  extraction: unknown;
  primaryDocumentImageId: string | null;
  screenshotImageId: string | null;
}) => sha256(JSON.stringify(input));

type StoredPreparation = {
  order: typeof importPreparedOrder.$inferSelect;
  lines: Array<typeof importPreparedLine.$inferSelect>;
};

async function loadPreparation(
  db: Database,
  runId: string,
  prepareOperationId: string,
): Promise<StoredPreparation[]> {
  const database = getDb(db);
  const orders = await database
    .select()
    .from(importPreparedOrder)
    .where(
      and(
        eq(importPreparedOrder.runId, runId),
        eq(importPreparedOrder.prepareOperationId, prepareOperationId),
      ),
    )
    .orderBy(asc(importPreparedOrder.createdAt), asc(importPreparedOrder.id));
  if (orders.length === 0) throw new Error("Prepared import was not found");
  const lines = await database
    .select()
    .from(importPreparedLine)
    .where(
      inArray(
        importPreparedLine.preparedOrderId,
        orders.map(({ id }) => id),
      ),
    )
    .orderBy(
      asc(importPreparedLine.preparedOrderId),
      asc(importPreparedLine.position),
    );
  return orders.map((order) => ({
    order,
    lines: lines.filter((line) => line.preparedOrderId === order.id),
  }));
}

export async function preparePurchaseImport(
  db: Database,
  rawInput: PreparePurchaseImportInput,
  actor: ActorContext,
) {
  const input = preparePurchaseImportInput.parse(rawInput);
  const scope = await assertOwnedRun(
    db,
    actor,
    input._runExecution.runPublicId,
  );
  if (!scope.vendorId) throw new Error("Purchase import run has no vendor");
  const vendorId = scope.vendorId;
  const inputFingerprint = await sha256(JSON.stringify(input.orders));

  return withTransactionDatabase(db, async (transactionDb) => {
    const database = getDb(transactionDb);
    const [existing] = await database
      .select({
        inputFingerprint: importRunOperation.inputFingerprint,
        state: importRunOperation.state,
        result: importRunOperation.result,
      })
      .from(importRunOperation)
      .where(
        and(
          eq(importRunOperation.runId, scope.public.runId),
          eq(importRunOperation.operationId, input._runExecution.operationId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint)
        throw new Error("Operation id was replayed with different input");
      if (existing.state === "completed")
        return preparePurchaseImportOut.parse(existing.result);
      throw new Error(
        "Preparation outcome is uncertain; inspect operation status",
      );
    }
    if (scope.public.status !== "running")
      throw new Error(
        `Purchase import run is fenced in ${scope.public.status}`,
      );
    await database.insert(importRunOperation).values({
      runId: scope.public.runId,
      operationId: input._runExecution.operationId,
      kind: "prepare_purchase_import",
      inputFingerprint,
    });

    const outputOrders = [];
    for (const order of input.orders) {
      const primaryDocumentImageId = order.primaryDocumentImageId
        ? await resolveOrThrow(
            transactionDb,
            "image",
            order.primaryDocumentImageId,
          )
        : null;
      const screenshotImageId = order.screenshotImageId
        ? await resolveOrThrow(transactionDb, "image", order.screenshotImageId)
        : null;
      const candidate = order.extraction.candidate;
      if (!candidate)
        throw new Error(
          "Unreadable imports cannot be prepared without a candidate",
        );
      const targetFingerprint = await computeTargetFingerprint(transactionDb, {
        ledgerPartyId: scope.ledgerPartyId,
        vendorId,
        sourceKind: order.source.kind,
        sourceExternalKey: order.source.externalKey,
        orderId: candidate.orderId,
      });
      const evidenceFingerprint = await computeEvidenceFingerprint({
        source: order.source,
        evidenceChecksum: order.evidenceChecksum,
        extractionRevision: order.extractionRevision,
        extraction: order.extraction,
        primaryDocumentImageId,
        screenshotImageId,
      });
      const [storedOrder] = await database
        .insert(importPreparedOrder)
        .values({
          runId: scope.public.runId,
          prepareOperationId: input._runExecution.operationId,
          itemOperationId: order.itemOperationId,
          stableOrderId: order.stableOrderId,
          sourceKind: order.source.kind,
          sourceExternalKey: order.source.externalKey,
          sourceChecksum: order.source.checksum,
          evidenceChecksum: order.evidenceChecksum,
          extractionRevision: order.extractionRevision,
          extraction: order.extraction,
          primaryDocumentImageId,
          screenshotImageId,
          targetFingerprint,
          evidenceFingerprint,
        })
        .returning({ id: importPreparedOrder.id });
      if (!storedOrder) throw new Error("Prepared order was not persisted");

      const outputLines = [];
      for (const [position, line] of candidate.lines.entries()) {
        const stableLineId = order.lineIds[position];
        if (!stableLineId) throw new Error("Prepared line id is missing");
        const candidates = await productCandidates(
          transactionDb,
          vendorId,
          line,
        );
        const identifiers = Object.fromEntries(
          [
            line.sku ? ["sku", line.sku] : null,
            amazonAsin(line.productUrl)
              ? ["asin", amazonAsin(line.productUrl)!]
              : null,
            line.productUrl ? ["productUrl", line.productUrl] : null,
          ].filter((entry): entry is [string, string] => entry !== null),
        );
        await database.insert(importPreparedLine).values({
          preparedOrderId: storedOrder.id,
          stableLineId,
          position,
          line,
          identifiers,
          candidates,
        });
        outputLines.push({
          stableLineId,
          title: line.title,
          amount: line.amount,
          identifiers,
          candidates,
          requiresProductResolution: line.lineKind === "principal",
        });
      }
      outputOrders.push({
        stableOrderId: order.stableOrderId,
        itemOperationId: order.itemOperationId,
        source: order.source,
        orderId: candidate.orderId,
        targetFingerprint,
        evidenceFingerprint,
        lines: outputLines,
      });
    }

    const result = preparePurchaseImportOut.parse({
      runPublicId: scope.public.publicId,
      operationId: input._runExecution.operationId,
      status: "running",
      orders: outputOrders,
    });
    await database
      .update(importRunOperation)
      .set({
        state: "completed",
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRunOperation.runId, scope.public.runId),
          eq(importRunOperation.operationId, input._runExecution.operationId),
        ),
      );
    return result;
  });
}

async function finalizeReviewRun(
  db: Database,
  runId: string,
  operationId: string,
) {
  await auditAllImportBatches(db, {
    runId,
    operationId: `${operationId}:required-audit`,
  });
  await getDb(db)
    .update(importRun)
    .set({
      status: "needs_review",
      auditedAt: new Date(),
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importRun.id, runId),
        inArray(importRun.status, ["running", "paused_approval"]),
      ),
    );
}

// The transaction deliberately keeps replay, evidence, resolution, and write
// fences together so no partial extraction can escape as a business effect.
export async function commitPurchaseImport(
  db: Database,
  rawInput: CommitPurchaseImportInput,
  actor: ActorContext,
) {
  const input = commitPurchaseImportInput.parse(rawInput);
  const scope = await assertOwnedRun(
    db,
    actor,
    input._runExecution.runPublicId,
  );
  if (!scope.vendorId) throw new Error("Purchase import run has no vendor");
  const vendorId = scope.vendorId;
  const args = operationArgs(input);
  const argsFingerprint = await sha256(JSON.stringify(args));
  const transactionResult = await withTransactionDatabase(
    db,
    // eslint-disable-next-line complexity
    async (transactionDb) => {
      const database = getDb(transactionDb);
      const [operation] = await database
        .select({
          state: importRunOperation.state,
          inputFingerprint: importRunOperation.inputFingerprint,
          result: importRunOperation.result,
        })
        .from(importRunOperation)
        .where(
          and(
            eq(importRunOperation.runId, scope.public.runId),
            eq(importRunOperation.operationId, input._runExecution.operationId),
          ),
        )
        .limit(1)
        .for("update");
      if (operation) {
        if (operation.inputFingerprint !== argsFingerprint)
          throw new Error("Operation id was replayed with different input");
        if (operation.state === "completed") {
          const metadata = z
            .object({ requiresReview: z.boolean() })
            .catch({ requiresReview: false })
            .parse(operation.result);
          return {
            result: commitPurchaseImportOut.parse(operation.result),
            requiresReview: metadata.requiresReview,
          };
        }
        throw new Error(
          "Commit outcome is uncertain; inspect operation status",
        );
      }
      if (scope.public.status !== "running")
        throw new Error(
          `Purchase import run is fenced in ${scope.public.status}`,
        );
      await database.insert(importRunOperation).values({
        runId: scope.public.runId,
        operationId: input._runExecution.operationId,
        kind: "commit_purchase_import",
        inputFingerprint: argsFingerprint,
        state: "started",
      });
      const prepared = await loadPreparation(
        transactionDb,
        scope.public.runId,
        input.prepareOperationId,
      );
      for (const { order } of prepared) {
        const extraction = importExtractionOutcome.parse(order.extraction);
        const targetFingerprint = await computeTargetFingerprint(
          transactionDb,
          {
            ledgerPartyId: scope.ledgerPartyId,
            vendorId,
            sourceKind: importSourceKind.parse(order.sourceKind),
            sourceExternalKey: order.sourceExternalKey,
            orderId: extraction.candidate?.orderId ?? null,
          },
        );
        const evidenceFingerprint = await computeEvidenceFingerprint({
          source: {
            kind: importSourceKind.parse(order.sourceKind),
            externalKey: order.sourceExternalKey,
            checksum: order.sourceChecksum,
          },
          evidenceChecksum: order.evidenceChecksum,
          extractionRevision: order.extractionRevision,
          extraction,
          primaryDocumentImageId: order.primaryDocumentImageId,
          screenshotImageId: order.screenshotImageId,
        });
        if (
          targetFingerprint !== order.targetFingerprint ||
          evidenceFingerprint !== order.evidenceFingerprint
        ) {
          throw new Error("Prepared target or evidence changed before commit");
        }
      }
      const resolutionMap = new Map(
        input.resolutions.map((resolution) => [
          `${resolution.stableOrderId}:${resolution.stableLineId}`,
          resolution.resolution,
        ]),
      );
      if (resolutionMap.size !== input.resolutions.length)
        throw new Error("Product resolutions contain duplicate line ids");
      const items = [];
      let requiresReview = false;
      for (const { order, lines } of prepared) {
        const extraction = importExtractionOutcome.parse(order.extraction);
        const productResolutions = [];
        for (const line of lines) {
          const parsedLine = extractedPurchaseLine.parse(line.line);
          const resolution = resolutionMap.get(
            `${order.stableOrderId}:${line.stableLineId}`,
          );
          if (!resolution)
            throw new Error(
              `Missing product resolution for ${order.stableOrderId}/${line.stableLineId}`,
            );
          if (resolution.kind === "existing") {
            productResolutions.push({
              kind: "existing" as const,
              lineIndex: line.position,
              productId: await resolveOrThrow(
                transactionDb,
                "product",
                resolution.productId,
              ),
            });
          } else if (resolution.kind === "new") {
            productResolutions.push({
              kind: "new" as const,
              lineIndex: line.position,
            });
          } else {
            requiresReview ||= parsedLine.lineKind === "principal";
            productResolutions.push({
              kind: "unresolved" as const,
              lineIndex: line.position,
              reason: resolution.reason,
            });
          }
        }
        const result = await importVendorOrder(
          transactionDb,
          {
            runId: scope.public.runId,
            ledgerPartyId: scope.ledgerPartyId,
            vendorId,
            vendorAccountId: scope.public.vendorAccountId,
            source: {
              kind: importSourceKind.parse(order.sourceKind),
              externalKey: order.sourceExternalKey,
              checksum: order.sourceChecksum,
            },
            extraction,
            primaryDocumentImageId: order.primaryDocumentImageId,
            screenshotImageId: order.screenshotImageId,
            productResolutions,
          },
          actor.userId,
        );
        if (order.sourceKind === "receipt_photo") {
          const huntId = order.sourceExternalKey.startsWith("hunt:")
            ? order.sourceExternalKey.slice("hunt:".length)
            : null;
          if (huntId) {
            await database
              .update(importHunt)
              .set({ state: "resolved", error: null, updatedAt: new Date() })
              .where(
                and(
                  eq(importHunt.id, huntId),
                  eq(importHunt.receiptRunId, scope.public.runId),
                  eq(importHunt.state, "processing_receipt"),
                ),
              );
          }
        }
        const [written] = result.purchaseId
          ? await database
              .select({ shortcode: purchase.shortcode })
              .from(purchase)
              .where(
                eq(purchase.id, parseEntityId("purchase", result.purchaseId)),
              )
              .limit(1)
          : [];
        if (written && extraction.candidate?.orderId) {
          await attachPendingOrderMailEvidence(transactionDb, {
            vendorId,
            orderId: extraction.candidate.orderId,
            purchaseShortcode: written.shortcode,
            ledgerPartyId: scope.ledgerPartyId,
          });
        }
        items.push({
          stableOrderId: order.stableOrderId,
          outcome: result.outcome,
          purchaseId: written?.shortcode ?? null,
          findingCount: result.findingIds.length,
        });
      }
      if (resolutionMap.size !== prepared.flatMap(({ lines }) => lines).length)
        throw new Error("Product resolutions include unknown line ids");
      const publicResult = commitPurchaseImportOut.parse({
        runPublicId: scope.public.publicId,
        operationId: input._runExecution.operationId,
        status: requiresReview ? "needs_review" : "running",
        items,
      });
      await database
        .update(importRunOperation)
        .set({
          state: "completed",
          result: { ...publicResult, requiresReview },
          error: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importRunOperation.runId, scope.public.runId),
            eq(importRunOperation.operationId, input._runExecution.operationId),
          ),
        );
      await database
        .update(importRun)
        .set({ status: "running", failureCode: null, updatedAt: new Date() })
        .where(eq(importRun.id, scope.public.runId));
      return { result: publicResult, requiresReview };
    },
  );
  if (transactionResult.requiresReview) {
    await finalizeReviewRun(
      db,
      scope.public.runId,
      input._runExecution.operationId,
    );
  }
  return transactionResult.result;
}

export async function purchaseImportOperationStatus(
  db: Database,
  rawInput: z.input<typeof purchaseImportOperationStatusInput>,
  actor: ActorContext,
) {
  const input = purchaseImportOperationStatusInput.parse(rawInput);
  const scope = await assertOwnedRun(
    db,
    actor,
    input._runExecution.runPublicId,
  );
  const [operation] = await getDb(db)
    .select({
      kind: importRunOperation.kind,
      state: importRunOperation.state,
      result: importRunOperation.result,
      error: importRunOperation.error,
      startedAt: importRunOperation.startedAt,
      completedAt: importRunOperation.completedAt,
    })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, scope.public.runId),
        eq(importRunOperation.operationId, input._runExecution.operationId),
      ),
    )
    .limit(1);
  if (!operation) throw new Error("Purchase import operation was not found");
  return purchaseImportOperationStatusOut.parse({
    runPublicId: scope.public.publicId,
    operationId: input._runExecution.operationId,
    ...operation,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  });
}
