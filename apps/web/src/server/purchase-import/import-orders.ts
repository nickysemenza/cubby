import type { ActorContext } from "@cubby/schemas/context";
import {
  type LedgerPartyId,
  parseEntityId,
  type VendorId,
  importRunId,
} from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  commitProductEnrichmentInput,
  commitProductEnrichmentOut,
  extractedPurchaseLine,
  importExtractionOutcome,
  importSourceKind,
  importRunPurpose,
  validatePurchaseImportInput,
  validatePurchaseImportOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  importOperationStatusInput,
  importOperationStatusOut,
  overwriteProductEnrichmentInput,
  overwriteProductEnrichmentOut,
  type CommitPurchaseImportInput,
  type CommitProductEnrichmentInput,
  type OverwriteProductEnrichmentInput,
  type PreparePurchaseImportInput,
  type ValidatePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import * as Sentry from "@sentry/tanstackstart-react";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  expense,
  image,
  importPreparedLine,
  importPreparedOrder,
  importHunt,
  importRun,
  importRunEvidence,
  importRunTarget,
  importRunMutation,
  importRunOperation,
  importSourceClaim,
  product,
  productExternalId,
  productImage,
  purchase,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { validateExpenseInheritance } from "~/server/repo/expense-inheritance";
import { deleteImages } from "~/server/repo/image";
import { validateLiveEffectiveTrades } from "~/server/repo/inheritance-validation";
import { assertProductCategoryChange } from "~/server/repo/product/classification";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
import {
  deleteStoredObjects,
  importImageFromUrl,
} from "~/server/services/image-storage.service";

import { assertImportRunCapability } from "./capabilities";
import { learnPurchaseProductExternalId } from "./external-id-learning";
import { attachPendingOrderMailEvidence } from "./gmail/process";
import { auditAllImportBatches, loadRunScope } from "./run-service";
import { buildPurchaseImportPlan, importVendorOrder } from "./writer";

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
  defaultTrade?: CommitPurchaseImportInput["defaultTrade"];
  defaultProjectId?: CommitPurchaseImportInput["defaultProjectId"];
  resolutions: CommitPurchaseImportInput["resolutions"];
}) => ({
  prepareOperationId: input.prepareOperationId,
  defaultTrade: input.defaultTrade,
  defaultProjectId: input.defaultProjectId,
  resolutions: input.resolutions,
});

