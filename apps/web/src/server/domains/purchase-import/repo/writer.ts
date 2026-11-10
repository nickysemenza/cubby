import { plainDate } from "@cubby/schemas/base-entity";
import { buildActorContext } from "@cubby/schemas/context";
import { type ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { GTIN_KIND, GTIN_SOURCE } from "@cubby/schemas/external-id";
import {
  parseEntityId,
  userId as userIdSchema,
  runEntityId,
  type ProductId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import {
  importWriterInput,
  importWriterOutput,
  type ExtractedPaymentEvidence,
  type ExtractedPurchaseLine,
  type ImportWriterInput,
  type ImportWriterOutput,
  type ProposedImportFix,
  type AcceptedSourceOrder,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { householdLocalDate } from "~/lib/household-date";
import { wasm } from "~/lib/wasm";
import { type DecisionChoiceResult } from "~/server/ai/decision-model";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  entityAttachment,
  expense,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerParty,
  ledgerSourceClaim,
  product,
  purchase,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import { validateExpenseInheritance } from "~/server/domains/expense/repo/expense-inheritance";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ExternalIdPair,
} from "~/server/domains/product/repo/find-by-external-ids";
import { upsertAgentProductMatch } from "~/server/domains/product/repo/match/product-match-candidate";
import { resolveProductIdentifierSource } from "~/server/domains/product/repo/product-identifier-source";
import {
  findExactProductNameMatches,
  findProductIdentityReviewCandidates,
} from "~/server/domains/product/repo/resolve-names";
import { linkExactOrderEmails } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { manufacturerPartRequests } from "~/server/domains/purchase-import/repo/manufacturer-identity";
import {
  type LiveSourceOrder,
  lockImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { sourceOrderKey } from "~/server/domains/purchase-import/repo/source-order-key";
import { type ExistingExpenseSnapshot } from "~/server/domains/purchase-import/repo/writer-policy";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { assertRunCapabilityById } from "~/server/domains/run/repo/purpose-policy";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import { classificationAllowsField } from "~/server/domains/spending-category/repo/classification-field-policy";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { canonicalOrderId } from "./order-identity";
import {
  acceptedSourceExtraction,
  recordSourceOrderObservation,
  promoteHistoricalAcceptedObservation,
  mergedVendorSourceOrder,
} from "./reconciliation-observations";
import {
  loadSourceReconciliationState,
  sourceReconciliationStateFingerprint,
} from "./reconciliation-state";
import {
  lockPartySettlement,
  settlePurchaseFromRetainedPayments,
} from "./retained-settlement";
import { recordRunWrites } from "./run-audit";
import { recordImportedShipmentEvidence } from "./shipment-intake";
import {
  applyPaymentEvidence,
  applyPurchaseHeader,
  applyFallbackExpenses,
  applyReplayClaim,
  applyPurchaseNote,
  applyRunCounter,
  applyTenderUpdates,
} from "./writer-apply";
import { writePurchaseLines } from "./writer-lines";
import {
  loadAcceptedProductChoices,
  loadAcceptedPaymentFacts,
  loadAcceptedPurchase,
  loadAssignedPurchaseLine,
  loadChosenPurchase,
  loadRetainedTender,
  loadClassifiedPurchaseLines,
  loadOrderedPurchases,
  loadUnlinkedProducts,
  lockAndLoadSourceFamily,
  lockAndLoadSourceOrder,
  lockPurchaseTarget,
  lockPurchaseExpenses,
  loadOwnedImportScope,
  loadOriginalLineBindings,
  loadTargetReviewFacts,
} from "./writer-load";
import {
  changedAcceptedProductChoice,
  planLineMatch,
  planLearnedTender,
  planTenderUpdates,
  planRunWrites,
  planFinancialProjection,
  planFallbackExpenses,
  planReplayClaim,
  planPurchaseNote,
  planRunCounter,
  planLineMode,
  planAcceptedPaymentReview,
  planPurchaseHeader,
  planPaymentEvidence,
  planOrderedPurchase,
  planPurchaseTarget,
  planLockedPurchase,
  planSourceIdentity,
  planSourceKey,
  planSourceOrder,
  planTargetReview,
} from "./writer-plan";

const PURCHASE_EXTERNAL_ID_KIND = "retailer_sku" as const;

/**
 * Preserve a printed calendar day; an instant uses the household-local day.
 * Evidence without a date preserves an existing date or leaves it unknown.
 */
export const purchaseDateFor = (
  orderedAt: string | null,
  existingDate: string | null,
): string | null => {
  if (orderedAt)
    return plainDate.safeParse(orderedAt).success
      ? orderedAt
      : householdLocalDate(new Date(orderedAt));
  if (existingDate) return existingDate;
  return null;
};

/**
 * Deterministic semantic projection shared by the writer and validation.
 * It deliberately excludes evidence bytes and mutable source-claim state.
 */
export function buildPurchaseImportPlan(
  extraction: ImportWriterInput["extraction"],
) {
  const candidate = extraction.candidate;
  const writeBlockReason = !candidate
    ? "unreadable"
    : candidate.currency === null
      ? "missing_currency"
      : candidate.orderedAt === null &&
          candidate.lines.some((line) => line.amount !== 0)
        ? "missing_date"
        : candidate.printedGrandTotal === null
          ? "missing_total"
          : candidate.currency !== "USD"
            ? "foreign_currency"
            : extraction.status === "needs_review" &&
                ["sum_mismatch", "foreign_currency", "missing_total"].includes(
                  extraction.reason,
                )
              ? extraction.reason
              : null;
  return {
    orderId: candidate?.orderId ?? null,
    currency: candidate?.currency ?? null,
    statedTotal: candidate?.printedGrandTotal ?? null,
    writeBlockReason,
    lines: (candidate?.lines ?? []).map((line) => ({
      title: line.title,
      amount: line.amount,
      lineKind: line.lineKind,
      quantity: line.quantity ?? null,
    })),
  };
}

async function assertImportOwnership(
  db: Database,
  input: ImportWriterInput,
  actorUserId: string,
) {
  const database = getDb(db);
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const [owned] = await database
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .innerJoin(
      runTable,
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.ledgerPartyId, ledgerParty.id),
        eq(runTable.actorUserId, userIdSchema.parse(actorUserId)),
      ),
    )
    .leftJoin(
      vendorAccount,
      input.vendorAccountId
        ? and(
            eq(
              vendorAccount.id,
              parseEntityId("vendorAccount", input.vendorAccountId),
            ),
            eq(vendorAccount.ledgerPartyId, ledgerParty.id),
            eq(vendorAccount.vendorId, parseEntityId("vendor", input.vendorId)),
            notDeleted(vendorAccount),
          )
        : sql`false`,
    )
    .where(
      and(
        eq(ledgerParty.id, partyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
        input.vendorAccountId ? isNotNull(vendorAccount.id) : undefined,
      ),
    )
    .limit(1);
  if (!owned)
    throw new Error("Import source is not owned by the authenticated member");
}

async function recordLearnedTender(
  tx: DrizzleTransaction,
  source: { purchaseId: PurchaseId; sourceClaimId: string },
  proposed: readonly ExtractedPaymentEvidence[],
) {
  const learned = planLearnedTender(proposed);
  if (!learned) return;
  const retained = await loadRetainedTender(
    tx,
    source.purchaseId,
    source.sourceClaimId,
  );
  const plan = planTenderUpdates(learned, retained);
  await applyTenderUpdates(tx, plan);
}

export async function existingExpenses(
  tx: DrizzleTransaction,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
): Promise<ExistingExpenseSnapshot[]> {
  const rows = await tx
    .select({
      id: expense.id,
      title: expense.name,
      amount: expense.cost,
      lineKind: expense.lineKind,
      lineBasis: expense.lineBasis,
      productQuantity: expense.productQuantity,
      productId: expense.productId,
      tradeId: expense.trade,
      projectId: expense.projectId,
      costType: expense.costType,
      sourceClaimId: ledgerSourceClaim.id,
    })
    .from(expense)
    .leftJoin(
      ledgerSourceClaim,
      and(
        eq(ledgerSourceClaim.expenseId, expense.id),
        notDeleted(ledgerSourceClaim),
      ),
    )
    .where(
      and(
        eq(expense.purchaseId, purchaseId),
        eq(expense.economicRole, "vendor"),
        notDeleted(expense),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    amount: row.amount,
    lineKind: row.lineKind,
    lineBasis: row.lineBasis,
    productQuantity: row.productQuantity,
    productId: row.productId,
    tradeId: row.tradeId,
    projectId: row.projectId,
    costType: row.costType,
    sourceClaimed: row.sourceClaimId !== null,
  }));
}

async function attachEvidence(
  tx: DrizzleTransaction,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  input: ImportWriterInput,
) {
  const attachments = [
    input.primaryDocumentImageId
      ? {
          imageId: input.primaryDocumentImageId,
          documentKind: "order_confirmation" as const,
        }
      : null,
    input.screenshotImageId
      ? { imageId: input.screenshotImageId, documentKind: "other" as const }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  for (const attachment of attachments) {
    await tx
      .insert(entityAttachment)
      .values({
        entityId: purchaseId,
        entityKind: "purchase",
        role: "attachment",
        imageId: attachment.imageId,
        documentKind: attachment.documentKind,
      })
      .onConflictDoNothing();
  }
}

const lineIdentifiers = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
) => {
  const asin = amazonAsin(line.productUrl);
  return [
    ...(line.sku
      ? [{ kind: PURCHASE_EXTERNAL_ID_KIND, externalId: line.sku }]
      : []),
    ...(asin ? [{ kind: "asin" as const, externalId: asin }] : []),
  ];
};

/** Every exact identifier a line can share with a Product; prepare flags and commit refuses the same set. */
export const lineIdentifierRequests = (
  source: string,
  line: Pick<ExtractedPurchaseLine, "title" | "productUrl" | "sku">,
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

/** The same vendor SKU in one order must resolve to one Product decision. */
export const lineExternalIdentity = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
  source: string,
): string | null => {
  const [first] = lineIdentifiers(line);
  return first ? `${source}:${first.kind}:${first.externalId}` : null;
};

export type LineIdentityDecision = {
  productId: string | null;
  promote: boolean;
  /**
   * The resolution affirmatively said this line is not a stocked item
   * (`expense_only`); distinct from a line left without a Product for lack of
   * identity.
   */
  expenseOnly?: boolean;
  variantDoubt: boolean;
  unresolvedReason: string | null;
  probability: number;
  lineKind: ExpenseLineKind;
  kitKind: "kit_with_components" | "single" | "n_pack";
  reversalKind: "return" | "concession" | "cancellation" | "replacement" | null;
  /** Exact name matches a sourced Distinct-from decision cleared for creation. */
  distinctFrom?: ExplicitDistinctFrom[];
};

type ExplicitProductResolution = NonNullable<
  ImportWriterInput["productResolutions"]
>[number];
type ExplicitDistinctFrom = NonNullable<
  Extract<ExplicitProductResolution, { kind: "new" }>["distinctFrom"]
>[number];

/**
 * Resolve the explicit `purchase_import.commit` path's caller-supplied
 * resolutions into the same shape `decideLineIdentities` produces. Adjustment
 * lines (tax/shipping/discount/etc.) never carry a Product, so the resolution
 * roster the MCP layer builds is keyed to principal lines only — a missing
 * resolution is only an error when the line is principal.
 */
export async function explicitLineDecisions(
  lines: readonly ExtractedPurchaseLine[],
  resolutions: readonly ExplicitProductResolution[],
  resolveReversal: (
    index: number,
    line: ExtractedPurchaseLine,
  ) => Promise<DecisionChoiceResult>,
): Promise<LineIdentityDecision[]> {
  const decisions: LineIdentityDecision[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      !classificationAllowsField(
        "expense",
        { lineKind: line.lineKind, lineBasis: "item_line" },
        "productId",
      )
    ) {
      decisions.push({
        productId: null,
        promote: false,
        variantDoubt: false,
        probability: 1,
        unresolvedReason: null,
        lineKind: line.lineKind,
        kitKind: "single",
        reversalKind: null,
      });
      continue;
    }
    const resolution = resolutions.find((item) => item.lineIndex === index);
    if (!resolution)
      throw new Error(`Missing product resolution for line ${index}`);
    const reversal =
      line.amount < 0 ? await resolveReversal(index, line) : null;
    const reversalKind = reversal
      ? ((["return", "concession", "cancellation", "replacement"] as const)[
          reversal.selectedIndex ?? 1
        ] ?? "concession")
      : null;
    decisions.push({
      productId: resolution.kind === "existing" ? resolution.productId : null,
      promote: resolution.kind === "new",
      expenseOnly: resolution.kind === "expense_only",
      variantDoubt: false,
      unresolvedReason:
        resolution.kind === "unresolved" ? resolution.reason : null,
      probability: 1,
      lineKind: line.lineKind,
      kitKind: "single",
      reversalKind,
      distinctFrom:
        resolution.kind === "new" ? resolution.distinctFrom : undefined,
    });
  }
  return decisions;
}

