import { actorInRun, type ActorContext } from "@cubby/schemas/context";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type LedgerPartyId,
  parseEntityId,
  type ProductId,
  type RunId,
  type VendorId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  extractedPurchaseLine,
  importExtractionOutcome,
  importWriterInput,
  importSourceKind,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  importOperationStatusInput,
  importOperationStatusOut,
  type CommitPurchaseImportInput,
  type ExtractedPurchaseLine,
  type PreparePurchaseImportInput,
  type PurchaseImportRunExecution,
} from "@cubby/schemas/purchase-import";
import { minorToMoney } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { DecisionPort } from "~/server/ai/decision-model";
import type { Database } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import {
  getDb,
  notDeleted,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { recordKey, evidenceBinding } from "~/server/db/kernel-schema";
import {
  expense,
  importPreparedLine,
  importPreparedOrder,
  email as emailTable,
  product,
  purchase,
  run as runTable,
  sourceOrderObservation,
  vendor,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { emailLinkDecisionsRead } from "~/server/domains/email/repo/email-decision-sql";
import { readEmailPurchaseAssociations } from "~/server/domains/email/repo/email-purchase-associations";
import { decideExpenseLineRole } from "~/server/domains/expense/service/expense-line-role";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
  type ExternalIdPair,
} from "~/server/domains/product/repo/find-by-external-ids";
import { productIdentityOverlap } from "~/server/domains/product/repo/match/product-identity-overlap";
import { resolveProductIdentifierSource } from "~/server/domains/product/repo/product-identifier-source";
import {
  findExactProductNameMatches,
  findProductIdentityReviewCandidates,
  findProductNameCandidates,
  PRODUCT_IDENTITY_REVIEW_REASON,
} from "~/server/domains/product/repo/resolve-names";
import { auditAllImportBatches } from "~/server/domains/purchase-import/operations/run-review";
import { acceptedOrders } from "~/server/domains/purchase-import/repo/accepted-order-read";
import {
  type ImportScope,
  loadImportScope,
  canonicalMailSourceKey,
  parseMailSourceKey,
  type RetainedMailSource,
  retainedMailSource,
  readUnchangedMailSource,
} from "~/server/domains/purchase-import/repo/import-scope";
import { releaseUnsettledMailRunSources } from "~/server/domains/purchase-import/repo/mail-run-membership";
import {
  MODEL_STYLE_MATCH_REASON,
  modelStyleTokens,
  sharesModelWithinManufacturer,
} from "~/server/domains/purchase-import/repo/manufacturer-identity";
import {
  resolveImportSourceOrder,
  recordRetainedImportAcceptance,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { sourceOrderKey } from "~/server/domains/purchase-import/repo/source-order-key";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeAtomicOperation } from "~/server/domains/run/repo/operation";
import { assertRunCapability } from "~/server/domains/run/repo/purpose-policy";
import { readOperation } from "~/server/domains/run/repo/run-operation";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { householdWrite, decide, recordSubject } from "~/server/kernel/api";
import { enterWriteTransaction } from "~/server/kernel/gate";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { linkExactOrderEmails } from "../repo/email-purchase-decision";
import { readExistingOrderCandidates } from "../repo/existing-order-candidates";
import { ensureMailVendorAccount } from "../repo/gmail/mail-account";
import {
  importVendorCandidates,
  resolveImportVendor,
} from "../repo/import-vendor";
import {
  appendOrderEvidence,
  orderEventKey,
  orderPaymentKeys,
} from "../repo/order-evidence";
import {
  canonicalOrderId,
  findVendorOrderOwner,
  normalizeOrderKey,
  reviewedVendorOrderOwner,
} from "../repo/order-identity";
import { settleOrderEvidence } from "../repo/settle-order-evidence";
import { lineIdentifierRequests } from "../repo/writer-decisions";
import { planFallbackExpenses } from "../repo/writer-plan";
import { attachOrderLineThumbnails } from "./line-thumbnails";
import {
  prepareMailAttachmentDecisions,
  type PreparedMailAttachmentDecisions,
} from "./mail-attachment-purpose";
import {
  applyMailSourceAdmissions,
  prepareMailSourceAdmissions,
} from "./mail-source-admission";
import { linkImportedMail } from "./mail-tool";

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

/**
 * An order's Vendor: named by id, matched or created from its named seller
 * (`resolveImportVendor`), else the import Run's own. A named seller also
 * returns the candidates it was matched against, read before any creation.
 */
async function preparedOrderVendor(
  db: Database,
  order: PreparePurchaseImportInput["orders"][number],
  scope: ImportScope,
  mail: RetainedMailSource | null | undefined,
  actor: ActorContext,
) {
  const seller = order.vendor
    ? {
        name: order.vendor.name,
        sender: mail?.sender ?? null,
        evidence: mail ? order.source.externalKey : null,
        distinctFrom: order.vendor.distinctFrom,
      }
    : null;
  const vendorCandidateRows = seller
    ? await importVendorCandidates(db, seller)
    : [];
  const vendorCandidates = vendorCandidateRows.map(
    ({ candidate }) => candidate,
  );
  const vendorId = order.vendorId
    ? await resolveOrThrow(db, "vendor", order.vendorId)
    : seller
      ? await resolveImportVendor(db, seller, actor, vendorCandidateRows)
      : scope.vendorId;
  if (!vendorId)
    throw new Error("Name each order's Vendor (vendorId or vendor.name).");
  // Resolution and this fence share the preparation transaction: a refused
  // Vendor rolls back, while Sender proof can still learn a valid alias.
  if (
    scope.purpose === "mail_import" &&
    scope.vendorId &&
    vendorId !== scope.vendorId
  )
    throw new Error("This Mail import is limited to its selected Vendor.");
  return { vendorId, vendorCandidates };
}

/**
 * The one live Purchase of this Vendor a retained Email is already linked
 * to. An order with no order id cannot converge on an existing Purchase by
 * (Vendor, order id), so importing it without a target would book its lines
 * a second time; the reviewed link is the target instead. An Email linked to
 * several Purchases stays ambiguous and keeps no default.
 */
async function soleLinkedPurchase(
  db: Database,
  mail: RetainedMailSource | null,
  vendorId: VendorId,
) {
  if (!mail) return null;
  const [message] = await getDb(db)
    .select({ id: emailTable.id })
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, mail.ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, mail.mailboxId),
        eq(emailTable.messageId, mail.messageId),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!message) return null;
  const linked = (
    await readEmailPurchaseAssociations(db, parseEntityId("email", message.id))
  ).filter((row) => !row.purchaseDeleted);
  const [only] = linked;
  if (!only || linked.length !== 1) return null;
  const [target] = await getDb(db)
    .select({ vendorId: purchase.vendorId })
    .from(purchase)
    .where(eq(purchase.id, only.id))
    .limit(1);
  return target?.vendorId === vendorId
    ? { id: only.id, shortcode: only.shortcode }
    : null;
}

/**
 * A mail order with no target must not silently become a second Purchase of
 * an order Cubby already holds. When no Purchase carries its order id, every
 * existing-order candidate the claim showed (a Purchase from the same thread
 * whose order id does not differ, or a statement lump of the printed total)
 * must be the target or named in `distinctFromPurchases`. Candidacy alone
 * never chooses the target.
 */