const assertOwnedRun = async (
  db: Database,
  actor: ActorContext,
  runId: string,
) => {
  const scope = await loadRunScope(db, runId);
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
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  const [purposeRow] = await getDb(db)
    .select({ purpose: importRun.purpose })
    .from(importRun)
    .where(eq(importRun.id, scope.public.runId))
    .limit(1);
  assertImportRunCapability(
    importRunPurpose.parse(purposeRow?.purpose),
    "prepare",
  );
  if (
    purposeRow?.purpose === "purchase_validation" &&
    input.orders.some(
      (order) => order.primaryDocumentImageId || order.screenshotImageId,
    )
  )
    throw new Error(
      "Purchase validation accepts only run-scoped evidence, never shared images",
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
      runId: scope.public.shortcode,
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
        eq(importRun.id, importRunId.parse(runId)),
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
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  const [purposeRow] = await getDb(db)
    .select({ purpose: importRun.purpose })
    .from(importRun)
    .where(eq(importRun.id, scope.public.runId))
    .limit(1);
  assertImportRunCapability(
    importRunPurpose.parse(purposeRow?.purpose),
    "commit_purchase_import",
  );
  if (!scope.vendorId) throw new Error("Purchase import run has no vendor");
  const vendorId = scope.vendorId;
  const args = operationArgs(input);
  const argsFingerprint = await sha256(JSON.stringify(args));
  let transactionResult: {
    result: z.infer<typeof commitPurchaseImportOut>;
    requiresReview: boolean;
  };
  try {
    transactionResult = await withTransactionDatabase(
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
              eq(
                importRunOperation.operationId,
                input._runExecution.operationId,
              ),
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
        const prepared = await loadPreparation(
          transactionDb,
          scope.public.runId,
          input.prepareOperationId,
        );
        const defaultProjectId = input.defaultProjectId
          ? await resolveOrThrow(
              transactionDb,
              "project",
              input.defaultProjectId,
            )
          : null;
        const hasPrincipalLine = prepared.some(({ lines }) =>
          lines.some(
            (line) =>
              extractedPurchaseLine.parse(line.line).lineKind === "principal",
          ),
        );
        if (hasPrincipalLine) {
          await validateExpenseInheritance(transactionDb, {
            lineKind: "principal",
            projectId: defaultProjectId,
            productId: null,
            purchaseId: null,
            trade: input.defaultTrade ?? null,
          });
        }
        await database.insert(importRunOperation).values({
          runId: scope.public.runId,
          operationId: input._runExecution.operationId,
          kind: "commit_purchase_import",
          inputFingerprint: argsFingerprint,
          state: "started",
        });
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
            throw new Error(
              "Prepared target or evidence changed before commit",
            );
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
        // Adjustment lines (tax/shipping/discount/etc.) never carry a
        // Product, so the caller's resolution roster is keyed to principal
        // lines only — track which entries a real line actually consumed
        // instead of requiring one resolution per line below.
        const consumedResolutionIds = new Set<string>();
        for (const { order, lines } of prepared) {
          const extraction = importExtractionOutcome.parse(order.extraction);
          const productResolutions = [];
          for (const line of lines) {
            const parsedLine = extractedPurchaseLine.parse(line.line);
            const resolutionId = `${order.stableOrderId}:${line.stableLineId}`;
            const resolution = resolutionMap.get(resolutionId);
            if (!resolution) {
              if (parsedLine.lineKind === "principal")
                throw new Error(
                  `Missing product resolution for ${order.stableOrderId}/${line.stableLineId}`,
                );
              continue;
            }
            consumedResolutionIds.add(resolutionId);
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
              defaultTrade: input.defaultTrade,
              defaultProjectId: defaultProjectId ?? undefined,
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
        if (resolutionMap.size !== consumedResolutionIds.size)
          throw new Error("Product resolutions include unknown line ids");
        const publicResult = commitPurchaseImportOut.parse({
          runId: scope.public.shortcode,
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
              eq(
                importRunOperation.operationId,
                input._runExecution.operationId,
              ),
            ),
          );
        await database
          .update(importRun)
          .set({ status: "running", failureCode: null, updatedAt: new Date() })
          .where(eq(importRun.id, scope.public.runId));
        return { result: publicResult, requiresReview };
      },
    );
  } catch (error) {
    // The rolled-back transaction takes its own operation row with it, so the
    // failure is recorded here on a fresh connection (as `runImportOperation`
    // does). Never an upsert: an existing row belongs to another attempt whose
    // outcome must not be overwritten by this one.
    await getDb(db)
      .insert(importRunOperation)
      .values({
        runId: scope.public.runId,
        operationId: input._runExecution.operationId,
        kind: "commit_purchase_import",
        inputFingerprint: argsFingerprint,
        state: "failed",
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "unknown",
      })
      .onConflictDoNothing();
    throw error;
  }
  if (transactionResult.requiresReview) {
    await finalizeReviewRun(
      db,
      scope.public.runId,
      input._runExecution.operationId,
    );
  }
  return transactionResult.result;
}

/** Compare an immutable prepared plan to its live Purchase without invoking the writer. */
export async function validatePurchaseImport(
  db: Database,
  rawInput: ValidatePurchaseImportInput,
  actor: ActorContext,
) {
  const input = validatePurchaseImportInput.parse(rawInput);
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  if (scope.public.purpose !== "purchase_validation")
    throw new Error(
      "validate_purchase_import requires a purchase validation run",
    );
  if (scope.public.status !== "running")
    throw new Error(`Import run is fenced in status ${scope.public.status}`);
  const argsFingerprint = await sha256(JSON.stringify(input));
  return withTransactionDatabase(
    db,
    // eslint-disable-next-line complexity -- Validation compares the complete immutable plan inside one read-only transaction.
    async (transactionDb) => {
      const database = getDb(transactionDb);
      const [lockedRun] = await database
        .select({ status: importRun.status })
        .from(importRun)
        .where(eq(importRun.id, scope.public.runId))
        .limit(1)
        .for("update");
      if (lockedRun?.status !== "running")
        throw new Error(
          `Import run is fenced in status ${lockedRun?.status ?? "missing"}`,
        );
      const [existing] = await database
        .select({
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
        .limit(1);
      if (existing) {
        if (existing.inputFingerprint !== argsFingerprint)
          throw new Error("Operation id was replayed with different input");
        return validatePurchaseImportOut.parse(existing.result);
      }
      const prepared = await loadPreparation(
        transactionDb,
        scope.public.runId,
        input.prepareOperationId,
      );
      const resolutionMap = new Map(
        input.resolutions.map((resolution) => [
          `${resolution.stableOrderId}:${resolution.stableLineId}`,
          resolution.resolution,
        ]),
      );
      if (resolutionMap.size !== input.resolutions.length)
        throw new Error("Product resolutions contain duplicate line ids");
      const results = [];
      const canonical = (value: unknown[]) =>
        [...value].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
      for (const { order, lines } of prepared) {
        const extraction = importExtractionOutcome.parse(order.extraction);
        const plan = buildPurchaseImportPlan(extraction);
        const [target] = await database
          .select({
            id: importRunTarget.id,
            purchaseId: importRunTarget.purchaseId,
            evidenceFingerprint: importRunTarget.evidenceFingerprint,
          })
          .from(importRunTarget)
          .where(
            and(
              eq(importRunTarget.runId, scope.public.runId),
              eq(importRunTarget.sourceExternalKey, order.sourceExternalKey),
            ),
          )
          .limit(1);
        if (!target?.purchaseId)
          throw new Error("Prepared validation order has no Purchase target");
        const [livePurchase] = await database
          .select({
            orderId: purchase.orderId,
            statedTotal: purchase.statedTotal,
          })
          .from(purchase)
          .where(eq(purchase.id, target.purchaseId))
          .limit(1);
        const liveLines = await database
          .select({
            title: expense.name,
            amount: expense.cost,
            lineKind: expense.lineKind,
            quantity: expense.productQuantity,
            productId: product.shortcode,
          })
          .from(expense)
          .leftJoin(
            product,
            and(eq(product.id, expense.productId), notDeleted(product)),
          )
          .where(
            and(eq(expense.purchaseId, target.purchaseId), notDeleted(expense)),
          );
        const expected = canonical(
          lines.map((line) => {
            const parsed = extractedPurchaseLine.parse(line.line);
            const resolution = resolutionMap.get(
              `${order.stableOrderId}:${line.stableLineId}`,
            );
            if (!resolution && parsed.lineKind === "principal")
              throw new Error(
                `Missing product resolution for ${order.stableOrderId}/${line.stableLineId}`,
              );
            return {
              title: parsed.title,
              amount: parsed.amount,
              lineKind: parsed.lineKind,
              quantity: parsed.quantity ?? null,
              productId:
                parsed.lineKind !== "principal"
                  ? null
                  : resolution?.kind === "existing"
                    ? resolution.productId
                    : resolution?.kind,
            };
          }),
        );
        const actual = canonical(
          liveLines.map(({ title, amount, lineKind, quantity, productId }) => ({
            title,
            amount,
            lineKind,
            quantity,
            productId: productId ?? null,
          })),
        );
        const semanticEqual =
          plan.writeBlockReason === null &&
          JSON.stringify({
            orderId: livePurchase?.orderId ?? null,
            currency: "USD",
            statedTotal: livePurchase?.statedTotal ?? null,
            lines: actual,
          }) ===
            JSON.stringify({
              orderId: plan.orderId,
              currency: plan.currency,
              statedTotal: plan.statedTotal,
              lines: expected,
            });
        const rawEvidenceDrift =
          semanticEqual &&
          target.evidenceFingerprint !== null &&
          target.evidenceFingerprint !== order.sourceChecksum;
        const diff = semanticEqual
          ? null
          : {
              expected: {
                orderId: plan.orderId,
                currency: plan.currency,
                statedTotal: plan.statedTotal,
                lines: expected,
                writeBlockReason: plan.writeBlockReason,
              },
              actual: {
                orderId: livePurchase?.orderId ?? null,
                currency: "USD",
                statedTotal: livePurchase?.statedTotal ?? null,
                lines: actual,
              },
            };
        const outcome = semanticEqual
          ? rawEvidenceDrift
            ? "raw_evidence_drift"
            : "replayed"
          : "semantic_drift";
        await database
          .update(importRunTarget)
          .set({
            state: semanticEqual ? "completed" : "unresolved",
            outcome,
            diff,
            warning: rawEvidenceDrift
              ? "The source evidence changed, but the resulting Purchase plan is semantically identical."
              : null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(importRunTarget.id, target.id));
        results.push({ stableOrderId: order.stableOrderId, outcome, diff });
      }
      const status = results.every(
        (result) => result.outcome !== "semantic_drift",
      )
        ? "completed"
        : "needs_review";
      const result = validatePurchaseImportOut.parse({
        runId: scope.public.shortcode,
        operationId: input._runExecution.operationId,
        status,
        targets: results,
      });
      await database.insert(importRunOperation).values({
        runId: scope.public.runId,
        operationId: input._runExecution.operationId,
        kind: "validate_purchase_import",
        inputFingerprint: argsFingerprint,
        state: "completed",
        result,
        completedAt: new Date(),
      });
      return result;
    },
  );
}

/** Fill only blank Product identity fields for an explicit enrichment target. */
export async function commitProductEnrichment(
  db: Database,
  rawInput: CommitProductEnrichmentInput,
  actor: ActorContext,
) {
  const input = commitProductEnrichmentInput.parse(rawInput);
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  if (scope.public.purpose !== "product_enrichment")
    throw new Error(
      "Product enrichment commit requires a product enrichment run",
    );
  if (scope.public.status !== "running")
    throw new Error(`Import run is fenced in status ${scope.public.status}`);
  const productId = await resolveOrThrow(db, "product", input.productId);
  const database = getDb(db);
  const changes = input.changes;
  const operationId = input._runExecution.operationId;
  const fingerprint = await sha256(JSON.stringify(input));
  const [existing] = await database
    .select({
      inputFingerprint: importRunOperation.inputFingerprint,
      result: importRunOperation.result,
    })
    .from(importRunOperation)
    .where(
      and(
        eq(importRunOperation.runId, scope.public.runId),
        eq(importRunOperation.operationId, operationId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.inputFingerprint !== fingerprint)
      throw new Error("Operation id was replayed with different input");
    return commitProductEnrichmentOut.parse(existing.result);
  }
  const changedFields = z
    .array(
      z.enum(["manufacturer", "categoryId", "model", "identifiers", "image"]),
    )
    .parse(Object.keys(changes));
  const [targetRef] = await database
    .select({ id: importRunTarget.id })
    .from(importRunTarget)
    .where(
      and(
        eq(importRunTarget.runId, scope.public.runId),
        eq(importRunTarget.productId, productId),
      ),
    )
    .limit(1);
  if (!targetRef) throw new Error("Product enrichment target was not found");
  let importedImageId: Awaited<ReturnType<typeof resolveOrThrow>> | null = null;
  let importedImageShortcode: string | null = null;
  let importedImageCreated = false;
  let importedImageSourcePageUrl: string | null = null;
  if (changes.image) {
    const [evidence] = await database
      .select({ metadata: importRunEvidence.sourceMetadata })
      .from(importRunEvidence)
      .where(
        and(
          eq(importRunEvidence.id, changes.image.evidenceId),
          eq(importRunEvidence.runId, scope.public.runId),
          eq(importRunEvidence.targetId, targetRef.id),
          eq(importRunEvidence.kind, "browser_capture"),
        ),
      )
      .limit(1);
    const metadata = z
      .object({
        requestedAmazonAsin: z.string().nullable(),
        servedAmazonAsin: z.string().nullable(),
        sourceURL: z.url().optional(),
        variantMarkers: z.array(z.string()),
        images: z.array(
          z.object({
            url: z.url(),
            naturalWidth: z.number().int().positive().nullable(),
            naturalHeight: z.number().int().positive().nullable(),
            highResolutionUrl: z.url().nullable(),
          }),
        ),
      })
      .safeParse(evidence?.metadata);
    const exactVariant =
      metadata.success &&
      metadata.data.requestedAmazonAsin !== null &&
      metadata.data.requestedAmazonAsin === metadata.data.servedAmazonAsin;
    const verified =
      metadata.success && exactVariant
        ? metadata.data.images.some(
            (image) =>
              (image.url === changes.image?.url ||
                image.highResolutionUrl === changes.image?.url) &&
              image.naturalWidth === changes.image?.naturalWidth &&
              image.naturalHeight === changes.image?.naturalHeight,
          )
        : false;
    if (!verified)
      throw new Error(
        "Product image was not verified by this target's browser evidence",
      );
    const imported = await importImageFromUrl(db, {
      sourceUrl: changes.image.url,
      filenamePrefix: `product-enrichment-${input.productId}`,
    });
    if (!imported)
      throw new Error("Verified Product image could not be stored");
    importedImageId = await resolveOrThrow(db, "image", imported.imageId);
    importedImageShortcode = imported.imageId;
    importedImageCreated = imported.created;
    importedImageSourcePageUrl = metadata.data!.sourceURL ?? null;
  }
  try {
    await withTransaction(
      db,
      // eslint-disable-next-line complexity -- The bounded commit revalidates every approved field and evidence class atomically.
      async (tx) => {
        const [lockedRun] = await tx
          .select({ status: importRun.status })
          .from(importRun)
          .where(eq(importRun.id, scope.public.runId))
          .limit(1)
          .for("update");
        if (lockedRun?.status !== "running")
          throw new Error(
            `Import run is fenced in status ${lockedRun?.status ?? "missing"}`,
          );
        const [target] = await tx
          .select({
            id: importRunTarget.id,
            targetFingerprint: importRunTarget.targetFingerprint,
          })
          .from(importRunTarget)
          .where(
            and(
              eq(importRunTarget.runId, scope.public.runId),
              eq(importRunTarget.productId, productId),
            ),
          )
          .limit(1)
          .for("update");
        if (!target || target.targetFingerprint !== input.targetFingerprint)
          throw new Error("Product enrichment target changed before commit");
        const [live] = await tx
          .select({
            name: product.name,
            manufacturer: product.manufacturer,
            categoryId: product.categoryId,
            model: product.model,
            updatedAt: product.updatedAt,
          })
          .from(product)
          .where(and(eq(product.id, productId), notDeleted(product)))
          .limit(1)
          .for("update");
        if (!live) throw new Error("Product enrichment target was not found");
        const currentTargetFingerprint = await sha256(
          JSON.stringify({ product: live }),
        );
        if (currentTargetFingerprint !== input.targetFingerprint)
          throw new Error("Product enrichment target changed before commit");
        if (
          (changes.manufacturer && live.manufacturer.trim()) ||
          (changes.categoryId && live.categoryId) ||
          (changes.model && live.model)
        )
          throw new Error(
            "Overwriting a populated Product field requires typed approval",
          );
        await tx.insert(importRunOperation).values({
          runId: scope.public.runId,
          operationId,
          kind: "commit_product_enrichment",
          inputFingerprint: fingerprint,
          state: "started",
        });
        await tx
          .update(product)
          .set({
            manufacturer: changes.manufacturer,
            categoryId: changes.categoryId
              ? await assertProductCategoryChange(
                  tx,
                  productId,
                  await resolveOrThrow(
                    tx,
                    "productCategory",
                    changes.categoryId,
                  ),
                )
              : undefined,
            model: changes.model,
            updatedAt: new Date(),
          })
          .where(eq(product.id, productId));
        if (changes.categoryId !== undefined)
          await validateLiveEffectiveTrades(tx);
        for (const identifier of changes.identifiers ?? []) {
          const [identifierEvidence] = await tx
            .select({ metadata: importRunEvidence.sourceMetadata })
            .from(importRunEvidence)
            .where(
              and(
                eq(importRunEvidence.id, identifier.evidenceId),
                eq(importRunEvidence.runId, scope.public.runId),
                eq(importRunEvidence.targetId, target.id),
                eq(importRunEvidence.kind, "browser_capture"),
              ),
            )
            .limit(1);
          const observed = z
            .object({
              requestedAmazonAsin: z.string().nullable(),
              servedAmazonAsin: z.string().nullable(),
            })
            .safeParse(identifierEvidence?.metadata);
          const externalId = identifier.externalId.toUpperCase();
          if (
            !observed.success ||
            identifier.kind !== "asin" ||
            observed.data.requestedAmazonAsin?.toUpperCase() !== externalId ||
            observed.data.servedAmazonAsin?.toUpperCase() !== externalId
          )
            throw new Error(
              "Product identifier was not proven by this target's retained evidence",
            );
          await learnPurchaseProductExternalId(tx, {
            productId,
            source: identifier.source,
            kind: identifier.kind,
            externalId,
            url: identifier.url,
          });
        }
        if (importedImageId) {
          const existingAttachment = await tx.query.productImage.findFirst({
            where: and(
              eq(productImage.productId, productId),
              eq(productImage.imageId, importedImageId),
              notDeleted(productImage),
            ),
            columns: { id: true, purpose: true },
          });
          if (existingAttachment?.purpose === "label")
            throw new Error(
              "Catalog enrichment cannot turn a confirmed label into an item cover",
            );
          // Only this import owns a newly-created row. A same-bucket URL can
          // resolve an existing household image; neither its provenance nor its
          // lifetime belongs to this enrichment attempt.
          if (importedImageCreated) {
            await tx
              .update(image)
              .set({
                source: "catalog",
                sourcePageUrl: importedImageSourcePageUrl,
                sourceAssetUrl: changes.image!.url,
                sourceName: importedImageSourcePageUrl
                  ? new URL(importedImageSourcePageUrl).hostname
                  : null,
              })
              .where(eq(image.id, importedImageId));
          }
          // A verified catalog image becomes the item cover without removing
          // household photos or label evidence; their relative order is kept.
          await tx
            .update(productImage)
            .set({ sortOrder: sql`${productImage.sortOrder} + 1` })
            .where(
              and(
                eq(productImage.productId, productId),
                notDeleted(productImage),
              ),
            );
          if (existingAttachment) {
            // The same stored image may already be an item attachment. Its
            // link is unique per live Product/Image pair, so promote it in
            // place instead of attempting a duplicate insert; do not rewrite
            // its purpose or Image provenance merely because this URL recurs.
            await tx
              .update(productImage)
              .set({ sortOrder: 0 })
              .where(eq(productImage.id, existingAttachment.id));
          } else {
            await tx.insert(productImage).values({
              productId,
              imageId: importedImageId,
              sortOrder: 0,
              purpose: "item",
            });
          }
        }
        await tx.insert(importRunMutation).values({
          runId: scope.public.runId,
          targetType: "product",
          targetId: productId,
          mutationKind: "update",
          fields: changedFields,
          postFingerprint: await sha256(JSON.stringify({ productId, changes })),
        });
        await tx
          .update(importRunTarget)
          .set({
            state: "completed",
            outcome: "enriched",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(importRunTarget.id, target.id));
        const result = commitProductEnrichmentOut.parse({
          runId: scope.public.shortcode,
          operationId,
          productId: input.productId,
          status: "running",
          changedFields,
        });
        await tx
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
              eq(importRunOperation.operationId, operationId),
            ),
          );
      },
    );
  } catch (error) {
    if (importedImageId && importedImageCreated) {
      const removed = await deleteImages(db, [importedImageId]);
      await deleteStoredObjects(removed.deletedKeys);
    }
    throw error;
  }
  if (importedImageShortcode) {
    try {
      await scheduleImageProcessingJobs(db, {
        id: importedImageShortcode,
        kinds: ["describe_image", "subject_lift"],
        automatic: true,
      });
    } catch (error) {
      // Enrichment has committed. Optional processing cannot turn a successful
      // import into a reported failure; the original remains displayable.
      Sentry.captureException(error, {
        tags: { operation: "product-enrichment.schedule-image-processing" },
      });
    }
  }
  return commitProductEnrichmentOut.parse({
    runId: scope.public.shortcode,
    operationId,
    productId: input.productId,
    status: "running",
    changedFields,
  });
}

/** One populated-field replacement, executed only by the exact-argument approval wrapper. */
export async function overwriteProductEnrichment(
  db: Database,
  rawInput: OverwriteProductEnrichmentInput,
  actor: ActorContext,
) {
  const input = overwriteProductEnrichmentInput.parse(rawInput);
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  if (scope.public.purpose !== "product_enrichment")
    throw new Error("Product overwrite requires a product enrichment run");
  const resolvedProductId = await resolveOrThrow(
    db,
    "product",
    input.productId,
  );
  return withTransaction(db, async (database) => {
    const [target] = await database
      .select({ targetFingerprint: importRunTarget.targetFingerprint })
      .from(importRunTarget)
      .where(
        and(
          eq(importRunTarget.runId, scope.public.runId),
          eq(importRunTarget.productId, resolvedProductId),
        ),
      )
      .limit(1);
    if (!target || target.targetFingerprint !== input.targetFingerprint)
      throw new Error("Product enrichment target changed before approval");
    const [live] = await database
      .select({
        name: product.name,
        manufacturer: product.manufacturer,
        categoryId: product.categoryId,
        model: product.model,
        updatedAt: product.updatedAt,
      })
      .from(product)
      .where(and(eq(product.id, resolvedProductId), notDeleted(product)))
      .limit(1);
    if (!live) throw new Error("Product enrichment target was not found");
    if (
      (await sha256(JSON.stringify({ product: live }))) !==
      input.targetFingerprint
    )
      throw new Error("Product enrichment target changed after proposal");

    const categoryId =
      input.change.field === "categoryId"
        ? await assertProductCategoryChange(
            database,
            resolvedProductId,
            input.change.value
              ? await resolveOrThrow(
                  database,
                  "productCategory",
                  input.change.value,
                )
              : null,
          )
        : undefined;
    const [updated] =
      input.change.field === "manufacturer"
        ? await database
            .update(product)
            .set({
              manufacturer: input.change.value ?? "",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(product.id, resolvedProductId),
                eq(product.updatedAt, live.updatedAt),
              ),
            )
            .returning({ id: product.id })
        : input.change.field === "categoryId"
          ? await database
              .update(product)
              .set({ categoryId, updatedAt: new Date() })
              .where(
                and(
                  eq(product.id, resolvedProductId),
                  eq(product.updatedAt, live.updatedAt),
                ),
              )
              .returning({ id: product.id })
          : await database
              .update(product)
              .set({ model: input.change.value, updatedAt: new Date() })
              .where(
                and(
                  eq(product.id, resolvedProductId),
                  eq(product.updatedAt, live.updatedAt),
                ),
              )
              .returning({ id: product.id });
    if (!updated) throw new Error("Product changed while applying approval");
    if (input.change.field === "categoryId")
      await validateLiveEffectiveTrades(database);
    await database
      .update(importRunTarget)
      .set({
        state: "completed",
        outcome: "enriched",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRunTarget.runId, scope.public.runId),
          eq(importRunTarget.productId, resolvedProductId),
        ),
      );
    return overwriteProductEnrichmentOut.parse({
      runId: scope.public.shortcode,
      productId: input.productId,
      changedField: input.change.field,
    });
  });
}

export async function purchaseImportOperationStatus(
  db: Database,
  rawInput: z.input<typeof importOperationStatusInput>,
  actor: ActorContext,
) {
  const input = importOperationStatusInput.parse(rawInput);
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
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
  return importOperationStatusOut.parse({
    runId: scope.public.shortcode,
    operationId: input._runExecution.operationId,
    ...operation,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  });
}