export { receiptProductQuantity } from "./writer-plan";

/**
 * A created Product must not fork an Exact identity match (terminology). An
 * identifier another Product owns always refuses; exact names and strong live
 * brand/item candidates require a sourced Distinct-from decision. A distinct Product still
 * cannot take the identical name, which the (name, brandName) index holds.
 */
async function assertNoUnreviewedIdentity(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  source: string,
  distinctFrom: readonly ExplicitDistinctFrom[],
) {
  const requests = lineIdentifierRequests(source, line);
  const owners = await findProductsByExternalIds(tx, requests);
  for (const request of requests) {
    const [owner] = owners.get(externalIdKey(request)) ?? [];
    if (owner)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Line "${line.title}" carries ${request.kind} ${request.externalId}, which ${owner.shortcode} already owns; resolve the line to ${owner.shortcode} or merge instead of creating another Product.`,
      );
  }
  const cleared = new Set(distinctFrom.map(({ productId }) => productId));
  const exact = await findExactProductNameMatches(tx, line.title);
  const review = await findProductIdentityReviewCandidates(tx, line.title);
  for (const match of new Map(
    [...exact, ...review].map((row) => [row.id, row]),
  ).values()) {
    if (!cleared.has(match.id))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Line "${line.title}" matches or resembles ${match.shortcode} ("${match.name}"); resolve the line to ${match.shortcode}, or mark it distinctFrom ${match.shortcode} with a Source showing the difference.`,
      );
    if (match.name === line.title && match.brandName === null)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `A distinct Product cannot take the identical name of ${match.shortcode} ("${match.name}"); give ${match.shortcode} its brandName or a distinguishing name first.`,
      );
  }
}

