import type { ActorContext } from "@cubby/schemas/context";
import { GTIN_KIND, GTIN_SOURCE } from "@cubby/schemas/external-id";
import {
  type LedgerPartyId,
  type RunId,
  parseEntityId,
  type VendorId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  extractedPurchaseLine,
  importExtractionOutcome,
  importSourceIdentity,
  importSourceKind,
  runPurpose,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  importOperationStatusInput,
  importOperationStatusOut,
  type CommitPurchaseImportInput,
  type PreparePurchaseImportInput,
  type PurchaseImportRunExecution,
  type RunPurpose,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import {
  expense,
  importPreparedLine,
  importPreparedOrder,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  product,
  purchase,
  run as runTable,
  runTarget,
  vendor,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
  type ExternalIdPair,
} from "~/server/repo/product/find-by-external-ids";
import { findProductNameCandidates } from "~/server/repo/product/resolve-names";
import { readOperation } from "~/server/repo/run-operation";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { findOrCreateVendor } from "~/server/repo/vendor";
import { ensureRun } from "~/server/runs/ensure-run";
import { executeAtomicOperation } from "~/server/runs/operation";

import { assertRunCapability } from "./capabilities";
import { ensureMailVendorAccount } from "./gmail/mail-account";
import { attachOrderLineThumbnails } from "./line-thumbnails";
import { linkImportedMail } from "./mail-tool";
import {
  MODEL_STYLE_MATCH_REASON,
  manufacturerPartRequests,
  modelStyleTokens,
  sharesModelWithinManufacturer,
} from "./manufacturer-identity";
import { auditAllImportBatches } from "./run-service";
import { resolveImportSourceOrder } from "./source-claim-family";
import { sourceOrderKey } from "./source-order-key";
import { amazonAsin, importVendorOrder } from "./writer";

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

type ImportScope = {
  runId: RunId;
  shortcode: string;
  purpose: RunPurpose;
  status: string;
  ledgerPartyId: LedgerPartyId;
  vendorId: VendorId | null;
  vendorAccountId: string | null;
};

async function loadImportScope(
  db: Database,
  runId: RunId,
  actor: ActorContext,
): Promise<ImportScope> {
  const [row] = await getDb(db)
    .select({
      runId: runTable.id,
      shortcode: runTable.shortcode,
      purpose: runTable.purpose,
      status: runTable.status,
      ledgerPartyId: runTable.ledgerPartyId,
      actorUserId: runTable.actorUserId,
      vendorId: runTable.vendorId,
      vendorAccountId: runTable.vendorAccountId,
    })
    .from(runTable)
    .where(and(eq(runTable.id, runId), notDeleted(runTable)))
    .limit(1);
  if (!row?.ledgerPartyId)
    throw new Error("Import run ownership is unavailable");
  if (row.actorUserId !== actor.userId)
    throw new Error("Purchase import run is not owned by this member");
  return {
    runId: row.runId,
    shortcode: row.shortcode,
    purpose: runPurpose.parse(row.purpose),
    status: row.status,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    vendorAccountId: row.vendorAccountId,
  };
}

/**
 * The Run an import call writes under: Pi names its own Run by private id, a
 * member names the Run its preparation returned, and a member's preparation
 * without either opens one (keyed by its operation id, so a retried
 * preparation finds the same Run).
 */
async function importRunScope(
  db: Database,
  actor: ActorContext,
  execution: PurchaseImportRunExecution,
  open: boolean,
): Promise<ImportScope> {
  if (execution.runId)
    return loadImportScope(db, runEntityId.parse(execution.runId), actor);
  if (execution.run)
    return loadImportScope(
      db,
      await resolveOrThrow(db, "run", execution.run),
      actor,
    );
  if (!open)
    throw new Error(
      "Name the import Run (`run`) that this import's preparation returned.",
    );
  const runId = await ensureRun(db, actor, {
    purpose: "file_import",
    trigger: "manual",
    status: "running",
    clientKey: `purchase-import:${actor.userId}:${execution.operationId}`,
  });
  return loadImportScope(db, runId, actor);
}

/** An order's Vendor: named, created by exact name, or the import Run's own. */
async function preparedOrderVendor(
  db: Database,
  order: PreparePurchaseImportInput["orders"][number],
  scope: ImportScope,
): Promise<VendorId> {
  const vendorId = order.vendorId
    ? await resolveOrThrow(db, "vendor", order.vendorId)
    : order.vendor
      ? await findOrCreateVendor(db, order.vendor.name)
      : scope.vendorId;
  if (!vendorId)
    throw new Error("Name each order's Vendor (vendorId or vendor.name).");
  return vendorId;
}

type RetainedMailSource = typeof orderMail.$inferSelect;

/**
 * A mail-sourced order must name the member's own retained Email unchanged,
 * never a model-provided key or bytes. A Mail import Run may use only mail
 * sources of the Emails it admitted: any other kind would carry an arbitrary
 * key and checksum past that check.
 */
async function retainedMailSource(
  db: Database,
  scope: ImportScope,
  source: z.infer<typeof importSourceIdentity>,
  evidenceChecksum: string,
): Promise<RetainedMailSource | null> {
  if (source.kind !== "mail_message" && source.kind !== "mail_attachment") {
    if (scope.purpose === "mail_import")
      throw new Error("A Mail import Run imports only the Emails it admitted.");
    return null;
  }
  const match = /^gmail:(.+?):([^:]+)(?::attachment:(.+))?$/u.exec(
    source.externalKey,
  );
  const [, mailboxId, messageId, attachmentId] = match ?? [];
  const isAttachment = source.kind === "mail_attachment";
  if (!mailboxId || !messageId || Boolean(attachmentId) !== isAttachment)
    throw new Error(
      "A mail source key is gmail:<mailboxId>:<messageId>[:attachment:<attachmentId>].",
    );
  const database = getDb(db);
  const [retained] = await database
    .select({ mail: orderMail, message: mailboxMessage })
    .from(orderMail)
    .innerJoin(
      mailboxMessage,
      and(
        eq(mailboxMessage.ledgerPartyId, orderMail.ledgerPartyId),
        eq(mailboxMessage.mailboxId, orderMail.mailboxId),
        eq(mailboxMessage.messageId, orderMail.messageId),
      ),
    )
    .where(
      and(
        eq(orderMail.ledgerPartyId, scope.ledgerPartyId),
        eq(orderMail.mailboxId, mailboxId),
        eq(orderMail.messageId, messageId),
      ),
    )
    .limit(1);
  const usable =
    retained &&
    retained.message.orderMailId === retained.mail.id &&
    !["excluded", "deleted"].includes(retained.message.status) &&
    retained.message.classification !== "unrelated";
  let checksum = retained?.mail.rawChecksum;
  if (usable && attachmentId) {
    const [attachment] = await database
      .select({ checksum: orderMailAttachment.checksum })
      .from(orderMailAttachment)
      .where(
        and(
          eq(orderMailAttachment.orderMailId, retained.mail.id),
          eq(orderMailAttachment.providerAttachmentId, attachmentId),
        ),
      )
      .limit(1);
    checksum = attachment?.checksum;
  }
  if (
    !usable ||
    checksum !== source.checksum ||
    evidenceChecksum !== source.checksum
  )
    throw new Error(
      "Purchase import must use the member's retained Email unchanged.",
    );
  if (scope.purpose === "mail_import") {
    const [target] = await database
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.runId),
          eq(runTarget.workKey, retained.mail.id),
        ),
      )
      .limit(1);
    if (!target)
      throw new Error("This Mail import Run did not admit that Email.");
  }
  return retained.mail;
}