async function assertExistingOrdersReviewed(
  db: Database,
  input: {
    mail: RetainedMailSource | null;
    vendorId: VendorId;
    orderId: string | null;
    total: number | null;
    distinctFrom: readonly string[];
  },
) {
  const { mail } = input;
  if (!mail) return;
  const orderId = canonicalOrderId(input.orderId);
  if (
    orderId &&
    (await findVendorOrderOwner(db, { vendorId: input.vendorId, orderId }))
      .kind !== "none"
  )
    return;
  // Every candidate, not the claim's display: a hidden match must still block.
  const candidates = await readExistingOrderCandidates(
    db,
    {
      ledgerPartyId: mail.ledgerPartyId,
      vendorId: input.vendorId,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      threadId: mail.threadId,
      receivedAt: mail.receivedAt,
    },
    { lumpAmount: input.total },
  );
  const distinct = new Set(input.distinctFrom);
  const unreviewed = candidates.filter(
    (candidate) =>
      !distinct.has(candidate.id) &&
      (candidate.basis === "thread"
        ? candidate.orderId === null ||
          orderId === null ||
          normalizeOrderKey(candidate.orderId) === normalizeOrderKey(orderId)
        : input.total !== null),
  );
  if (unreviewed.length)
    throw new Error(
      `${unreviewed.map((candidate) => `${candidate.id} (${candidate.basis === "thread" ? "same Email thread" : "statement booking"})`).join(", ")} may already hold this order. Compare identifiers, lines, totals and dates, then set targetPurchaseId to the same order or name each in distinctFromPurchases.`,
    );
}