/** Preview the same creation guard commit enforces against current identities. */
export async function assertNewLineProductIdentity(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: string,
  distinctFrom: readonly ExplicitDistinctFrom[],
) {
  const source = lineIdentifiers(line).length
    ? await resolveProductIdentifierSource(tx, {
        url: line.productUrl,
        vendorId: parseEntityId("vendor", vendorId),
      })
    : "";
  await assertNoUnreviewedIdentity(tx, line, source, distinctFrom);
}

export async function resolveLineProduct(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  decision: LineIdentityDecision,
  vendorId: string,
  productsByExternalIdentity: Map<string, string>,
  options: {
    onCreated?: (productId: ProductId) => void;
    onIdentifierCollision?: (
      proposal: Parameters<typeof upsertAgentProductMatch>[1],
    ) => void;
  },
) {
  const { onCreated, onIdentifierCollision } = options;
  // A line decided to carry no Product (expense-only, or coarse-only) keeps
  // none, even when an earlier line with the same SKU resolved one.
  if (!decision.productId && !decision.promote && !decision.unresolvedReason)
    return null;
  const source = lineIdentifiers(line).length
    ? await resolveProductIdentifierSource(tx, {
        url: line.productUrl,
        vendorId: parseEntityId("vendor", vendorId),
      })
    : "";
  const externalIdentity = lineExternalIdentity(line, source);
  const resolvedEarlier = externalIdentity
    ? productsByExternalIdentity.get(externalIdentity)
    : null;
  if (resolvedEarlier) return parseEntityId("product", resolvedEarlier);
  if (decision.productId) {
    const productId = parseEntityId("product", decision.productId);
    const liveProduct = await tx.query.product.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(eq(product.id, productId), notDeleted(product)),
          ),
      },
    });
    if (!liveProduct) throw new Error("The reviewed Product no longer exists.");
    await learnLineIdentifiers(
      tx,
      productId,
      line,
      source,
      onIdentifierCollision,
    );
    if (externalIdentity)
      productsByExternalIdentity.set(externalIdentity, productId);
    return productId;
  }
  if (decision.lineKind !== "principal" || !decision.promote) return null;
  // A second `new` line with the same title reuses the Product this commit
  // just created; the guard would otherwise refuse it against that Product.
  const titleKey = `title:${line.title.trim().toLowerCase()}`;
  const createdEarlier = productsByExternalIdentity.get(titleKey);
  if (createdEarlier) return parseEntityId("product", createdEarlier);
  await assertNoUnreviewedIdentity(
    tx,
    line,
    source,
    decision.distinctFrom ?? [],
  );
  const created = await insertWithShortcode(tx, "product", {
    name: line.title,
    brandId: null,
    notes:
      decision.distinctFrom
        ?.map(({ url, quote }) => [quote, url].filter(Boolean).join("\n"))
        .join("\n\n") || null,
  });
  onCreated?.(created.id);
  await learnLineIdentifiers(
    tx,
    created.id,
    line,
    source,
    onIdentifierCollision,
  );
  if (externalIdentity)
    productsByExternalIdentity.set(externalIdentity, created.id);
  productsByExternalIdentity.set(titleKey, created.id);
  return created.id;
}