const lineIdentifierRequests = (
  source: string,
  line: z.infer<typeof extractedPurchaseLine>,
): ExternalIdPair[] => {
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
    ...manufacturerPartRequests(line),
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
  const fuzzy = await findProductNameCandidates(db, line.title);
  const exactProductIds = new Set(exact.map(({ id }) => id));
  const modelTokens = modelStyleTokens(line.title).map((token) =>
    token.toLowerCase(),
  );
  const sharedModel = modelTokens.length
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
            inArray(sql`lower(${product.model})`, modelTokens),
          ),
        )
        .limit(20)
    : [];
  // A shared model/style number only ranks: it never claims an exact variant.
  const modelRanked = sharedModel.filter(
    (hit) =>
      !exactProductIds.has(hit.id) &&
      sharesModelWithinManufacturer(line.title, hit),
  );
  const modelRankedIds = new Set(modelRanked.map(({ id }) => id));
  return [
    ...exact,
    ...modelRanked,
    ...fuzzy.filter(
      ({ id }) => !exactProductIds.has(id) && !modelRankedIds.has(id),
    ),
  ]
    .slice(0, 20)
    .map(({ id, shortcode, ...candidate }) => ({
      productId: shortcode,
      ...candidate,
      exactIdentifierMatch: exactProductIds.has(id),
      matchReason: modelRankedIds.has(id)
        ? MODEL_STYLE_MATCH_REASON
        : undefined,
    }));
}

