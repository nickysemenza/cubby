import { type ActorContext, actorInRun } from "@cubby/schemas/context";
import { GTIN_KIND, GTIN_SOURCE } from "@cubby/schemas/external-id";
import {
  type LedgerPartyId,
  parseEntityId,
  type ProductId,
  productShortcode,
  type VendorId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  commitProductEnrichmentInput,
  browserStructuredProducts,
  commitProductEnrichmentOut,
  extractedPurchaseLine,
  importExtractionOutcome,
  importSourceKind,
  runPurpose,
  validatePurchaseImportInput,
  validatePurchaseImportOut,
  validationDiff,
  validationExpectedPlan,
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

import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  expense,
  image,
  importHunt,
  importPreparedLine,
  importPreparedOrder,
  importSourceClaim,
  product,
  purchase,
  run as runTable,
  runEvidence,
  runOperation,
  runTarget,
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
import { upsertAgentProductMatch } from "~/server/repo/product-match-candidate";
import { assertProductCategoryChange } from "~/server/repo/product/classification";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
  type ExternalIdPair,
} from "~/server/repo/product/find-by-external-ids";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { sha256Hex } from "~/server/semantic/hash";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
import {
  deleteStoredObjects,
  importImageFromUrl,
} from "~/server/services/image-storage.service";

import { assertRunCapability } from "./capabilities";
import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { loadOrderMailImportEvidence } from "./gmail/import";
import {
  attachPendingOrderMailEvidence,
  type OrderMailEvidencePorts,
} from "./gmail/process";
import { productEnrichmentTarget } from "./product-enrichment-target";
import { recordRunWrites } from "./run-audit";
import { auditAllImportBatches, loadRunScope } from "./run-service";
import {
  proveStructuredIdentifier,
  structuredPageProvesExactVariant,
  type ProvableIdentifier,
} from "./structured-identifier-proof";
import { loadLiveValidationState } from "./validation-corrections";
import {
  compareValidationPlan,
  PURCHASE_CURRENCY,
} from "./validation-corrections-compare";
import { buildPurchaseImportPlan, importVendorOrder } from "./writer";

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