/** Each order's verified retained Email, checked before any write. */
async function retainedMailSources(
  db: Database,
  scope: ImportScope,
  orders: PreparePurchaseImportInput["orders"],
) {
  const retained = new Map<
    PreparePurchaseImportInput["orders"][number],
    RetainedMailSource | null
  >();
  for (const order of orders)
    retained.set(
      order,
      await retainedMailSource(db, scope, order.source, order.evidenceChecksum),
    );
  return retained;
}

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
  const review = await findProductIdentityReviewCandidates(db, line.title);
  const reviewIds = new Set(review.map(({ id }) => id));
  const exactProductIds = new Set(exact.map(({ id }) => id));
  const exactNameIds = new Set(
    (await findExactProductNameMatches(db, line.title)).map(({ id }) => id),
  );
  const modelTokens = modelStyleTokens(line.title).map((token) =>
    token.toLowerCase(),
  );
  const sharedModel = modelTokens.length
    ? await database
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          brandName: productBrandNameSql(product.brandId),
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
  // Exact names rank right after exact identifiers: commit refuses a new
  // Product beside either without a Distinct-from decision.
  // Name lookup admits a single shared token; past exact names, a fuzzy hit
  // must also share the item's identity, its own brand counting only when the
  // line names it.
  const fuzzyRest = fuzzy.filter(
    (hit) =>
      !exactProductIds.has(hit.id) &&
      !modelRankedIds.has(hit.id) &&
      (exactNameIds.has(hit.id) ||
        productIdentityOverlap(
          {
            name: line.title,
            brandName:
              hit.brandName &&
              line.title.toLowerCase().includes(hit.brandName.toLowerCase())
                ? hit.brandName
                : null,
          },
          hit,
        ).relevant),
  );
  return [
    ...exact,
    ...fuzzyRest.filter(({ id }) => exactNameIds.has(id)),
    ...modelRanked,
    ...review.filter(
      ({ id }) =>
        !exactProductIds.has(id) &&
        !exactNameIds.has(id) &&
        !modelRankedIds.has(id),
    ),
    ...fuzzyRest.filter(
      ({ id }) => !exactNameIds.has(id) && !reviewIds.has(id),
    ),
  ]
    .slice(0, 20)
    .map(({ id, shortcode, ...candidate }) => ({
      productId: shortcode,
      ...candidate,
      exactIdentifierMatch: exactProductIds.has(id),
      exactNameMatch: exactNameIds.has(id),
      matchReason: modelRankedIds.has(id)
        ? MODEL_STYLE_MATCH_REASON
        : reviewIds.has(id)
          ? PRODUCT_IDENTITY_REVIEW_REASON
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
  // knows its order id; accepting the source preserves that known identity.
  if (
    chosen &&
    (chosen.vendorId !== input.vendorId ||
      (chosen.orderId !== null &&
        input.orderId !== null &&
        normalizeOrderKey(chosen.orderId) !== normalizeOrderKey(input.orderId)))
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
      vendorId: input.vendorId,
    },
    { lock: "share", writable: true },
  );
  const claim = retained?.association;
  const ordered = await reviewedVendorOrderOwner(
    db,
    { vendorId: input.vendorId, orderId: input.orderId },
    input.targetPurchaseId,
  );
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
        ? {
            ...target,
            statedTotal:
              target.statedTotal === null
                ? null
                : minorToMoney(target.statedTotal),
            updatedAt: target.updatedAt.toISOString(),
          }
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
  runId: RunId,
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

/** Called under the Run lock, after completed-operation replay and before any business writes. */
async function assertLiveImportScope(
  db: Database,
  actor: ActorContext,
  expected: ImportScope,
) {
  const live = await loadImportScope(db, expected.runId, actor);
  if (live.status !== "running")
    throw new Error(`Purchase import run is fenced in ${live.status}`);
  if (
    live.ledgerPartyId !== expected.ledgerPartyId ||
    live.vendorAccountId !== expected.vendorAccountId ||
    live.vendorId !== expected.vendorId ||
    live.purpose !== expected.purpose
  )
    throw new Error("Purchase import run scope changed during preparation");
}

export async function preparePurchaseImport(
  db: Database,
  rawInput: PreparePurchaseImportInput,
  actor: ActorContext,
  decisionPort?: DecisionPort,
) {
  const parsed = preparePurchaseImportInput.parse(rawInput);
  const scope = await importRunScope(db, actor, parsed._runExecution, true);
  assertRunCapability(scope.purpose, "prepare");
  // Before the operation ledger: a nested attachment key and its stored form
  // are one source, so retries and the writer see a single identity.
  const input = {
    ...parsed,
    orders: await Promise.all(
      parsed.orders.map(async (order) => ({
        ...order,
        source: {
          ...order.source,
          externalKey: await canonicalMailSourceKey(
            db,
            scope.ledgerPartyId,
            order.source,
          ),
        },
      })),
    ),
  };
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
    async (ledger) => {
      const recorded = await ledger.replay(getDb(db), preparePurchaseImportOut);
      if (recorded) return recorded;
      const prior = await priorPreparation(db, scope.runId, input.orders);
      if (prior) return prior;
      // Invalid keys or altered originals never reach paid source judgments.
      // The writer repeats these checks under its transaction after admission.
      if (scope.purpose === "mail_import")
        for (const order of input.orders)
          await readUnchangedMailSource(
            db,
            scope,
            order.source,
            order.evidenceChecksum,
          );
      const admissions =
        scope.purpose === "mail_import"
          ? await prepareMailSourceAdmissions(
              db,
              scope.runId,
              input.orders.flatMap(({ source, via }) => {
                const { mailboxId, messageId } = parseMailSourceKey(
                  source.externalKey,
                );
                return (source.kind === "mail_message" ||
                  source.kind === "mail_attachment") &&
                  mailboxId &&
                  messageId
                  ? [{ mailboxId, messageId, via }]
                  : [];
              }),
              actor,
              decisionPort,
            )
          : [];
      return householdWrite(db, async (transactionDb) => {
        const database = getDb(transactionDb);
        // Lock the Run before the operation: cancellation uses the same order.
        await database
          .select({ id: runTable.id })
          .from(runTable)
          .where(eq(runTable.id, scope.runId))
          .for("no key update");
        const replayed = await ledger.replay(
          database,
          preparePurchaseImportOut,
        );
        if (replayed) return replayed;
        await assertLiveImportScope(transactionDb, actor, scope);
        // After replay: a completed prepare returns its recorded result even
        // once its Email is excluded or resolved.
        await applyMailSourceAdmissions(
          transactionDb,
          scope.runId,
          admissions,
          {
            requireAttribution: true,
          },
        );
        const retainedMail = await retainedMailSources(
          transactionDb,
          scope,
          input.orders,
        );
        await ledger.start(database);

        const outputOrders = [];
        const sourceOrders = new Set<string>();
        for (const order of input.orders) {
          const { vendorId, vendorCandidates } = await preparedOrderVendor(
            transactionDb,
            order,
            scope,
            retainedMail.get(order),
            actor,
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
          // Resolve parser-abstained roles before publishing a prepared order.
          // The source extraction remains immutable/checksum evidence; the
          // prepared line is the authoritative role used by roster and commit.
          const preparedCandidateLines: ExtractedPurchaseLine[] = [];
          for (const [position, line] of candidate.lines.entries()) {
            let lineKind: ExpenseLineKind =
              line.lineKind === "unclassified"
                ? await decideExpenseLineRole(
                    { name: line.title, cost: line.amount, notes: null },
                    {
                      db: transactionDb,
                      runId: scope.runId,
                      operation: `purchase-import.expense-line-role:${order.stableOrderId}:${order.lineIds[position] ?? position}`,
                    },
                    decisionPort,
                  )
                : line.lineKind;
            // An inferred positive discount on a forward receipt lacks reversal
            // evidence. Keep the signed source amount and require role review;
            // explicit source roles can represent documented corrections.
            if (
              line.lineKind === "unclassified" &&
              lineKind === "discount" &&
              line.amount !== null &&
              line.amount > 0 &&
              (candidate.printedGrandTotal === null ||
                candidate.printedGrandTotal >= 0)
            )
              lineKind = "unclassified";
            preparedCandidateLines.push({ ...line, lineKind });
          }
          const linkedTarget =
            order.targetPurchaseId || candidate.orderId !== null
              ? null
              : await soleLinkedPurchase(
                  transactionDb,
                  retainedMail.get(order) ?? null,
                  vendorId,
                );
          const explicitTarget = order.targetPurchaseId
            ? await resolveOrThrow(
                transactionDb,
                "purchase",
                order.targetPurchaseId,
              )
            : (linkedTarget?.id ?? null);
          const orderedTarget = await reviewedVendorOrderOwner(
            transactionDb,
            { vendorId, orderId: candidate.orderId },
            explicitTarget,
          );
          const targetPurchaseId = explicitTarget ?? orderedTarget?.id ?? null;
          if (!targetPurchaseId)
            await assertExistingOrdersReviewed(transactionDb, {
              mail: retainedMail.get(order) ?? null,
              vendorId,
              orderId: candidate.orderId,
              total:
                candidate.currency === "USD"
                  ? candidate.printedGrandTotal
                  : null,
              distinctFrom: order.distinctFromPurchases ?? [],
            });
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
          for (const line of preparedCandidateLines) {
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
          for (const [position, line] of preparedCandidateLines.entries()) {
            const stableLineId = order.lineIds[position];
            if (!stableLineId) throw new Error("Prepared line id is missing");
            // Tax, shipping and other adjustments never resolve a Product.
            const candidates =
              line.lineKind === "principal"
                ? await productCandidates(
                    transactionDb,
                    exactRequests[position] ?? [],
                    exactHits,
                    line,
                  )
                : [];
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
            targetPurchaseId:
              order.targetPurchaseId ??
              linkedTarget?.shortcode ??
              orderedTarget?.shortcode ??
              null,
            stableOrderId: order.stableOrderId,
            itemOperationId: order.itemOperationId,
            source: order.source,
            orderId: candidate.orderId,
            targetFingerprint,
            evidenceFingerprint,
            vendorCandidates,
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
      });
    },
  );
}

/**
 * A preparation an earlier prepare operation of this Run already recorded for
 * these items, such as a retried coordinator's repeat under a new operation id.
 * Identical orders read back that preparation (commit names its operation id);
 * any other overlap with prepared items is a conflict naming it.
 */
async function priorPreparation(
  db: Database,
  runId: RunId,
  orders: PreparePurchaseImportInput["orders"],
) {
  const database = getDb(db);
  const prepared = await database
    .select({
      prepareOperationId: importPreparedOrder.prepareOperationId,
      itemOperationId: importPreparedOrder.itemOperationId,
    })
    .from(importPreparedOrder)
    .where(
      and(
        eq(importPreparedOrder.runId, runId),
        inArray(
          importPreparedOrder.itemOperationId,
          orders.map((order) => order.itemOperationId),
        ),
      ),
    );
  const [first] = prepared;
  if (!first) return undefined;
  const operation = await readOperation(database, {
    runId,
    operationId: first.prepareOperationId,
  });
  if (
    prepared.length === orders.length &&
    prepared.every(
      (row) => row.prepareOperationId === first.prepareOperationId,
    ) &&
    operation?.state === "completed" &&
    operation.inputFingerprint === (await sha256Hex(JSON.stringify(orders)))
  )
    return preparePurchaseImportOut.parse(operation.result);
  throw createAppError(
    "PURCHASE_IMPORT_ITEM_PREPARED",
    `This Run already prepared ${prepared
      .map(
        (row) =>
          `itemOperationId ${row.itemOperationId} under prepare operation ${row.prepareOperationId}`,
      )
      .join(
        ", ",
      )} (${operation?.state ?? "unrecorded"}) with different orders. Commit that preparation by its prepareOperationId, or prepare changed evidence under new itemOperationIds.`,
  );
}

const log = createLogger("purchase-import");

async function finalizeReviewRun(
  db: Database,
  runId: RunId,
  operationId: string,
) {
  const [finished] = await getDb(db)
    .select({ status: runTable.status, auditedAt: runTable.auditedAt })
    .from(runTable)
    .where(eq(runTable.id, runId));
  // The saved commit can replay after its required audit ended the Run.
  if (finished?.status === "needs_review" && finished.auditedAt !== null)
    return;
  await auditAllImportBatches(db, {
    runId,
    operationId: `${operationId}:required-audit`,
  });
  await withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    const [stopped] = await tx
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
          eq(runTable.status, "running"),
        ),
      )
      .returning({ purpose: runTable.purpose, input: runTable.input });
    if (stopped)
      await (
        await import("~/server/kernel/api")
      ).emitWrites(databaseForTransaction(tx), {
        table: runTable,
        entity: "run",
        ids: [runId],
        columns: ["status", "endedAt", "updatedAt"],
      });
    if (stopped?.purpose === "mail_import" && stopped.input !== null)
      await releaseUnsettledMailRunSources(tx, runEntityId.parse(runId));
  });
}

/**
 * A recorded commit result: the public result plus the `requiresReview` that
 * finalizes the Run on replay (absent on the oldest rows, which read false).
 */
const recordedCommit = commitPurchaseImportOut.extend({
  requiresReview: z.boolean().default(false),
});

type CommittedImport = {
  result: z.infer<typeof commitPurchaseImportOut>;
  requiresReview: boolean;
  createdProductIds: ProductId[];
  thumbnailWork: Parameters<typeof attachOrderLineThumbnails>[1][];
};

export async function commitPurchaseImport(
  db: Database,
  rawInput: CommitPurchaseImportInput,
  actor: ActorContext,
  _decisionPort?: DecisionPort,
  hooks?: { onProductsCreated?: (ids: ProductId[]) => Promise<void> },
) {
  const input = commitPurchaseImportInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, false);
  assertRunCapability(scope.purpose, "commit_purchase_import");
  const transactionResult = await executeAtomicOperation<CommittedImport>(
    db,
    {
      runId: scope.runId,
      operationId: input._runExecution.operationId,
      kind: "commit_purchase_import",
      payload: operationArgs(input),
      subject: "Commit",
      recordFailure: true,
    },
    async (ledger) => {
      const replayed = await ledger.replay(getDb(db), recordedCommit);
      if (replayed)
        return {
          result: commitPurchaseImportOut.parse(replayed),
          requiresReview: replayed.requiresReview,
          createdProductIds: [],
          thumbnailWork: [],
        };
      if (scope.status !== "running")
        throw new Error(`Purchase import run is fenced in ${scope.status}`);
      const preparedAttachments = new Map<
        string,
        PreparedMailAttachmentDecisions
      >();
      for (const { order } of await loadPreparation(
        db,
        scope.runId,
        input.prepareOperationId,
      )) {
        const mail = await retainedMailSource(
          db,
          scope,
          {
            kind: importSourceKind.parse(order.sourceKind),
            externalKey: order.sourceExternalKey,
            checksum: order.sourceChecksum,
          },
          order.evidenceChecksum,
        );
        if (mail && !preparedAttachments.has(mail.id))
          preparedAttachments.set(
            mail.id,
            await prepareMailAttachmentDecisions(
              db,
              mail,
              { ...actor, runId: scope.runId },
              _decisionPort,
            ),
          );
      }
      return householdWrite(db, async (database) => {
        // Cancellation locks the Run before the operation row too.
        await getDb(database)
          .select({ id: runTable.id })
          .from(runTable)
          .where(eq(runTable.id, scope.runId))
          .for("no key update");
        const replay = await ledger.replay(getDb(database), recordedCommit, {
          forUpdate: true,
        });
        if (replay)
          return {
            result: commitPurchaseImportOut.parse(replay),
            requiresReview: replay.requiresReview,
            createdProductIds: [],
            thumbnailWork: [],
          };
        await assertLiveImportScope(database, actor, scope);
        const recorded = await readOperation(getDb(database), {
          runId: scope.runId,
          operationId: input.prepareOperationId,
        });
        if (
          recorded?.kind !== "prepare_purchase_import" ||
          recorded.state !== "completed"
        )
          throw new Error("Prepared import was not completed");
        const publicPreparation = preparePurchaseImportOut.parse(
          recorded.result,
        );
        const stored = await loadPreparation(
          database,
          scope.runId,
          input.prepareOperationId,
        );
        const mailSources = new Map<string, RetainedMailSource | null>();
        const retainedProductReviews = new Set<string>();
        const acceptedReplayObservations = new Set<string>();
        const createdProductIds = new Set<ProductId>();
        const evidence: Array<
          Parameters<typeof appendOrderEvidence>[1][number]
        > = [];
        async function loadPreparedEvidence() {
          for (const { order, lines } of stored) {
            const vendorId = order.vendorId ?? scope.vendorId;
            if (!vendorId)
              throw new Error("Prepared purchase import order has no Vendor");
            const [liveVendor] = await getDb(database)
              .select({ id: vendor.id })
              .from(vendor)
              .where(and(eq(vendor.id, vendorId), notDeleted(vendor)))
              .limit(1);
            if (!liveVendor)
              throw new Error(
                "The prepared order's Vendor was deleted or merged; prepare it again.",
              );
            if (
              scope.purpose === "mail_import" &&
              scope.vendorId &&
              vendorId !== scope.vendorId
            )
              throw new Error(
                "This Mail import is limited to its selected Vendor.",
              );
            const source = {
              kind: importSourceKind.parse(order.sourceKind),
              externalKey: order.sourceExternalKey,
              checksum: order.sourceChecksum,
            };
            const mail = await retainedMailSource(
              database,
              scope,
              source,
              order.evidenceChecksum,
            );
            mailSources.set(order.id, mail);
            const extraction = importExtractionOutcome.parse(order.extraction);
            if (!extraction.candidate)
              throw new Error(
                "Prepared purchase import order has no candidate",
              );
            const targetFingerprint = await computeTargetFingerprint(database, {
              ledgerPartyId: scope.ledgerPartyId,
              vendorId,
              sourceKind: source.kind,
              sourceExternalKey: source.externalKey,
              orderId: extraction.candidate.orderId,
              targetPurchaseId: order.targetPurchaseId,
            });
            const evidenceFingerprint = await computeEvidenceFingerprint({
              source,
              evidenceChecksum: order.evidenceChecksum,
              extractionRevision: order.extractionRevision,
              extraction,
              primaryDocumentImageId: order.primaryDocumentImageId,
              screenshotImageId: order.screenshotImageId,
            });
            if (
              targetFingerprint !== order.targetFingerprint ||
              evidenceFingerprint !== order.evidenceFingerprint
            )
              throw new Error(
                "Prepared target or evidence changed before commit",
              );
            const vendorAccountId =
              scope.vendorAccountId ??
              (mail
                ? (
                    await ensureMailVendorAccount(database, {
                      vendorId,
                      ledgerPartyId: scope.ledgerPartyId,
                    })
                  ).id
                : null);
            const orderKey = sourceOrderKey({
              vendorId,
              orderId: extraction.candidate.orderId,
            });
            const retainedOrder = await resolveImportSourceOrder(
              getDb(database),
              {
                ledgerPartyId: scope.ledgerPartyId,
                kind: source.kind,
                externalKey: source.externalKey,
                orderKey,
                vendorId,
              },
              { lock: "update", writable: true },
            );
            const retainedObservationId = retainedOrder
              ? (retainedOrder.association.acceptedObservationId ??
                (await withTransaction(database, async (tx) =>
                  (
                    await import("~/server/domains/purchase-import/repo/reconciliation-observations")
                  ).promoteHistoricalAcceptedObservation(
                    tx,
                    retainedOrder.association.id,
                  ),
                )))
              : null;
            if (retainedOrder && retainedObservationId)
              retainedOrder.association.acceptedObservationId =
                retainedObservationId;
            const [retainedOriginal] = retainedObservationId
              ? await getDb(database)
                  .select()
                  .from(sourceOrderObservation)
                  .where(eq(sourceOrderObservation.id, retainedObservationId))
              : [];
            if (
              retainedOriginal &&
              !(await (
                await import("~/server/domains/purchase-import/repo/reconciliation-observations")
              ).sourceObservationIdentityMatches(
                getDb(database),
                "vendor",
                retainedOriginal.vendorId,
                vendorId,
              ))
            )
              throw new Error(
                "The accepted source and prepared Vendor have different identities",
              );
            if (retainedOrder) retainedProductReviews.add(order.stableOrderId);
            const evidenceVendorId = retainedOriginal?.vendorId ?? vendorId;
            if (
              retainedOrder &&
              retainedOriginal &&
              retainedOriginal.ledgerPartyId === scope.ledgerPartyId
            ) {
              await (
                await import("~/server/domains/purchase-import/repo/reconciliation-observations")
              ).acceptedSourceExtraction(
                getDb(database),
                retainedOrder.association,
              );
              acceptedReplayObservations.add(retainedOriginal.id);
            }
            evidence.push({
              ...(retainedOrder
                ? {
                    retainedSubject: {
                      sourceClaimId: retainedOrder.association.sourceClaimId,
                      purchaseId: retainedOrder.association.purchaseId,
                    },
                  }
                : {}),
              orderKey: retainedOrder?.association.orderKey ?? orderKey,
              emailId: mail?.emailId,
              input: importWriterInput.parse({
                runId: scope.runId,
                ledgerPartyId: scope.ledgerPartyId,
                vendorId: evidenceVendorId,
                vendorAccountId,
                source,
                extraction: {
                  ...extraction,
                  candidate: {
                    ...extraction.candidate,
                    lines: extraction.candidate.lines.map((line, index) => {
                      const prepared = lines.find(
                        (row) => row.position === index,
                      );
                      if (!prepared)
                        throw new Error(`Prepared line ${index} is missing`);
                      return {
                        ...line,
                        lineKind: extractedPurchaseLine.parse(prepared.line)
                          .lineKind,
                      };
                    }),
                  },
                },
                primaryDocumentImageId: order.primaryDocumentImageId,
                screenshotImageId: order.screenshotImageId,
              }),
            });
          }
        }
        await loadPreparedEvidence();
        const resolutionIds = new Set(
          input.resolutions.map((row) =>
            JSON.stringify([row.stableOrderId, row.stableLineId]),
          ),
        );
        if (resolutionIds.size !== input.resolutions.length)
          throw new Error("Product resolutions contain duplicate line ids");
        const preparedLineIds = new Set<string>();
        for (const { order, lines } of stored)
          for (const line of lines) {
            const id = JSON.stringify([order.stableOrderId, line.stableLineId]);
            preparedLineIds.add(id);
            if (
              extractedPurchaseLine.parse(line.line).lineKind === "principal" &&
              !resolutionIds.has(id)
            )
              throw new Error(
                `Missing product resolution for ${order.stableOrderId}/${line.stableLineId}`,
              );
          }
        if ([...resolutionIds].some((id) => !preparedLineIds.has(id)))
          throw new Error("Product resolutions name an unknown prepared line");
        await ledger.start(getDb(database));
        const previousOrders = await getDb(database)
          .select({ orderKey: sourceOrderObservation.orderKey })
          .from(sourceOrderObservation)
          .where(
            and(
              eq(sourceOrderObservation.ledgerPartyId, scope.ledgerPartyId),
              inArray(
                sourceOrderObservation.orderKey,
                evidence.map((row) => row.orderKey),
              ),
            ),
          );
        const preparedProducts = new Map<
          string,
          Map<number, import("@cubby/schemas/identifiers").ProductId>
        >();
        const preparedCatalogProducts = new Map<
          string,
          Map<number, import("@cubby/schemas/identifiers").ProductId>
        >();
        const preparedExpenseBindings = new Map<
          string,
          Map<
            number,
            import("~/server/domains/purchase-import/policy/import-lines").ExistingExpenseSnapshot
          >
        >();
        async function resolvePreparedProducts() {
          for (const [index, storedOrder] of stored.entries()) {
            const prepared = { stableOrderId: storedOrder.order.stableOrderId };
            const capture = evidence[index];
            if (!capture)
              throw new Error("The prepared source capture is missing");
            if (previousOrders.some((row) => row.orderKey === capture.orderKey))
              retainedProductReviews.add(prepared.stableOrderId);
            const choices = input.resolutions.filter(
              (row) => row.stableOrderId === prepared.stableOrderId,
            );
            const { resolvePreparedImportProducts } =
              await import("~/server/domains/purchase-import/repo/writer");
            const productVendorId =
              storedOrder.order.vendorId ?? scope.vendorId;
            if (!productVendorId)
              throw new Error("The prepared Product Vendor is missing");
            const resolved = await resolvePreparedImportProducts(
              database,
              productVendorId,
              choices.map((choice) => {
                const line = storedOrder.lines.find(
                  (line) => line.stableLineId === choice.stableLineId,
                );
                if (!line) throw new Error("Unknown prepared Product line");
                return {
                  lineIndex: line.position,
                  line: extractedPurchaseLine.parse(line.line),
                  resolution: choice.resolution,
                };
              }),
              !retainedProductReviews.has(prepared.stableOrderId),
              actorInRun(actor, scope.runId),
              { purchaseId: storedOrder.order.targetPurchaseId, capture },
            );
            for (const id of resolved.createdProductIds)
              createdProductIds.add(id);
            preparedProducts.set(
              prepared.stableOrderId,
              resolved.sourceProducts,
            );
            preparedCatalogProducts.set(
              prepared.stableOrderId,
              resolved.products,
            );
            preparedExpenseBindings.set(
              prepared.stableOrderId,
              resolved.matchedExpenses,
            );
            if (resolved.sourceProducts.size)
              capture.input.productResolutions = [
                ...resolved.sourceProducts,
              ].map(([lineIndex, productId]) => ({
                kind: "existing",
                lineIndex,
                productId,
              }));
          }
        }
        await resolvePreparedProducts();
        const observations = await appendOrderEvidence(database, evidence);
        const preparation = {
          acceptedOrders: stored.map(({ order, lines }, index) => {
            const observation = observations[index];
            if (
              !observation ||
              observation.checksum !== order.sourceChecksum ||
              observation.orderKey !== evidence[index]?.orderKey ||
              observation.vendorId !== evidence[index]?.input.vendorId
            )
              throw new Error("Accepted extraction is missing");
            return {
              stableOrderId: order.stableOrderId,
              observationId: observation.id,
              lineIds: lines.map((row) => row.stableLineId),
              targetPurchaseId: order.targetPurchaseId,
            };
          }),
        };
        if (
          publicPreparation.orders.length !== preparation.acceptedOrders.length
        )
          throw new Error("Prepared order roster changed before commit");
        const boundBefore = await getDb(database)
          .select({
            id: acceptedOrders.id,
            purchaseId: acceptedOrders.purchaseId,
          })
          .from(acceptedOrders)
          .where(
            inArray(
              acceptedOrders.id,
              observations.map((row) => row.id),
            ),
          );
        const decisions: Array<Parameters<typeof decide>[2][number]> = [];
        const projectId = input.defaultProjectId
          ? await resolveOrThrow(database, "project", input.defaultProjectId)
          : undefined;
        async function retainPreparedDecisions() {
          for (const prepared of preparation.acceptedOrders) {
            const observation = observations.find(
              (row) => row.id === prepared.observationId,
            )!;
            const event = orderEventKey(observation);
            const scopes = [
              { kind: "purchaseEvent", key: event },
              ...orderPaymentKeys(observation).map((key) => ({
                kind: "purchaseEvent",
                key,
              })),
            ];
            const subject = `purchaseEvent:${event}`;
            if (
              prepared.targetPurchaseId &&
              !boundBefore.some(
                (row) =>
                  row.id === observation.id &&
                  row.purchaseId === prepared.targetPurchaseId,
              )
            )
              decisions.push({
                channel: "assignment" as const,
                kind: "set" as const,
                subject: event,
                field: "purchaseId",
                value: prepared.targetPurchaseId,
                scopes,
              });
            for (const [field, value] of Object.entries({
              defaultTrade: input.defaultTrade,
              defaultProjectId: projectId,
            }))
              if (value !== undefined)
                decisions.push({
                  channel: "assignment" as const,
                  kind: "set" as const,
                  subject,
                  field,
                  value,
                  scopes,
                });
            const choices = input.resolutions.filter(
              (row) => row.stableOrderId === prepared.stableOrderId,
            );
            const products = preparedProducts.get(prepared.stableOrderId);
            if (!products)
              throw new Error("The prepared Product resolution is missing");
            for (const choice of choices) {
              const index = prepared.lineIds.indexOf(choice.stableLineId);
              if (index < 0) throw new Error("Unknown prepared line");
              const resolution = choice.resolution;
              const productId = products.get(index);
              const value = productId
                ? { kind: "existing", productId }
                : resolution;
              const recordedExpense = preparedExpenseBindings
                .get(prepared.stableOrderId)
                ?.get(index);
              if (recordedExpense && productId) {
                const savedLine = stored
                  .find(
                    ({ order }) =>
                      order.stableOrderId === prepared.stableOrderId,
                  )
                  ?.lines.find((line) => line.position === index);
                if (!savedLine)
                  throw new Error("The matched prepared line is missing");
                const line = extractedPurchaseLine.parse(savedLine.line);
                for (const [field, assigned] of Object.entries({
                  productId,
                  productQuantity:
                    line.quantity ?? recordedExpense.productQuantity ?? 1,
                }))
                  decisions.push({
                    channel: "assignment" as const,
                    kind: "set" as const,
                    subject: recordSubject("expense", recordedExpense.id),
                    field,
                    value: assigned,
                    scopes,
                  });
                decisions.push({
                  channel: "assignment" as const,
                  kind: "set" as const,
                  subject,
                  field: `line-record:${observation.productBindings.find((row) => row.lineIndex === index)?.stableLineId ?? index}`,
                  value: recordedExpense.id,
                  scopes,
                });
              }
              decisions.push({
                channel: "assignment" as const,
                kind: "set" as const,
                subject,
                field: `line:${observation.productBindings.find((row) => row.lineIndex === index)?.stableLineId ?? index}`,
                value,
                scopes,
              });
            }
          }
        }
        await retainPreparedDecisions();
        const previousChoices = decisions.length
          ? await getDb(database).execute<{
              subject: string;
              field: string;
              kind: string;
              value: unknown;
            }>(sql`SELECT DISTINCT ON (subject,slot) subject,field,kind,value FROM "Decision"
          WHERE channel=${decisionChannel.enum.assignment} AND subject=ANY(${textArrayParam([...new Set(decisions.map((row) => row.subject))])})
          ORDER BY subject,slot,at DESC,id DESC`)
          : { rows: [] };
        const changedSubjects = new Set(
          decisions
            .filter(
              (choice) =>
                !previousChoices.rows.some(
                  (held) =>
                    held.subject === choice.subject &&
                    held.field === choice.field &&
                    held.kind === choice.kind &&
                    canonicalJson(jsonSnapshot.parse(held.value)) ===
                      canonicalJson(jsonSnapshot.parse(choice.value)),
                ),
            )
            .map((row) => row.subject),
        );
        const retainedFacts = new Set(
          (
            await getDb(database)
              .select({ id: sourceOrderObservation.id })
              .from(sourceOrderObservation)
              .where(
                and(
                  inArray(
                    sourceOrderObservation.id,
                    observations.map((row) => row.id),
                  ),
                  sql`${sourceOrderObservation.createdAt} < transaction_timestamp()`,
                ),
              )
          ).map((row) => row.id),
        );
        // A successful command receipt proves acceptance independently of a
        // later held proposal. Ambiguous preparation handles prove nothing.
        const acceptedCaptures = await getDb(database).execute<{
          id: string;
        }>(sql`
          SELECT DISTINCT observation.id FROM "SourceOrderObservation" observation
          JOIN "ImportPreparedOrder" prepared ON prepared."runId"=observation."runId"
            AND prepared."vendorId"=observation."vendorId"
            AND prepared."sourceKind"=observation."sourceKind"
            AND prepared."sourceExternalKey"=observation."sourceExternalKey"
            AND prepared."sourceChecksum"=observation.checksum
            AND prepared.extraction=observation.extraction
            AND prepared."primaryDocumentImageId" IS NOT DISTINCT FROM observation."primaryDocumentImageId"
            AND prepared."screenshotImageId" IS NOT DISTINCT FROM observation."screenshotImageId"
          JOIN "RunOperation" operation ON operation."runId"=prepared."runId"
            AND operation.kind='commit_purchase_import' AND operation.state=${sqlEnumConstant(importOperationStatusOut.shape.state, importOperationStatusOut.shape.state.enum.completed)}
            AND operation."completedAt">=prepared."createdAt"
          CROSS JOIN LATERAL jsonb_array_elements(operation.result->'items') item
          WHERE observation.id=ANY(${textArrayParam(observations.map((row) => row.id))}::uuid[])
            AND item->>'stableOrderId'=prepared."stableOrderId"
            AND item->>'outcome' IN (${sqlEnumConstant(commitPurchaseImportOut.shape.items.element.shape.outcome, commitPurchaseImportOut.shape.items.element.shape.outcome.enum.created)},${sqlEnumConstant(commitPurchaseImportOut.shape.items.element.shape.outcome, commitPurchaseImportOut.shape.items.element.shape.outcome.enum.updated)},${sqlEnumConstant(commitPurchaseImportOut.shape.items.element.shape.outcome, commitPurchaseImportOut.shape.items.element.shape.outcome.enum.replayed)})
            AND NOT EXISTS (SELECT 1 FROM "ImportPreparedOrder" other
              WHERE other."runId"=prepared."runId" AND other."stableOrderId"=prepared."stableOrderId"
                AND other.id<>prepared.id)`);
        for (const row of acceptedCaptures.rows)
          acceptedReplayObservations.add(row.id);
        await decide(database, actor, decisions);
        const outcomes = await settleOrderEvidence(database, observations);
        if (input.defaultTrade === undefined) {
          const createdExpenses = await getDb(database)
            .select({ id: expense.id })
            .from(expense)
            .innerJoin(
              recordKey,
              and(
                eq(recordKey.entityId, expense.id),
                eq(recordKey.entity, "expense"),
                inArray(recordKey.scopeKey, [
                  ...new Set(outcomes.map((row) => row.scope.key)),
                ]),
              ),
            )
            .where(sql`${expense.createdAt} >= transaction_timestamp()`);
          if (createdExpenses.length)
            await updatePurchaseEventWhere(
              database,
              "expense",
              { trade: "other" },
              planFallbackExpenses(createdExpenses.map((row) => row.id)).where,
            );
        }
        const accepted = await getDb(database)
          .select({
            emailId: acceptedOrders.emailId,
            purchaseId: acceptedOrders.purchaseId,
          })
          .from(acceptedOrders)
          .where(
            inArray(
              acceptedOrders.id,
              observations.map((row) => row.id),
            ),
          );
        await linkExactOrderEmails(database, {
          purchaseIds: [
            ...new Set(
              accepted.flatMap((row) =>
                row.purchaseId ? [row.purchaseId] : [],
              ),
            ),
          ],
        });
        const emailIds = observations.flatMap((row) =>
          row.emailId ? [row.emailId] : [],
        );
        if (emailIds.length) {
          const dismissed = await getDb(database)
            .select({
              emailId: emailLinkDecisionsRead.emailId,
              purchaseId: emailLinkDecisionsRead.purchaseId,
            })
            .from(emailLinkDecisionsRead)
            .where(
              and(
                inArray(emailLinkDecisionsRead.emailId, emailIds),
                eq(emailLinkDecisionsRead.decision, "dismissed"),
                eq(emailLinkDecisionsRead.active, true),
              ),
            );
          const deniedTargets = dismissed.length
            ? await getDb(database)
                .select({
                  id: purchase.id,
                  vendorId: purchase.vendorId,
                  orderId: purchase.orderId,
                })
                .from(purchase)
                .where(
                  and(
                    inArray(
                      purchase.id,
                      dismissed.map((row) => row.purchaseId),
                    ),
                    notDeleted(purchase),
                  ),
                )
            : [];
          const deniedKnownOrder = observations.some((row) =>
            dismissed.some((choice) => {
              const target = deniedTargets.find(
                (target) => target.id === choice.purchaseId,
              );
              const orderId = row.extraction.candidate?.orderId;
              return (
                choice.emailId === row.emailId &&
                target?.vendorId === row.vendorId &&
                !!target.orderId &&
                !!orderId &&
                normalizeOrderKey(target.orderId) === normalizeOrderKey(orderId)
              );
            }),
          );
          if (
            deniedKnownOrder ||
            accepted.some((row) =>
              dismissed.some(
                (choice) =>
                  choice.emailId === row.emailId &&
                  choice.purchaseId === row.purchaseId,
              ),
            )
          )
            throw new Error(
              "A member dismissed this Email for that Purchase; review the Email before importing it.",
            );
        }
        const records = await getDb(database)
          .select()
          .from(recordKey)
          .where(
            and(
              eq(recordKey.scopeKind, "purchaseEvent"),
              eq(recordKey.entity, "purchase"),
            ),
          );
        const purchases = await getDb(database)
          .select({
            id: purchase.id,
            shortcode: purchase.shortcode,
            createdThisCommit: sql<boolean>`${purchase.createdAt} >= transaction_timestamp()`,
          })
          .from(purchase)
          .where(notDeleted(purchase));
        const bindings = await getDb(database)
          .select()
          .from(evidenceBinding)
          .where(
            and(
              eq(evidenceBinding.factKind, "orderObservation"),
              inArray(
                evidenceBinding.factId,
                observations.map((row) => row.id),
              ),
            ),
          );
        const sourceReviews = new Set<string>();
        const items = preparation.acceptedOrders.map((prepared) => {
          const observation = observations.find(
            (row) => row.id === prepared.observationId,
          )!;
          const key =
            bindings.find((row) => row.factId === observation.id)?.eventKey ??
            orderEventKey(observation);
          const owned = records.find((row) => row.scopeKey === key);
          const saved = purchases.find((row) => row.id === owned?.entityId);
          const relatedScopes = new Set([
            key,
            orderEventKey(observation),
            ...orderPaymentKeys(observation),
          ]);
          const relatedOutcomes = outcomes.filter((row) =>
            relatedScopes.has(row.scope.key),
          );
          const gaps = [
            ...new Map(
              relatedOutcomes
                .flatMap((row) => row.gaps)
                .map((gap) => [`${gap.kind}:${gap.input}`, gap] as const),
            ).values(),
          ];
          const decisionGaps = gaps.filter(
            (gap) => gap.kind === "decision" || gap.kind === "unsupported",
          );
          const needsDecision =
            gaps.some(
              (gap) => gap.kind === "decision" || gap.kind === "unsupported",
            ) ||
            relatedOutcomes.some(
              (row) => row.status === "failed" || row.status === "conflict",
            );
          const acceptedReplay =
            !!saved &&
            retainedFacts.has(observation.id) &&
            acceptedReplayObservations.has(observation.id) &&
            !changedSubjects.has(
              `purchaseEvent:${orderEventKey(observation)}`,
            ) &&
            !changedSubjects.has(orderEventKey(observation)) &&
            !outcomes.some(
              (row) =>
                row.scope.key === key &&
                (row.status === "failed" || row.status === "conflict"),
            );
          if (
            !acceptedReplay &&
            decisionGaps.some(
              (gap) => gap.kind === "decision" && !gap.actions.length,
            )
          )
            sourceReviews.add(observation.id);
          return {
            stableOrderId: prepared.stableOrderId,
            outcome: acceptedReplay
              ? "replayed"
              : saved && !needsDecision
                ? saved.createdThisCommit
                  ? "created"
                  : retainedFacts.has(observation.id) &&
                      !changedSubjects.has(
                        `purchaseEvent:${orderEventKey(observation)}`,
                      ) &&
                      !changedSubjects.has(orderEventKey(observation))
                    ? "replayed"
                    : "updated"
                : "conflict",
            purchaseId: saved?.shortcode ?? null,
            findingCount: acceptedReplay ? 0 : decisionGaps.length,
          };
        });
        async function publishAcceptedSources() {
          for (const prepared of preparation.acceptedOrders) {
            const item = items.find(
              (item) => item.stableOrderId === prepared.stableOrderId,
            );
            const saved = purchases.find(
              (row) => row.shortcode === item?.purchaseId,
            );
            const observation = observations.find(
              (row) => row.id === prepared.observationId,
            );
            const order = stored.find(
              ({ order }) => order.stableOrderId === prepared.stableOrderId,
            )?.order;
            if (
              item?.outcome === "conflict" &&
              saved &&
              observation &&
              sourceReviews.has(observation.id) &&
              observation.extraction.candidate?.currency === "USD"
            ) {
              await (
                await import("~/server/domains/purchase-import/repo/reconciliation-publication")
              ).publishSourceOrderReconciliation(
                database,
                {
                  observationId: observation.id,
                  purchaseId: saved.id,
                  runId: scope.runId,
                },
                actor,
              );
            }
            if (
              item &&
              item.outcome !== "conflict" &&
              item.outcome !== "replayed" &&
              saved
            ) {
              const products = [
                ...(preparedCatalogProducts
                  .get(prepared.stableOrderId)
                  ?.values() ?? []),
              ];
              if (products.length) {
                const lines = await getDb(database)
                  .select({ productId: expense.productId })
                  .from(expense)
                  .where(
                    and(
                      eq(expense.purchaseId, saved.id),
                      inArray(expense.productId, products),
                      notDeleted(expense),
                    ),
                  );
                const identityOnly = products.filter(
                  (id) => !lines.some((line) => line.productId === id),
                );
                if (identityOnly.length)
                  await (
                    await import("~/server/domains/purchase/repo/purchase-products")
                  ).attachPurchaseProducts(
                    database,
                    saved.id,
                    identityOnly,
                    actorInRun(actor, scope.runId),
                  );
              }
            }
            if (item && item.outcome !== "conflict" && saved && observation)
              await (
                await import("~/server/domains/purchase-import/repo/shipment-intake")
              ).recordImportedShipmentEvidence(
                database,
                {
                  source: {
                    kind: importSourceKind.parse(observation.sourceKind),
                    externalKey: observation.sourceExternalKey,
                    checksum: observation.checksum,
                  },
                  runId: scope.runId,
                  ledgerPartyId: scope.ledgerPartyId,
                  purchaseId: saved.id,
                  shipments: observation.extraction.candidate?.shipments ?? [],
                },
                actorInRun(actor, scope.runId),
              );
            if (
              !item ||
              item.outcome === "conflict" ||
              item.outcome === "replayed" ||
              !saved ||
              !observation ||
              !order
            )
              continue;
            const { publishRunFinding } =
              await import("~/server/domains/run/repo/run-finding");
            for (const choice of input.resolutions) {
              if (
                choice.stableOrderId !== prepared.stableOrderId ||
                choice.resolution.kind !== "unresolved"
              )
                continue;
              const lineIndex = prepared.lineIds.indexOf(choice.stableLineId);
              const line = observation.extraction.candidate?.lines[lineIndex];
              if (!line || line.lineKind !== "principal") continue;
              await publishRunFinding(database, {
                runId: scope.runId,
                ledgerPartyId: scope.ledgerPartyId,
                entityKind: "purchase",
                entityId: saved.id,
                kind: "product_unresolved",
                summary: `Product resolution is required for “${line.title}”: ${choice.resolution.reason}`,
                proposedFix: null,
                evidenceFingerprint: await sha256Hex(
                  JSON.stringify({
                    observationId: observation.id,
                    lineIndex,
                    reason: choice.resolution.reason,
                  }),
                ),
              });
              item.findingCount += 1;
            }
            const vendorId = order.vendorId ?? scope.vendorId;
            if (!vendorId)
              throw new Error("The accepted source Vendor is missing");
            await recordRetainedImportAcceptance(getDb(database), {
              ledgerPartyId: scope.ledgerPartyId,
              kind: importSourceKind.parse(order.sourceKind),
              externalKey: order.sourceExternalKey,
              checksum: observation.checksum,
              orderKey: observation.orderKey,
              vendorId,
              purchaseId: saved.id,
              observationId: observation.id,
              runId: scope.runId,
            });
          }
        }
        await publishAcceptedSources();
        const importedMail = new Map<
          string,
          Parameters<typeof linkImportedMail>[1]
        >();
        const thumbnailWork: Parameters<typeof attachOrderLineThumbnails>[1][] =
          [];
        for (const { order } of stored) {
          const mail = mailSources.get(order.id);
          const item = items.find(
            (item) => item.stableOrderId === order.stableOrderId,
          );
          if (!mail || !item?.purchaseId || item.outcome === "conflict")
            continue;
          const saved = purchases.find(
            (row) => row.shortcode === item.purchaseId,
          );
          if (!saved) throw new Error("Imported Purchase is missing");
          const extraction = importExtractionOutcome.parse(order.extraction);
          const target = {
            event: extraction.candidate?.sourceEvent ?? "confirmation",
            purchaseId: saved.id,
          };
          const current = importedMail.get(mail.id);
          if (current) current.purchases.push(target);
          else {
            const attachmentDecisions = preparedAttachments.get(mail.id);
            if (!attachmentDecisions)
              throw new Error("Email attachment purposes were not reviewed.");
            importedMail.set(mail.id, {
              mail,
              purchases: [target],
              actorUserId: actor.userId,
              runId: scope.runId,
              attachmentDecisions,
            });
          }
          thumbnailWork.push({
            purchaseId: saved.id,
            mailContent: mail.content,
            lines: extraction.candidate?.lines ?? [],
          });
        }
        for (const emailImport of importedMail.values())
          await linkImportedMail(database, emailImport);
        if (
          importedMail.size &&
          items.some(
            (item) => item.outcome === "created" || item.outcome === "updated",
          )
        )
          await (
            await import("~/server/workflows/background-tasks/publish")
          ).publishBackgroundTasks(
            database,
            [
              {
                kind: "maintenance.purchase-discovery",
                requestedAt: new Date().toISOString(),
              },
            ],
            { source: "mail-import-evidence" },
          );
        const requiresReview =
          scope.purpose !== "mail_import" &&
          (input.resolutions.some(
            (row) => row.resolution.kind === "unresolved",
          ) ||
            items.some((item) => item.outcome === "conflict"));
        const result = commitPurchaseImportOut.parse({
          runId: scope.shortcode,
          operationId: input._runExecution.operationId,
          status: requiresReview ? "needs_review" : "running",
          items,
        });
        await ledger.complete(getDb(database), { ...result, requiresReview });
        const memberImport = scope.purpose === "file_import" && !requiresReview;
        await getDb(database)
          .update(runTable)
          .set({
            status: memberImport ? "completed" : "running",
            endedAt: memberImport ? new Date() : null,
            failureCode: null,
            updatedAt: new Date(),
          })
          .where(eq(runTable.id, scope.runId));
        await (
          await import("~/server/kernel/api")
        ).emitWrites(database, {
          table: runTable,
          entity: "run",
          ids: [scope.runId],
          columns: ["status", "endedAt", "updatedAt"],
        });
        await recordChange(database, { kind: "source", categories: ["run"] });
        return {
          result,
          requiresReview,
          thumbnailWork,
          createdProductIds: [...createdProductIds],
        };
      });
    },
  );
  for (const work of transactionResult.thumbnailWork)
    await attachOrderLineThumbnails(db, work);
  if (transactionResult.requiresReview)
    await finalizeReviewRun(db, scope.runId, input._runExecution.operationId);
  if (transactionResult.createdProductIds.length && hooks?.onProductsCreated)
    await hooks
      .onProductsCreated(transactionResult.createdProductIds)
      .catch((error) =>
        log.warn("Post-commit Product follow-up failed", {
          runId: scope.runId,
          error: scrubErrorMessage(String(error)),
        }),
      );
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