type TargetRow = typeof purchase.$inferSelect;

/** The writer's own target fences, checked at prepare and again at commit. */
function assertReviewedTarget(
  input: {
    vendorId: VendorId;
    orderId: string | null;
    targetPurchaseId?: string | null;
  },
  found: {
    chosen: TargetRow | undefined;
    ordered: TargetRow | undefined;
    claim: { purchaseId: string } | undefined;
  },
) {
  const { chosen, ordered, claim } = found;
  if (input.targetPurchaseId && !chosen)
    throw new Error("The reviewed Purchase target no longer exists.");
  // A fresh no-ID original may converge on the reviewed Purchase that already
  // knows its order id; the writer keeps that id (see importVendorOrder).
  if (
    chosen &&
    (chosen.vendorId !== input.vendorId ||
      (chosen.orderId !== null &&
        chosen.orderId !== input.orderId &&
        input.orderId !== null))
  )
    throw new Error(
      "The reviewed Purchase target has a different vendor or order identity.",
    );
  if (chosen && ordered && chosen.id !== ordered.id)
    throw new Error(
      "Another Purchase already owns this vendor order. Review the two Purchases before importing.",
    );
  if (chosen && claim && claim.purchaseId !== chosen.id)
    throw new Error("This source already belongs to a different Purchase.");
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
  const retained = await resolveImportSourceOrder(
    database,
    {
      ledgerPartyId: input.ledgerPartyId,
      kind: input.sourceKind,
      externalKey: input.sourceExternalKey,
      orderKey: sourceOrderKey(input),
    },
    { lock: "share", writable: true },
  );
  const claim = retained?.association;
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
  assertReviewedTarget(input, { chosen, ordered, claim });
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
        ? {
            id: claim.id,
            checksum: claim.checksum,
            purchaseId: claim.purchaseId,
            updatedAt: claim.updatedAt.toISOString(),
          }
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

// Two orders of one source with the same Vendor and order id (or both
// without one) would collapse into one source order on commit.
function claimDistinctSourceOrder(
  seen: Set<string>,
  order: PreparePurchaseImportInput["orders"][number],
  vendorId: VendorId,
) {
  const key = JSON.stringify([
    order.source.kind,
    order.source.externalKey,
    sourceOrderKey({
      vendorId,
      orderId: order.extraction.candidate?.orderId ?? null,
    }),
  ]);
  if (seen.has(key))
    throw new Error(
      "Two orders from one source name the same Vendor and order id; prepare distinct orders or one order.",
    );
  seen.add(key);
}

export async function preparePurchaseImport(
  db: Database,
  rawInput: PreparePurchaseImportInput,
  actor: ActorContext,
) {
  const input = preparePurchaseImportInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, true);
  assertRunCapability(scope.purpose, "prepare");
  return executeAtomicOperation(
    db,
    {
      runId: scope.runId,
      operationId: input._runExecution.operationId,
      kind: "prepare_purchase_import",
      // Only the orders: the envelope is not part of a preparation's identity.
      payload: input.orders,
      subject: "Preparation",
    },
    (ledger) =>
      withTransactionDatabase(db, async (transactionDb) => {
        const database = getDb(transactionDb);
        const replayed = await ledger.replay(
          database,
          preparePurchaseImportOut,
        );
        if (replayed) return replayed;
        if (scope.status !== "running")
          throw new Error(`Purchase import run is fenced in ${scope.status}`);
        // After replay: a completed prepare returns its recorded result even
        // once its Email is excluded or resolved.
        for (const order of input.orders)
          await retainedMailSource(
            transactionDb,
            scope,
            order.source,
            order.evidenceChecksum,
          );
        await ledger.start(database);

        const outputOrders = [];
        const sourceOrders = new Set<string>();
        for (const order of input.orders) {
          const vendorId = await preparedOrderVendor(
            transactionDb,
            order,
            scope,
          );
          claimDistinctSourceOrder(sourceOrders, order, vendorId);
          const primaryDocumentImageId = order.primaryDocumentImageId
            ? await resolveOrThrow(
                transactionDb,
                "image",
                order.primaryDocumentImageId,
              )
            : null;
          const screenshotImageId = order.screenshotImageId
            ? await resolveOrThrow(
                transactionDb,
                "image",
                order.screenshotImageId,
              )
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
          const targetFingerprint = await computeTargetFingerprint(
            transactionDb,
            {
              ledgerPartyId: scope.ledgerPartyId,
              vendorId,
              sourceKind: order.source.kind,
              sourceExternalKey: order.source.externalKey,
              orderId: candidate.orderId,
              targetPurchaseId,
            },
          );
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
              runId: scope.runId,
              vendorId,
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
          const exactRequests: ExternalIdPair[][] = [];
          for (const line of candidate.lines) {
            const source =
              line.sku || amazonAsin(line.productUrl)
                ? await resolveProductIdentifierSource(transactionDb, {
                    url: line.productUrl,
                    vendorId,
                  })
                : "";
            exactRequests.push(lineIdentifierRequests(source, line));
          }
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
          runId: scope.shortcode,
          operationId: input._runExecution.operationId,
          status: "running",
          orders: outputOrders,
        });
        await ledger.complete(database, result);
        return result;
      }),
  );
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