const lineIdentifierRequests = (
  vendorId: VendorId,
  line: z.infer<typeof extractedPurchaseLine>,
): ExternalIdPair[] => {
  const source = externalSource(line.productUrl, vendorId);
  const ids = [
    ...new Set(
      [line.sku, amazonAsin(line.productUrl)].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ];
  return [
    ...ids.flatMap((externalId) => [
      { source, externalId, kind: "retailer_sku" as const },
      { source, externalId, kind: "asin" as const },
    ]),
    ...ids.flatMap<ExternalIdPair>((id) => {
      const gtin = wasm.scan_code_gtin14(id);
      return gtin
        ? [{ source: GTIN_SOURCE, externalId: gtin, kind: GTIN_KIND }]
        : [];
    }),
  ];
};

async function productCandidates(
  db: Database,
  requests: readonly ExternalIdPair[],
  exactHits: ReadonlyMap<string, ProductHit[]>,
  line: z.infer<typeof extractedPurchaseLine>,
) {
  const database = getDb(db);
  const exact = [
    ...new Map(
      requests
        .flatMap((request) => exactHits.get(externalIdKey(request)) ?? [])
        .map((hit) => [hit.id, hit]),
    ).values(),
  ];
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
    targetPurchaseId?: string | null;
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
  const [ordered] = input.orderId
    ? await database
        .select()
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
  const [chosen] = input.targetPurchaseId
    ? await database
        .select()
        .from(purchase)
        .where(
          and(
            eq(purchase.id, parseEntityId("purchase", input.targetPurchaseId)),
            notDeleted(purchase),
          ),
        )
        .limit(1)
    : [];
  if (input.targetPurchaseId && !chosen)
    throw new Error("The reviewed Purchase target no longer exists.");
  if (
    chosen &&
    (chosen.vendorId !== input.vendorId ||
      (chosen.orderId !== null && chosen.orderId !== input.orderId))
  )
    throw new Error(
      "The reviewed Purchase target has a different vendor or order identity.",
    );
  if (chosen && ordered && chosen.id !== ordered.id)
    throw new Error(
      "Another Purchase already owns this vendor order. Review the two Purchases before importing.",
    );
  if (chosen && claim?.purchaseId && claim.purchaseId !== chosen.id)
    throw new Error("This source already belongs to a different Purchase.");
  const target = chosen ?? ordered;
  const expenses = target
    ? await database
        .select({ id: expense.id, updatedAt: expense.updatedAt })
        .from(expense)
        .where(and(eq(expense.purchaseId, target.id), notDeleted(expense)))
        .orderBy(asc(expense.id))
    : [];
  return sha256Hex(
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
}) => sha256Hex(JSON.stringify(input));

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
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .limit(1);
  assertRunCapability(runPurpose.parse(purposeRow?.purpose), "prepare");
  if (
    purposeRow?.purpose === "purchase_validation" &&
    input.orders.some(
      (order) => order.primaryDocumentImageId || order.screenshotImageId,
    )
  )
    throw new Error(
      "Purchase validation accepts only run-scoped evidence, never shared images",
    );
  const assignedMail = await loadOrderMailImportEvidence(
    db,
    scope.public.runId,
  );
  if (
    assignedMail &&
    (input.orders.length !== 1 ||
      input.orders.some(
        (order) =>
          order.source.kind !== assignedMail.source.kind ||
          order.source.externalKey !== assignedMail.source.externalKey ||
          order.source.checksum !== assignedMail.evidenceChecksum ||
          order.evidenceChecksum !== assignedMail.evidenceChecksum ||
          order.extraction.candidate?.orderId !== assignedMail.orderId,
      ))
  )
    throw new Error(
      "Preparation must use the assigned order confirmation evidence unchanged.",
    );
  if (!scope.vendorId) throw new Error("Purchase import run has no vendor");
  const vendorId = scope.vendorId;
  const inputFingerprint = await sha256Hex(JSON.stringify(input.orders));

  return withTransactionDatabase(db, async (transactionDb) => {
    const database = getDb(transactionDb);
    const [existing] = await database
      .select({
        inputFingerprint: runOperation.inputFingerprint,
        state: runOperation.state,
        result: runOperation.result,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, scope.public.runId),
          eq(runOperation.operationId, input._runExecution.operationId),
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
    await database.insert(runOperation).values({
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
      const targetPurchaseId = order.targetPurchaseId
        ? await resolveOrThrow(
            transactionDb,
            "purchase",
            order.targetPurchaseId,
          )
        : null;
      const targetFingerprint = await computeTargetFingerprint(transactionDb, {
        ledgerPartyId: scope.ledgerPartyId,
        vendorId,
        sourceKind: order.source.kind,
        sourceExternalKey: order.source.externalKey,
        orderId: candidate.orderId,
        targetPurchaseId,
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
          targetPurchaseId,
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
      const exactRequests = candidate.lines.map((line) =>
        lineIdentifierRequests(vendorId, line),
      );
      const exactHits = await findProductsByExternalIds(
        transactionDb,
        exactRequests.flat(),
      );
      for (const [position, line] of candidate.lines.entries()) {
        const stableLineId = order.lineIds[position];
        if (!stableLineId) throw new Error("Prepared line id is missing");
        const candidates = await productCandidates(
          transactionDb,
          exactRequests[position] ?? [],
          exactHits,
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
        targetPurchaseId: order.targetPurchaseId ?? null,
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
      .update(runOperation)
      .set({
        state: "completed",
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, scope.public.runId),
          eq(runOperation.operationId, input._runExecution.operationId),
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
    .update(runTable)
    .set({
      status: "needs_review",
      auditedAt: new Date(),
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runTable.id, runEntityId.parse(runId)),
        inArray(runTable.status, ["running", "paused_approval"]),
      ),
    );
}

// The transaction deliberately keeps replay, evidence, resolution, and write
// fences together so no partial extraction can escape as a business effect.
export async function commitPurchaseImport(
  db: Database,
  rawInput: CommitPurchaseImportInput,
  actor: ActorContext,
  mailEvidencePorts?: OrderMailEvidencePorts,
) {
  const input = commitPurchaseImportInput.parse(rawInput);
  const scope = await assertOwnedRun(db, actor, input._runExecution.runId);
  const [purposeRow] = await getDb(db)
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .limit(1);
  assertRunCapability(
    runPurpose.parse(purposeRow?.purpose),
    "commit_purchase_import",
  );
  if (!scope.vendorId) throw new Error("Purchase import run has no vendor");
  const vendorId = scope.vendorId;
  const args = operationArgs(input);
  const argsFingerprint = await sha256Hex(JSON.stringify(args));
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
            state: runOperation.state,
            inputFingerprint: runOperation.inputFingerprint,
            result: runOperation.result,
          })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              eq(runOperation.operationId, input._runExecution.operationId),
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
        await loadOrderMailImportEvidence(transactionDb, scope.public.runId);
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
        await database.insert(runOperation).values({
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
              targetPurchaseId: order.targetPurchaseId,
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
              targetPurchaseId: order.targetPurchaseId,
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
            await attachPendingOrderMailEvidence(
              transactionDb,
              {
                vendorId,
                orderId: extraction.candidate.orderId,
                purchaseShortcode: written.shortcode,
                ledgerPartyId: scope.ledgerPartyId,
              },
              mailEvidencePorts,
            );
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
          .update(runOperation)
          .set({
            state: "completed",
            result: { ...publicResult, requiresReview },
            error: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              eq(runOperation.operationId, input._runExecution.operationId),
            ),
          );
        await database
          .update(runTable)
          .set({ status: "running", failureCode: null, updatedAt: new Date() })
          .where(eq(runTable.id, scope.public.runId));
        return { result: publicResult, requiresReview };
      },
    );
  } catch (error) {
    // The rolled-back transaction takes its own operation row with it, so the
    // failure is recorded here on a fresh connection (as `runImportOperation`
    // does). Never an upsert: an existing row belongs to another attempt whose
    // outcome must not be overwritten by this one.
    await getDb(db)
      .insert(runOperation)
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
      "purchase_import.validate requires a purchase validation run",
    );
  if (scope.public.status !== "running")
    throw new Error(`Import run is fenced in status ${scope.public.status}`);
  const argsFingerprint = await sha256Hex(JSON.stringify(input));
  return withTransactionDatabase(db, async (transactionDb) => {
    const database = getDb(transactionDb);
    const [lockedRun] = await database
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, scope.public.runId))
      .limit(1)
      .for("update");
    if (lockedRun?.status !== "running")
      throw new Error(
        `Import run is fenced in status ${lockedRun?.status ?? "missing"}`,
      );
    const [existing] = await database
      .select({
        inputFingerprint: runOperation.inputFingerprint,
        result: runOperation.result,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, scope.public.runId),
          eq(runOperation.operationId, input._runExecution.operationId),
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
          id: runTarget.id,
          entityId: runTarget.entityId,
          entityKind: runTarget.entityKind,
          evidenceFingerprint: runTarget.evidenceFingerprint,
        })
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, scope.public.runId),
            eq(runTarget.sourceExternalKey, order.sourceExternalKey),
          ),
        )
        .limit(1);
      if (target?.entityKind !== "purchase")
        throw new Error("Prepared validation order has no Purchase target");
      const targetPurchaseId = parseEntityId("purchase", target.entityId);
      const live = await loadLiveValidationState(
        transactionDb,
        targetPurchaseId,
        { lock: false, requireLive: false },
      );
      if (!live)
        throw new Error("The validation target Purchase no longer exists");
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
                  : (resolution?.kind ?? null),
          };
        }),
      );
      const expectedPlan = validationExpectedPlan.parse({
        orderId: plan.orderId,
        currency: plan.currency,
        statedTotal: plan.statedTotal,
        lines: expected,
        writeBlockReason: plan.writeBlockReason,
      });
      const comparison = await compareValidationPlan(expectedPlan, live);
      const semanticEqual = comparison.equal;
      const evidenceChanged =
        target.evidenceFingerprint !== null &&
        target.evidenceFingerprint !== order.sourceChecksum;
      const rawEvidenceDrift = semanticEqual && evidenceChanged;
      const diff = semanticEqual
        ? null
        : validationDiff.parse({
            version: 2,
            expected: expectedPlan,
            actual: {
              orderId: live.orderId,
              currency: PURCHASE_CURRENCY,
              statedTotal: live.statedTotal,
              lines: canonical(
                live.lines.map(
                  ({ code: _code, explicitProduct: _explicit, ...line }) =>
                    line,
                ),
              ),
            },
            corrections: comparison.corrections,
            notes: comparison.notes,
            rawEvidenceDrift: evidenceChanged,
          });
      const outcome = semanticEqual
        ? rawEvidenceDrift
          ? "raw_evidence_drift"
          : "replayed"
        : "semantic_drift";
      await database
        .update(runTarget)
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
        .where(eq(runTarget.id, target.id));
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
    await database.insert(runOperation).values({
      runId: scope.public.runId,
      operationId: input._runExecution.operationId,
      kind: "validate_purchase_import",
      inputFingerprint: argsFingerprint,
      state: "completed",
      result,
      completedAt: new Date(),
    });
    return result;
  });
}