/**
 * Learn a line's identifiers for the Product it resolved to. An identifier
 * another Product already owns is never reassigned and never aborts the order:
 * the reviewed or created Product keeps the line, and the pair is proposed for
 * human identity review with the colliding identifier as evidence.
 */
async function learnLineIdentifiers(
  tx: DrizzleTransaction,
  productId: ProductId,
  line: ExtractedPurchaseLine,
  source: string,
  onCollision?: (
    proposal: Parameters<typeof upsertAgentProductMatch>[1],
  ) => void,
) {
  const proposals: Parameters<typeof upsertAgentProductMatch>[1][] = [];
  for (const identifier of lineIdentifiers(line)) {
    try {
      await learnPurchaseProductExternalId(tx, {
        productId,
        source,
        kind: identifier.kind,
        externalId: identifier.externalId,
        url: line.productUrl,
      });
    } catch (error) {
      if (!(error instanceof PurchaseProductExternalIdCollisionError))
        throw error;
      proposals.push({
        productIds: [productId, error.ownerProductId],
        evidence: `Order line "${line.title}" carries ${error.source}/${error.kind} ${error.externalId}, which already identifies the other Product. Confirm whether both are the same exact variant before merging.`,
        sourceUrls: line.productUrl ? [line.productUrl] : [],
      });
    }
  }
  for (const proposal of proposals) {
    if (onCollision) onCollision(proposal);
    else await upsertAgentProductMatch(tx, proposal);
  }
}

/** A reconciliation of a promoted historical observation has no Run. */
type FindingOrigin = Pick<ImportWriterInput, "ledgerPartyId" | "source"> & {
  runId: ImportWriterInput["runId"] | null;
};

async function fileFinding(
  tx: DrizzleTransaction,
  input: FindingOrigin,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  kind:
    | "duplicate_lines"
    | "sum_mismatch"
    | "foreign_currency"
    | "reversal_kind"
    | "kit_double_booked"
    | "variant_doubt"
    | "product_unresolved"
    | "other",
  summary: string,
  proposedFix: ProposedImportFix | null,
): Promise<string> {
  const evidenceFingerprint = await sha256Hex(
    JSON.stringify({
      source: input.source,
      kind,
      purchaseId,
      proposedFix,
    }),
  );
  return (
    await publishRunFinding(tx, {
      runId: input.runId,
      ledgerPartyId: input.ledgerPartyId,
      entityKind: "purchase",
      entityId: purchaseId,
      kind,
      summary,
      proposedFix,
      evidenceFingerprint,
    })
  ).id;
}

async function fileSourceReconciliation(
  tx: DrizzleTransaction,
  input: ImportWriterInput,
  purchaseId: typeof purchase.$inferSelect.id,
  sourceClaimId: typeof importSourceClaim.$inferSelect.id,
  orderKey: string,
  accepted: LiveSourceOrder | null,
) {
  const observation = await recordSourceOrderObservation(
    tx,
    { sourceClaimId, orderKey, purchaseId },
    input,
  );
  const fix: Extract<ProposedImportFix, { kind: "reconcile_source_order" }> = {
    kind: "reconcile_source_order",
    purchaseId,
    source: input.source,
    orderKey,
    acceptedChecksum: accepted?.checksum ?? null,
    proposedExtraction: input.extraction,
    observationId: observation.id,
    reviewedFingerprint: "0".repeat(64),
  };
  const state = await loadSourceReconciliationState(
    tx,
    fix,
    parseEntityId("ledgerParty", input.ledgerPartyId),
  );
  fix.reviewedFingerprint = await sourceReconciliationStateFingerprint(
    state,
    fix,
    undefined,
  );
  return fileFinding(
    tx,
    input,
    purchaseId,
    "other",
    "Source order evidence differs from the accepted ledger. Review the proposed money, payments and Product bindings before accepting it.",
    fix,
  );
}

type ImportSourceAssociationInput = Pick<
  ImportWriterInput,
  | "ledgerPartyId"
  | "runId"
  | "vendorId"
  | "vendorAccountId"
  | "source"
  | "orderLocator"
> & {
  orderId: NonNullable<ImportWriterInput["extraction"]["candidate"]>["orderId"];
  originalOrder?: AcceptedSourceOrder;
  primaryDocumentImageId?: ImportWriterInput["primaryDocumentImageId"];
  screenshotImageId?: ImportWriterInput["screenshotImageId"];
  productBindings?: ReadonlyArray<
    Pick<
      typeof importSourceProduct.$inferInsert,
      "lineIndex" | "productId" | "expenseId"
    >
  >;
};