/**
 * A recorded commit result: the public result plus the `requiresReview` that
 * finalizes the Run on replay (absent on the oldest rows, which read false).
 */
const recordedCommit = commitPurchaseImportOut.extend({
  requiresReview: z.boolean().catch(false),
});

// The transaction deliberately keeps replay, evidence, resolution, and write
// fences together so no partial extraction can escape as a business effect.
export async function commitPurchaseImport(
  db: Database,
  rawInput: CommitPurchaseImportInput,
  actor: ActorContext,
) {
  const input = commitPurchaseImportInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, false);
  assertRunCapability(scope.purpose, "commit_purchase_import");
  const transactionResult = await executeAtomicOperation(
    db,
    {
      runId: scope.runId,
      operationId: input._runExecution.operationId,
      kind: "commit_purchase_import",
      payload: operationArgs(input),
      subject: "Commit",
      recordFailure: true,
    },
    (ledger) =>
      withTransactionDatabase(
        db,
        // eslint-disable-next-line complexity
        async (transactionDb) => {
          const database = getDb(transactionDb);
          const replayed = await ledger.replay(database, recordedCommit, {
            forUpdate: true,
          });
          if (replayed) {
            const { requiresReview, ...result } = replayed;
            return { result, requiresReview };
          }
          if (scope.status !== "running")
            throw new Error(`Purchase import run is fenced in ${scope.status}`);
          const prepared = await loadPreparation(
            transactionDb,
            scope.runId,
            input.prepareOperationId,
          );
          // A prepared Vendor may have been deleted or merged away since
          // prepare; the commit must not book a Purchase against it.
          const orderVendor = async (order: StoredPreparation["order"]) => {
            const vendorId = order.vendorId ?? scope.vendorId;
            if (!vendorId)
              throw new Error("Prepared purchase import order has no Vendor");
            const [live] = await getDb(transactionDb)
              .select({ id: vendor.id })
              .from(vendor)
              .where(and(eq(vendor.id, vendorId), notDeleted(vendor)));
            if (!live)
              throw new Error(
                "The prepared order's Vendor was deleted or merged; prepare it again.",
              );
            return vendorId;
          };
          const mailSources = new Map<string, RetainedMailSource | null>();
          for (const { order } of prepared)
            mailSources.set(
              order.id,
              await retainedMailSource(
                transactionDb,
                scope,
                {
                  kind: importSourceKind.parse(order.sourceKind),
                  externalKey: order.sourceExternalKey,
                  checksum: order.sourceChecksum,
                },
                order.evidenceChecksum,
              ),
            );
          const defaultProjectId = input.defaultProjectId
            ? await resolveOrThrow(
                transactionDb,
                "project",
                input.defaultProjectId,
              )
            : null;
          await ledger.start(database);
          for (const { order } of prepared) {
            const extraction = importExtractionOutcome.parse(order.extraction);
            const targetFingerprint = await computeTargetFingerprint(
              transactionDb,
              {
                ledgerPartyId: scope.ledgerPartyId,
                vendorId: await orderVendor(order),
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
          // Mail orders whose line thumbnails are fetched after commit.
          const thumbnailWork: Parameters<
            typeof attachOrderLineThumbnails
          >[1][] = [];
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
              } else if (resolution.kind === "expense_only") {
                productResolutions.push({
                  kind: "expense_only" as const,
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
            const vendorId = await orderVendor(order);
            const mailSource = mailSources.get(order.id) ?? null;
            // A mail import's Purchase belongs to the member's (mail-only)
            // VendorAccount.
            const vendorAccountId =
              scope.vendorAccountId ??
              (mailSource
                ? (
                    await ensureMailVendorAccount(transactionDb, {
                      vendorId,
                      ledgerPartyId: scope.ledgerPartyId,
                    })
                  ).id
                : null);
            const result = await importVendorOrder(
              transactionDb,
              {
                targetPurchaseId: order.targetPurchaseId,
                defaultTrade: input.defaultTrade,
                defaultProjectId: defaultProjectId ?? undefined,
                runId: scope.runId,
                ledgerPartyId: scope.ledgerPartyId,
                vendorId,
                vendorAccountId,
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
              // Without a commit default the import never invents a Purchase
              // purpose: inheritance resolves first, then only still
              // unassigned principal lines get Other.
              {
                applyUnassignedPurposeFallback:
                  input.defaultTrade === undefined,
              },
            );
            const [written] = result.purchaseId
              ? await database
                  .select({ shortcode: purchase.shortcode })
                  .from(purchase)
                  .where(
                    eq(
                      purchase.id,
                      parseEntityId("purchase", result.purchaseId),
                    ),
                  )
                  .limit(1)
              : [];
            // An attachment's commit links and settles its parent Email.
            const linksMail = result.outcome !== "conflict";
            // A member's dismissal of this Email for the Purchase the writer
            // reached wins over the import; the whole commit rolls back.
            // linkOrderMail refuses it for a linked Email; this covers the
            // conflict outcome that is not linked.
            if (result.purchaseId && mailSource && !linksMail) {
              const [dismissed] = await database
                .select({ id: orderMailCandidateDecision.id })
                .from(orderMailCandidateDecision)
                .innerJoin(
                  orderMailEvent,
                  eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
                )
                .where(
                  and(
                    eq(orderMailEvent.orderMailId, mailSource.id),
                    eq(
                      orderMailCandidateDecision.purchaseId,
                      parseEntityId("purchase", result.purchaseId),
                    ),
                    eq(orderMailCandidateDecision.decision, "dismissed"),
                  ),
                )
                .limit(1);
              if (dismissed)
                throw new Error(
                  "A member dismissed this Email for that Purchase; review the Email before importing it.",
                );
            }
            if (result.purchaseId && mailSource && linksMail) {
              await linkImportedMail(transactionDb, {
                mail: mailSource,
                event: extraction.candidate?.sourceEvent ?? "confirmation",
                purchaseId: result.purchaseId,
                actorUserId: actor.userId,
                runId: scope.runId,
              });
              if (result.outcome === "created" || result.outcome === "updated")
                thumbnailWork.push({
                  purchaseId: parseEntityId("purchase", result.purchaseId),
                  mailContent: mailSource.content,
                  lines: extraction.candidate?.lines ?? [],
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
            runId: scope.shortcode,
            operationId: input._runExecution.operationId,
            status: requiresReview ? "needs_review" : "running",
            items,
          });
          await ledger.complete(database, {
            ...publicResult,
            requiresReview,
          });
          // A member's own import Run ends with its commit; Pi's Mail import
          // Run continues with its next Email.
          const memberImport =
            scope.purpose === "file_import" && !requiresReview;
          await database
            .update(runTable)
            .set({
              status: memberImport ? "completed" : "running",
              endedAt: memberImport ? new Date() : null,
              failureCode: null,
              updatedAt: new Date(),
            })
            .where(eq(runTable.id, scope.runId));
          return { result: publicResult, requiresReview, thumbnailWork };
        },
      ),
  );
  // Network work stays outside the import transaction; each is best-effort.
  for (const work of transactionResult.thumbnailWork ?? [])
    await attachOrderLineThumbnails(db, work);
  if (transactionResult.requiresReview) {
    await finalizeReviewRun(db, scope.runId, input._runExecution.operationId);
  }
  return transactionResult.result;
}

export async function purchaseImportOperationStatus(
  db: Database,
  rawInput: z.input<typeof importOperationStatusInput>,
  actor: ActorContext,
) {
  const input = importOperationStatusInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, false);
  const operation = await readOperation(getDb(db), {
    runId: scope.runId,
    operationId: input._runExecution.operationId,
  });
  if (!operation) throw new Error("Purchase import operation was not found");
  return importOperationStatusOut.parse({
    runId: scope.shortcode,
    operationId: input._runExecution.operationId,
    kind: operation.kind,
    state: operation.state,
    result: operation.result,
    error: operation.error,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  });
}