/** What a targeted browser capture retains in `RunEvidence.sourceMetadata`. */
const retainedCaptureMetadata = z.object({
  requestedAmazonAsin: z.string().nullish(),
  servedAmazonAsin: z.string().nullish(),
  sourceURL: z.url().optional(),
  canonicalUrl: z.url().nullish(),
  structuredProducts: browserStructuredProducts.nullish(),
  variantMarkers: z.array(z.string()).default([]),
  images: z
    .array(
      z.object({
        url: z.url(),
        naturalWidth: z.number().int().positive().nullable(),
        naturalHeight: z.number().int().positive().nullable(),
        highResolutionUrl: z.url().nullable(),
      }),
    )
    .default([]),
});

/**
 * Identifiers this Product carries or is committing, for proving which exact
 * variant a catalog page shows. A committed identifier another Product owns
 * does not count: it will be proposed for a match, not learned.
 */
async function productIdentifierCandidates(
  db: Database,
  productId: ProductId,
  committing: NonNullable<
    CommitProductEnrichmentInput["changes"]["identifiers"]
  >,
): Promise<ProvableIdentifier[]> {
  const database = getDb(db);
  const stored = await database
    .select({
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .where(
      and(
        eq(entityExternalId.entityId, productId),
        notDeleted(entityExternalId),
      ),
    );
  const candidates: ProvableIdentifier[] = [...stored];
  for (const identifier of committing) {
    const [owned] = await database
      .select({ entityId: entityExternalId.entityId })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.source, identifier.source),
          eq(entityExternalId.kind, identifier.kind),
          eq(entityExternalId.externalId, identifier.externalId),
          notDeleted(entityExternalId),
        ),
      )
      .limit(1);
    if (!owned || owned.entityId === productId) candidates.push(identifier);
  }
  return candidates;
}