async function recordOriginalProductBindings(
  tx: Pick<DrizzleTransaction, "insert">,
  sourceOrderId: typeof importSourceProduct.$inferInsert.sourceOrderId,
  existingOriginal: AcceptedSourceOrder | null | undefined,
  input: Pick<
    ImportSourceAssociationInput,
    "originalOrder" | "productBindings"
  >,
) {
  // Bind the first accepted original, never a changed source's line positions.
  // Existing bindings may already point at a merge survivor and stay immutable.
  if (
    existingOriginal ||
    !input.originalOrder ||
    !input.productBindings?.length
  )
    return;
  for (const binding of input.productBindings) {
    if (!input.originalOrder.extraction.candidate?.lines[binding.lineIndex])
      throw new Error(
        "Import Product binding does not name an original order line.",
      );
  }
  await tx.insert(importSourceProduct).values(
    input.productBindings.map((binding) => ({
      sourceOrderId,
      lineIndex: binding.lineIndex,
      productId: binding.productId,
      expenseId: binding.expenseId,
    })),
  );
}

/** Source ownership and accepted order identity are shared by imports and lifecycle links. */
// Accepted observation and original Product identity must be retained atomically.
async function recordImportSourceAssociation(
  tx: Pick<DrizzleTransaction, "insert" | "select" | "update">,
  input: ImportSourceAssociationInput,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  outputFingerprint: string,
  recordCanonicalProductBindings = true,
) {
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const [owned] = await tx
    .select({ id: runTable.id })
    .from(runTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, runTable.ledgerPartyId),
        eq(ledgerParty.userId, runTable.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.ledgerPartyId, partyId),
      ),
    )
    .limit(1);
  if (!owned)
    throw new Error(
      "Import source is not owned by this Run's authenticated member.",
    );
  const [target] = await tx
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.id, purchaseId),
        eq(purchase.vendorId, parseEntityId("vendor", input.vendorId)),
        notDeleted(purchase),
      ),
    )
    .limit(1);
  if (!target)
    throw new Error(
      "Import source order does not match the supported Purchase vendor.",
    );
  if (input.vendorAccountId) {
    const [ownedAccount] = await tx
      .select({ id: vendorAccount.id })
      .from(vendorAccount)
      .where(
        and(
          eq(
            vendorAccount.id,
            parseEntityId("vendorAccount", input.vendorAccountId),
          ),
          eq(vendorAccount.ledgerPartyId, partyId),
          eq(vendorAccount.vendorId, parseEntityId("vendor", input.vendorId)),
          notDeleted(vendorAccount),
        ),
      )
      .limit(1);
    if (!ownedAccount)
      throw new Error("Import source account is not owned by this member.");
  }
  const family = await lockImportSourceClaimFamily(tx, {
    ledgerPartyId: partyId,
    vendorAccountId: input.vendorAccountId
      ? parseEntityId("vendorAccount", input.vendorAccountId)
      : null,
    kind: input.source.kind,
    externalKey: input.source.externalKey,
    checksum: input.source.checksum,
    firstRunId: input.runId,
    lastRunId: input.runId,
  });
  let orderKey = sourceOrderKey({
    vendorId: input.vendorId,
    orderId: input.orderId,
    orderLocator: input.orderLocator,
  });
  const retained = await readSourceFamilyOrder(tx, family, orderKey, "update");
  const existing =
    retained?.association ??
    (await mergedVendorSourceOrder(
      tx,
      family.members.map((row) => row.id),
      orderKey,
      parseEntityId("vendor", input.vendorId),
    ));
  if (existing) orderKey = existing.orderKey;
  const ownerId = existing?.sourceClaimId ?? family.root.id;
  if (existing && existing.purchaseId !== purchaseId)
    throw new Error(
      "This source order already belongs to a different Purchase.",
    );
  const [association] = await tx
    .insert(importSourceOrder)
    .values({
      sourceClaimId: ownerId,
      orderKey,
      purchaseId,
      checksum: input.source.checksum,
      outputFingerprint,
      originalOrder: input.originalOrder ?? null,
    })
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      // Only a live association arbitrates, so a deleted Purchase's detached
      // row stays as history beside this one. Until the live-only key is
      // applied, the full key still conflicts with that row and this import
      // takes it over as a fresh acceptance instead.
      targetWhere: isNotNull(importSourceOrder.purchaseId),
      set: {
        purchaseId,
        checksum: input.source.checksum,
        outputFingerprint,
        originalOrder: existing
          ? existing.originalOrder
          : (input.originalOrder ?? null),
        ...(existing ? {} : { acceptedObservationId: null }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: importSourceOrder.id });
  if (!association) throw new Error("Import source order was not persisted");
  // Equivalent sources retain complete observation bindings below, while the
  // first source keeps the Purchase's canonical original Product associations.
  if (!existing && recordCanonicalProductBindings)
    await recordOriginalProductBindings(tx, association.id, null, input);
  if (input.originalOrder) {
    const observation = await recordSourceOrderObservation(
      tx,
      { sourceClaimId: ownerId, orderKey, purchaseId },
      {
        runId: input.runId,
        vendorId: input.vendorId,
        source: input.source,
        extraction: input.originalOrder.extraction,
        primaryDocumentImageId: input.primaryDocumentImageId ?? null,
        screenshotImageId: input.screenshotImageId ?? null,
      },
      input.originalOrder.extraction.candidate?.lines.map((_, lineIndex) => ({
        lineIndex,
        productId:
          input.productBindings?.find((row) => row.lineIndex === lineIndex)
            ?.productId ?? null,
      })) ?? [],
    );
    await tx
      .update(importSourceOrder)
      .set({ acceptedObservationId: observation.id })
      .where(eq(importSourceOrder.id, association.id));
  }
  await tx
    .update(importSourceClaim)
    .set({
      checksum: input.source.checksum,
      lastRunId: input.runId,
      updatedAt: new Date(),
    })
    .where(eq(importSourceClaim.id, family.root.id));
  return ownerId;
}

/**
 * Atomic vendor-order writer. The source claim is checked before any conflict
 * rules, so replay preserves accepted spending even when the destination has
 * accumulated later evidence. Package observations use their own idempotent intake.
 */