const withoutUnlearnedIdentifiers = <T extends string>(
  fields: readonly T[],
  learnedIdentifier: boolean,
) => fields.filter((field) => field !== "identifiers" || learnedIdentifier);

type SkippedEnrichmentIdentifier = z.output<
  typeof commitProductEnrichmentOut
>["skippedIdentifiers"][number];

/**
 * Prove one identifier from this target's retained browser evidence and learn
 * it. A proven identifier another Product owns is never reassigned and never
 * aborts the commit: it becomes a match proposal. An unproven one throws,
 * because that is write authority, not a collision.
 */
async function commitEnrichmentIdentifier(
  tx: DrizzleTransaction,
  input: {
    productId: ProductId;
    identifier: NonNullable<
      CommitProductEnrichmentInput["changes"]["identifiers"]
    >[number];
    runId: string;
    targetId: string;
    allowedHosts: string[];
  },
): Promise<{ skipped?: SkippedEnrichmentIdentifier }> {
  const { productId, identifier } = input;
  const [evidence] = await tx
    .select({ metadata: runEvidence.sourceMetadata })
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.id, identifier.evidenceId),
        eq(runEvidence.runId, input.runId),
        eq(runEvidence.targetId, input.targetId),
        eq(runEvidence.kind, "browser_capture"),
      ),
    )
    .limit(1);
  const observed = retainedCaptureMetadata.safeParse(evidence?.metadata);
  const amazonId = identifier.externalId.toUpperCase();
  const amazonProven =
    observed.success &&
    identifier.kind === "asin" &&
    observed.data.requestedAmazonAsin?.toUpperCase() === amazonId &&
    observed.data.servedAmazonAsin?.toUpperCase() === amazonId;
  const proof = amazonProven
    ? { proven: true as const, externalId: amazonId }
    : observed.success
      ? proveStructuredIdentifier(identifier, observed.data, input.allowedHosts)
      : { proven: false as const };
  if (!proof.proven)
    throw new Error(
      "Product identifier was not proven by this target's retained evidence",
    );
  try {
    await learnPurchaseProductExternalId(tx, {
      productId,
      source: identifier.source,
      kind: identifier.kind,
      externalId: proof.externalId,
      url: identifier.url,
    });
    return {};
  } catch (error) {
    if (!(error instanceof PurchaseProductExternalIdCollisionError))
      throw error;
    await upsertAgentProductMatch(tx, {
      productIds: [productId, error.ownerProductId],
      evidence: `Retained browser evidence proves ${error.source}/${error.kind} ${error.externalId} for this Product's exact variant, but it already identifies the other Product. Confirm whether both are the same exact variant before merging.`,
      sourceUrls:
        observed.success && observed.data.sourceURL
          ? [observed.data.sourceURL]
          : [],
    });
    const [owner] = await tx
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, error.ownerProductId))
      .limit(1);
    if (!owner) throw error;
    return {
      skipped: {
        source: error.source,
        kind: error.kind,
        externalId: error.externalId,
        ownerProductId: productShortcode.parse(owner.shortcode),
      },
    };
  }
}

/** Fill only blank Product identity fields for an explicit enrichment target. */
// eslint-disable-next-line complexity -- Each approved field class and evidence kind is verified in one bounded commit.
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
  const fingerprint = await sha256Hex(JSON.stringify(input));
  const [existing] = await database
    .select({
      inputFingerprint: runOperation.inputFingerprint,
      result: runOperation.result,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.public.runId),
        eq(runOperation.operationId, operationId),
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
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, scope.public.runId),
        eq(runTarget.entityId, productId),
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
      .select({ metadata: runEvidence.sourceMetadata })
      .from(runEvidence)
      .where(
        and(
          eq(runEvidence.id, changes.image.evidenceId),
          eq(runEvidence.runId, scope.public.runId),
          eq(runEvidence.targetId, targetRef.id),
          eq(runEvidence.kind, "browser_capture"),
        ),
      )
      .limit(1);
    const metadata = retainedCaptureMetadata.safeParse(evidence?.metadata);
    const exactVariant =
      metadata.success &&
      (metadata.data.requestedAmazonAsin != null
        ? metadata.data.requestedAmazonAsin === metadata.data.servedAmazonAsin
        : structuredPageProvesExactVariant(
            await productIdentifierCandidates(
              db,
              productId,
              changes.identifiers ?? [],
            ),
            metadata.data,
            scope.public.allowedHosts,
          ));
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
  let committed: z.output<typeof commitProductEnrichmentOut>;
  try {
    committed = await withTransaction(
      db,
      // eslint-disable-next-line complexity -- The bounded commit revalidates every approved field and evidence class atomically.
      async (tx) => {
        const [lockedRun] = await tx
          .select({ status: runTable.status })
          .from(runTable)
          .where(eq(runTable.id, scope.public.runId))
          .limit(1)
          .for("update");
        if (lockedRun?.status !== "running")
          throw new Error(
            `Import run is fenced in status ${lockedRun?.status ?? "missing"}`,
          );
        const [target] = await tx
          .select({
            id: runTarget.id,
            targetFingerprint: runTarget.targetFingerprint,
          })
          .from(runTarget)
          .where(
            and(
              eq(runTarget.runId, scope.public.runId),
              eq(runTarget.entityId, productId),
            ),
          )
          .limit(1)
          .for("update");
        if (!target || target.targetFingerprint !== input.targetFingerprint)
          throw new Error("Product enrichment target changed before commit");
        const current = await productEnrichmentTarget(tx, productId, {
          lock: true,
        });
        if (!current)
          throw new Error("Product enrichment target was not found");
        const { live } = current;
        if (current.fingerprint !== input.targetFingerprint)
          throw new Error("Product enrichment target changed before commit");
        if (
          (changes.manufacturer && live.manufacturer.trim()) ||
          (changes.categoryId && live.categoryId) ||
          (changes.model && live.model)
        )
          throw new Error(
            "Overwriting a populated Product field requires typed approval",
          );
        await tx.insert(runOperation).values({
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
        let learnedIdentifier = false;
        const skippedIdentifiers: SkippedEnrichmentIdentifier[] = [];
        for (const identifier of changes.identifiers ?? []) {
          const outcome = await commitEnrichmentIdentifier(tx, {
            productId,
            identifier,
            runId: scope.public.runId,
            targetId: target.id,
            allowedHosts: scope.public.allowedHosts,
          });
          if (outcome.skipped) skippedIdentifiers.push(outcome.skipped);
          else learnedIdentifier = true;
        }
        if (importedImageId) {
          const existingAttachment = await tx.query.entityAttachment.findFirst({
            where: and(
              eq(entityAttachment.entityId, productId),
              eq(entityAttachment.imageId, importedImageId),
              notDeleted(entityAttachment),
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
            .update(entityAttachment)
            .set({ sortOrder: sql`${entityAttachment.sortOrder} + 1` })
            .where(
              and(
                eq(entityAttachment.entityId, productId),
                notDeleted(entityAttachment),
              ),
            );
          if (existingAttachment) {
            // The same stored image may already be an item attachment. Its
            // link is unique per live Product/Image pair, so promote it in
            // place instead of attempting a duplicate insert; do not rewrite
            // its purpose or Image provenance merely because this URL recurs.
            await tx
              .update(entityAttachment)
              .set({ sortOrder: 0 })
              .where(eq(entityAttachment.id, existingAttachment.id));
          } else {
            await tx.insert(entityAttachment).values({
              entityId: productId,
              entityKind: "product",
              role: "attachment",
              imageId: importedImageId,
              sortOrder: 0,
              purpose: "item",
            });
          }
        }
        // An identifier that only produced a match proposal changed nothing.
        const committedFields = withoutUnlearnedIdentifiers(
          changedFields,
          learnedIdentifier,
        );
        await recordRunWrites(
          tx,
          actorInRun(actor, runEntityId.parse(scope.public.runId)),
          [
            {
              entityKind: "product",
              entityId: productId,
              action: "update",
              fields: committedFields,
            },
          ],
        );
        await tx
          .update(runTarget)
          .set({
            state: "completed",
            outcome: "enriched",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(runTarget.id, target.id));
        const result = commitProductEnrichmentOut.parse({
          runId: scope.public.shortcode,
          operationId,
          productId: input.productId,
          status: "running",
          changedFields: committedFields,
          skippedIdentifiers,
        });
        await tx
          .update(runOperation)
          .set({
            state: "completed",
            result,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runOperation.runId, scope.public.runId),
              eq(runOperation.operationId, operationId),
            ),
          );
        return result;
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
        runId: scope.public.runId,
      });
    } catch (error) {
      // Enrichment has committed. Optional processing cannot turn a successful
      // import into a reported failure; the original remains displayable.
      Sentry.captureException(error, {
        tags: { operation: "product-enrichment.schedule-image-processing" },
      });
    }
  }
  return committed;
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
      .select({ targetFingerprint: runTarget.targetFingerprint })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          eq(runTarget.entityId, resolvedProductId),
        ),
      )
      .limit(1);
    if (!target || target.targetFingerprint !== input.targetFingerprint)
      throw new Error("Product enrichment target changed before approval");
    const current = await productEnrichmentTarget(database, resolvedProductId);
    if (!current) throw new Error("Product enrichment target was not found");
    const { live } = current;
    if (current.fingerprint !== input.targetFingerprint)
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
      .update(runTarget)
      .set({
        state: "completed",
        outcome: "enriched",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          eq(runTarget.entityId, resolvedProductId),
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
      kind: runOperation.kind,
      state: runOperation.state,
      result: runOperation.result,
      error: runOperation.error,
      startedAt: runOperation.startedAt,
      completedAt: runOperation.completedAt,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.public.runId),
        eq(runOperation.operationId, input._runExecution.operationId),
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