export async function importVendorOrder(
  db: Database,
  rawInput: ImportWriterInput,
  actorUserId: string,
  options: {
    applyUnassignedPurposeFallback?: boolean;
    /** Each Product this order created, reported before its transaction commits. */
    onProductCreated?: (productId: ProductId) => void;
    /** The reversal Decision for negative principal lines; the caller owns the model call. */
    resolveReversal?: (
      index: number,
      line: ExtractedPurchaseLine,
    ) => Promise<DecisionChoiceResult>;
  } = {},
): Promise<ImportWriterOutput> {
  const input = importWriterInput.parse(rawInput);
  await assertRunCapabilityById(db, input.runId, "business_writer");
  await assertImportOwnership(db, input, actorUserId);
  const candidateDateMissing = input.extraction.candidate?.orderedAt === null;
  const confirmation =
    (input.extraction.candidate?.sourceEvent ?? "confirmation") ===
    "confirmation";
  const mailKey =
    input.source.kind === "mail_message"
      ? /^gmail:(.+?):([^:]+)$/u.exec(input.source.externalKey)
      : null;
  const [dateMail] =
    candidateDateMissing && confirmation && mailKey
      ? await readRetainedMail(db, {
          ledgerPartyIds: [parseEntityId("ledgerParty", input.ledgerPartyId)],
          mailboxId: mailKey[1],
          messageId: mailKey[2],
        })
      : [];
  const fallbackAt =
    dateMail?.rawChecksum === input.source.checksum
      ? (dateMail.receivedAt?.toISOString() ?? null)
      : null;
  if (fallbackAt && input.extraction.candidate)
    input.extraction.candidate.orderedAt = fallbackAt;
  const semanticPlan = buildPurchaseImportPlan(input.extraction);

  const skipsLineWrites = semanticPlan.writeBlockReason !== null;
  const foreignReversal =
    input.extraction.candidate?.currency !== "USD" &&
    (input.extraction.candidate?.sourceEvent === "refunded" ||
      input.extraction.candidate?.sourceEvent === "cancelled" ||
      input.extraction.candidate?.lines.some(
        (line) => line.lineKind === "principal" && line.amount < 0,
      ));
  const unpricedForeign =
    semanticPlan.writeBlockReason === "foreign_currency" &&
    /^[A-Z]{3}$/.test(input.extraction.candidate?.currency ?? "") &&
    !foreignReversal &&
    (input.extraction.status === "ready" ||
      (input.extraction.status === "needs_review" &&
        input.extraction.reason === "foreign_currency"));
  const writesLines = !skipsLineWrites || unpricedForeign;
  const valuation = unpricedForeign ? "unknown" : "USD";
  const identityOnly =
    !unpricedForeign &&
    !foreignReversal &&
    [
      "missing_currency",
      "foreign_currency",
      "missing_date",
      "missing_total",
    ].includes(semanticPlan.writeBlockReason ?? "");
  const explicitResolutions = input.productResolutions ?? [];
  const identityDecisions =
    skipsLineWrites && !identityOnly && !unpricedForeign
      ? []
      : await explicitLineDecisions(
          input.extraction.candidate?.lines ?? [],
          explicitResolutions,
          (index, line) => {
            if (!options.resolveReversal)
              throw new Error(
                `Line ${index} is a reversal and no reversal Decision was supplied`,
              );
            return options.resolveReversal(index, line);
          },
        );
  // The callback is the transaction's explicit policy matrix; splitting it
  // would hide the all-or-nothing write boundary.
  // eslint-disable-next-line complexity
  return withTransaction(db, async (tx) => {
    const identityProposals: Parameters<typeof upsertAgentProductMatch>[1][] =
      [];
    const onIdentifierCollision = (
      proposal: Parameters<typeof upsertAgentProductMatch>[1],
    ) => {
      identityProposals.push(proposal);
    };
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    // First, before any row lock: a settlement pass holds this lock while it
    // waits on Purchase rows, so taking it after writing the Purchase would
    // deadlock against that pass.
    await lockPartySettlement(tx, partyId);
    const ownedScope = await loadOwnedImportScope(
      tx,
      input,
      actorUserId,
      partyId,
    );
    if (!ownedScope) {
      throw new Error("Import source is not owned by the authenticated member");
    }
    const sourceIdentity = planSourceIdentity(input, partyId);
    // The family command preserves accepted bytes before reconciliation.
    const family = await lockAndLoadSourceFamily(tx, sourceIdentity);
    const { candidate, orderKey: proposedOrderKey } = planSourceKey(input);
    const existingOrder = await lockAndLoadSourceOrder(
      tx,
      family,
      proposedOrderKey,
      input.vendorId,
    );
    const orderKey = planSourceOrder(input, proposedOrderKey, existingOrder);
    const acceptedSnapshot = existingOrder
      ? await acceptedSourceExtraction(tx, existingOrder)
      : null;
    const financialProjectionUnchanged = planFinancialProjection(
      candidate,
      acceptedSnapshot?.extraction,
    );
    if (existingOrder) {
      const choices = await loadAcceptedProductChoices(tx, existingOrder);
      const changedProductChoice = changedAcceptedProductChoice(
        candidate,
        explicitResolutions,
        acceptedSnapshot?.extraction,
        choices,
      );
      if (changedProductChoice) {
        const findingId = await fileSourceReconciliation(
          tx,
          input,
          existingOrder.purchaseId,
          existingOrder.sourceClaimId,
          orderKey,
          existingOrder,
        );
        return importWriterOutput.parse({
          outcome: "conflict",
          purchaseId: existingOrder.purchaseId,
          findingIds: [findingId],
          outputFingerprint: existingOrder.outputFingerprint,
        });
      }
    }
    if (
      existingOrder &&
      existingOrder.checksum === input.source.checksum &&
      financialProjectionUnchanged
    ) {
      await promoteHistoricalAcceptedObservation(tx, existingOrder.id);
      await recordLearnedTender(
        tx,
        {
          purchaseId: existingOrder.purchaseId,
          sourceClaimId: existingOrder.sourceClaimId,
        },
        input.extraction.candidate?.payments ?? [],
      );
      const replayClaim = planReplayClaim(input, family.root.id, new Date());
      await applyReplayClaim(tx, replayClaim);
      await recordImportedShipmentEvidence(
        databaseForTransaction(tx),
        {
          source: input.source,
          runId: runEntityId.parse(input.runId),
          ledgerPartyId: partyId,
          purchaseId: existingOrder.purchaseId,
          shipments: candidate.shipments ?? [],
        },
        buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
          runId: runEntityId.parse(input.runId),
        }),
      );
      return importWriterOutput.parse({
        outcome: "replayed",
        purchaseId: existingOrder.purchaseId,
        findingIds: [],
        outputFingerprint: existingOrder.outputFingerprint,
      });
    }
    if (existingOrder) {
      const target = await loadAcceptedPurchase(
        tx,
        existingOrder,
        input.vendorId,
      );
      if (!target)
        throw new Error(
          "The accepted source Purchase no longer exists for this vendor.",
        );
      const paymentFacts = await loadAcceptedPaymentFacts(tx, existingOrder);
      if (planAcceptedPaymentReview(candidate, paymentFacts)) {
        const findingId = await fileSourceReconciliation(
          tx,
          input,
          existingOrder.purchaseId,
          existingOrder.sourceClaimId,
          orderKey,
          existingOrder,
        );
        return importWriterOutput.parse({
          outcome: "conflict",
          purchaseId: existingOrder.purchaseId,
          findingIds: [findingId],
          outputFingerprint: existingOrder.outputFingerprint,
        });
      }
      const purchaseId = parseEntityId("purchase", existingOrder.purchaseId);
      await recordLearnedTender(
        tx,
        {
          purchaseId: existingOrder.purchaseId,
          sourceClaimId: existingOrder.sourceClaimId,
        },
        candidate.payments,
      );
      await attachEvidence(tx, purchaseId, input);
      await recordImportSourceAssociation(
        tx,
        {
          ...input,
          orderId: candidate.orderId,
          originalOrder: {
            checksum: input.source.checksum,
            extraction: input.extraction,
          },
        },
        purchaseId,
        existingOrder.outputFingerprint,
      );
      await recordImportedShipmentEvidence(
        databaseForTransaction(tx),
        {
          source: input.source,
          runId: runEntityId.parse(input.runId),
          ledgerPartyId: partyId,
          purchaseId,
          shipments: candidate.shipments ?? [],
        },
        buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
          runId: runEntityId.parse(input.runId),
        }),
      );
      return importWriterOutput.parse({
        outcome: "updated",
        purchaseId,
        findingIds: [],
        outputFingerprint: existingOrder.outputFingerprint,
      });
    }
    const vendorId = parseEntityId("vendor", input.vendorId);
    const orderId = canonicalOrderId(candidate.orderId);
    const orderedFacts = await loadOrderedPurchases(tx, vendorId, orderId);
    const ordered = planOrderedPurchase(orderedFacts, input.targetPurchaseId);
    const chosen = await loadChosenPurchase(tx, input.targetPurchaseId);
    let target = planPurchaseTarget(input, orderId, chosen, ordered);
    const created = target == null;
    let recordCanonicalProductBindings = true;
    if (target && writesLines) {
      const lockedTarget = await lockPurchaseTarget(tx, target);
      target = planLockedPurchase(target, lockedTarget);
      // Expense locks fence matching and attachment against concurrent edits.
      await lockPurchaseExpenses(tx, target);
    }
    const ledger =
      target && writesLines ? await existingExpenses(tx, target.id) : [];
    // A booked aggregate carries USD spending; these lines add only unpriced items.
    const current = unpricedForeign
      ? ledger.filter((row) => row.lineBasis !== "allocation")
      : ledger;
    const originalBindings =
      target && unpricedForeign && current.length
        ? await loadOriginalLineBindings(tx, target.id)
        : { sources: [], bindings: [] };
    const { matchingExpenses, decision } = planLineMatch(
      candidate,
      current,
      unpricedForeign,
      valuation,
      originalBindings,
    );
    if (target && writesLines) {
      const facts = await loadTargetReviewFacts(
        tx,
        target.id,
        decision.kind === "no_op",
      );
      const review = planTargetReview(
        candidate,
        explicitResolutions,
        current,
        unpricedForeign,
        { decision, matchingExpenses },
        facts,
      );
      recordCanonicalProductBindings = review.recordCanonicalProductBindings;
      if (review.conflict) {
        const findingId = await fileSourceReconciliation(
          tx,
          input,
          target.id,
          family.root.id,
          orderKey,
          null,
        );
        return importWriterOutput.parse({
          outcome: "conflict",
          purchaseId: target.id,
          findingIds: [findingId],
          outputFingerprint: await sha256Hex(
            JSON.stringify({ purchaseId: target.id, source: input.source }),
          ),
        });
      }
    }
    const usedFallbackDate = fallbackAt !== null && !target?.date;
    const orderDate = purchaseDateFor(
      target?.date ?? candidate.orderedAt,
      null,
    );
    const canFillTrade =
      !!target &&
      target.defaultTrade === null &&
      target.defaultProjectId === null &&
      input.defaultTrade !== undefined;
    const assignedLine = target
      ? await loadAssignedPurchaseLine(tx, target.id, canFillTrade)
      : undefined;
    const header = planPurchaseHeader(
      input,
      candidate,
      target,
      orderId,
      orderDate,
      !!assignedLine,
    );
    target = await applyPurchaseHeader(tx, header);
    const purchaseId = parseEntityId("purchase", target.id);
    const note = planPurchaseNote(
      purchaseId,
      fallbackAt,
      dateMail?.messageId,
      usedFallbackDate,
    );
    if (note) {
      await applyPurchaseNote(tx, note);
      await recordChange(tx, { kind: "source", categories: ["purchase"] });
    }

    const knownProducts = explicitResolutions.flatMap((resolution) =>
      resolution.kind === "existing"
        ? [parseEntityId("product", resolution.productId)]
        : [],
    );
    const unlinked = await loadUnlinkedProducts(tx, knownProducts);
    if (unlinked.length) {
      const findingId = await fileSourceReconciliation(
        tx,
        input,
        purchaseId,
        family.root.id,
        orderKey,
        null,
      );
      return importWriterOutput.parse({
        outcome: "conflict",
        purchaseId,
        findingIds: [findingId],
        outputFingerprint: await sha256Hex(
          JSON.stringify({ purchaseId, source: input.source }),
        ),
      });
    }
    await attachEvidence(tx, purchaseId, input);

    const lineMode = planLineMode(
      input,
      candidate,
      identityOnly,
      unpricedForeign,
      decision,
    );
    const { findingIds, productLines, rowMutations } = await writePurchaseLines(
      tx,
      {
        purchaseId,
        candidate,
        identityDecisions,
        mode: lineMode,
        lineMatch: { matchingExpenses, decision },
        orderDate,
        unpricedForeign,
        loadExpenses: () => existingExpenses(tx, purchaseId),
        resolveProduct: (line, identity, previous, onCreated) =>
          resolveLineProduct(tx, line, identity, input.vendorId, previous, {
            onCreated,
            onIdentifierCollision,
          }),
        fileFinding: ({ kind, summary }) =>
          fileFinding(tx, input, purchaseId, kind, summary, null),
      },
    );

    if (options.applyUnassignedPurposeFallback) {
      const createdExpenses = rowMutations.filter(
        (mutation) =>
          mutation.targetKind === "expense" &&
          mutation.mutationKind === "create",
      );
      if (createdExpenses.length) {
        // Resolve inheritance after Products exist. A Purchase-wide default
        // would override an already chosen household Project on food lines.
        const fallback = planFallbackExpenses(
          createdExpenses.map((mutation) => mutation.targetId),
        );
        const filled = await applyFallbackExpenses(tx, fallback);
        for (const mutation of createdExpenses)
          if (filled.some((line) => line.id === mutation.targetId))
            mutation.fields.push("trade");
      }
    }
    const classifiedLines = await loadClassifiedPurchaseLines(tx, purchaseId);
    for (const line of classifiedLines)
      await validateExpenseInheritance(tx, line);
    // A line's Product must be allowed by its effective spending category.
    await validateProductPolicy(tx, { purchaseId });

    const claimFingerprint = await sha256Hex(
      JSON.stringify({
        purchaseId,
        lines: candidate.lines,
        findings: findingIds,
        primaryDocumentImageId: input.primaryDocumentImageId,
      }),
    );
    const sourceClaimId = await recordImportSourceAssociation(
      tx,
      {
        ...input,
        orderId: candidate.orderId,
        originalOrder: {
          checksum: input.source.checksum,
          extraction: input.extraction,
        },
        productBindings: productLines,
      },
      purchaseId,
      claimFingerprint,
      recordCanonicalProductBindings,
    );
    await recordImportedShipmentEvidence(
      databaseForTransaction(tx),
      {
        source: input.source,
        runId: runEntityId.parse(input.runId),
        ledgerPartyId: partyId,
        purchaseId,
        shipments: candidate.shipments ?? [],
      },
      buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
        runId: runEntityId.parse(input.runId),
      }),
    );
    // Publish after retained bindings and identifiers settle, so their invalidation triggers
    // cannot retire this import's fresh collision evidence before commit.
    for (const proposal of identityProposals)
      await upsertAgentProductMatch(tx, proposal);
    if (identityOnly && productLines.length)
      await attachPurchaseProducts(
        databaseForTransaction(tx),
        purchaseId,
        productLines.map((line) => parseEntityId("product", line.productId)),
        buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
          runId: runEntityId.parse(input.runId),
        }),
      );
    // Canonical amounts are USD. Unknown or foreign units remain in the
    // immutable original and cannot replace accepted payments or settle charges.
    if (candidate.currency === "USD") {
      const payments = planPaymentEvidence(
        candidate,
        purchaseId,
        sourceClaimId,
      );
      await applyPaymentEvidence(tx, payments);
      // Settle from the payment lines this order retained, against charges
      // already on the member's statements. Later charges settle through the
      // same function before any hunt opens (retained-settlement.ts).
      await settlePurchaseFromRetainedPayments(tx, {
        purchaseId,
        ledgerPartyId: partyId,
        actor: buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
          runId: runEntityId.parse(input.runId),
        }),
      });
    }
    const runWrites = planRunWrites(
      purchaseId,
      created,
      !!(usedFallbackDate && fallbackAt && dateMail),
      rowMutations,
    );
    await recordRunWrites(
      tx,
      buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
        runId: runEntityId.parse(input.runId),
      }),
      runWrites,
    );
    const runCounter = planRunCounter(input.runId, created);
    await applyRunCounter(tx, runCounter);

    // An order Email retained before this Purchase existed links by its exact order id.
    await linkExactOrderEmails(databaseForTransaction(tx), {
      purchaseIds: [purchaseId],
    });

    for (const mutation of rowMutations)
      if (
        mutation.targetKind === "product" &&
        mutation.mutationKind === "create"
      )
        options.onProductCreated?.(parseEntityId("product", mutation.targetId));
    return importWriterOutput.parse({
      outcome: created ? "created" : "updated",
      purchaseId,
      findingIds,
      outputFingerprint: claimFingerprint,
    });
  });
}
