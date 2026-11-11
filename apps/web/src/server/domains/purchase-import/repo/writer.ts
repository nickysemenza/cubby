import { plainDate } from "@cubby/schemas/base-entity";
import { buildActorContext, systemActor } from "@cubby/schemas/context";
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
import { and, eq, isNotNull, or, sql } from "drizzle-orm";

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
import {
  columnArrayParam,
  textArrayParam,
  uuidArrayParam,
} from "~/server/db/helpers/query";
import {
  entityAttachment,
  entityExternalId,
  expense,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerParty,
  ledgerSourceClaim,
  product,
  purchase,
  purchasePaymentEvidence,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import { validateExpenseInheritances } from "~/server/domains/expense/repo/expense-inheritance";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ExternalIdPair,
  type ProductHit,
} from "~/server/domains/product/repo/find-by-external-ids";
import { upsertAgentProductMatch } from "~/server/domains/product/repo/match/product-match-candidate";
import {
  lookupProductIdentifierSources,
  resolveProductIdentifierSource,
} from "~/server/domains/product/repo/product-identifier-source";
import {
  findExactProductNameMatchesByName,
  findProductIdentityReviewCandidatesByName,
  type findExactProductNameMatches,
  type findProductIdentityReviewCandidates,
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
import { linkShipmentsByOrderId } from "~/server/domains/shipment/repo/evidence";
import { classificationAllowsField } from "~/server/domains/spending-category/repo/classification-field-policy";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  ensureExternalSources,
  lockExternalIdentifierParents,
} from "~/server/generic/entity-links/repo/entity-external-ids";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { isAwaitingOrderDetails } from "./notice-purchase";
import { canonicalOrderId, reviewedVendorOrderOwner } from "./order-identity";
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
import { writePurchaseLines } from "./writer-lines";
import {
  loadAcceptedProductChoices,
  loadAssociationRun,
  loadAssociationTarget,
  loadAssociationAccount,
  loadAcceptedPaymentFacts,
  loadAcceptedPurchase,
  loadAssignedPurchaseLine,
  loadChosenPurchase,
  loadRetainedTender,
  loadClassifiedPurchaseLines,
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
  planSourceAssociation,
  planOriginalBindings,
  planAttachments,
  planLearnedTender,
  planTenderUpdates,
  planRunWrites,
  planFinancialProjection,
  planFallbackExpenses,
  planPurchaseNote,
  planLineMode,
  planAcceptedPaymentReview,
  planPurchaseHeader,
  planPaymentEvidence,
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
          (candidate.lines.some((line) => line.amount !== 0) ||
            (extraction.status === "needs_review" &&
              extraction.reason === "unpriced_itemization"))
        ? "missing_date"
        : candidate.printedGrandTotal === null
          ? "missing_total"
          : candidate.currency !== "USD"
            ? "foreign_currency"
            : extraction.status === "needs_review" &&
                [
                  "sum_mismatch",
                  "unpriced_itemization",
                  "foreign_currency",
                  "missing_total",
                ].includes(extraction.reason)
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
  for (const row of planTenderUpdates(learned, retained))
    await tx
      .update(purchasePaymentEvidence)
      .set({ tender: row.tender, updatedAt: new Date() })
      .where(eq(purchasePaymentEvidence.id, row.id));
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
      line.amount !== null && line.amount < 0
        ? await resolveReversal(index, line)
        : null;
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

type ProductMatchProposal = Parameters<typeof upsertAgentProductMatch>[1];
type IdentityGuardFacts = {
  owners: Map<string, ProductHit[]>;
  exact: Awaited<ReturnType<typeof findExactProductNameMatches>>;
  review: Awaited<ReturnType<typeof findProductIdentityReviewCandidates>>;
};
type PendingOwner = { request: ExternalIdPair; shortcode: string };

/** Guard reads for several created lines: one statement per read kind. */
async function loadIdentityGuardFacts(
  tx: DrizzleTransaction,
  entries: readonly { line: ExtractedPurchaseLine; source: string }[],
): Promise<Map<ExtractedPurchaseLine, IdentityGuardFacts>> {
  if (!entries.length) return new Map();
  const owners = await findProductsByExternalIds(
    tx,
    entries.flatMap(({ line, source }) => lineIdentifierRequests(source, line)),
  );
  const titles = entries.map(({ line }) => line.title);
  const exact = await findExactProductNameMatchesByName(tx, titles);
  const review = await findProductIdentityReviewCandidatesByName(tx, titles);
  return new Map(
    entries.map(({ line }) => [
      line,
      {
        owners,
        exact: exact.get(line.title) ?? [],
        review: review.get(line.title) ?? [],
      },
    ]),
  );
}

/**
 * A created Product must not fork an Exact identity match (terminology). An
 * identifier another Product owns always refuses; exact names and strong live
 * brand/item candidates require a sourced Distinct-from decision. A distinct Product still
 * cannot take the identical name, which the (name, brandName) index holds.
 * `pending` holds identifiers this commit learned but has not written yet.
 */
function assertNoUnreviewedIdentity(
  line: ExtractedPurchaseLine,
  source: string,
  facts: IdentityGuardFacts,
  distinctFrom: readonly ExplicitDistinctFrom[],
  pending: readonly PendingOwner[] = [],
) {
  for (const request of lineIdentifierRequests(source, line)) {
    const owner =
      facts.owners.get(externalIdKey(request))?.[0] ??
      pending.find(
        (held) =>
          held.request.source === request.source &&
          held.request.externalId === request.externalId &&
          (request.kind === undefined || request.kind === held.request.kind),
      );
    if (owner)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Line "${line.title}" carries ${request.kind} ${request.externalId}, which ${owner.shortcode} already owns; resolve the line to ${owner.shortcode} or merge instead of creating another Product.`,
      );
  }
  const cleared = new Set(distinctFrom.map(({ productId }) => productId));
  for (const match of new Map(
    [...facts.exact, ...facts.review].map((row) => [row.id, row]),
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

const lineIdentifierSource = (
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: string,
) =>
  resolveProductIdentifierSource(tx, {
    url: line.productUrl,
    vendorId: parseEntityId("vendor", vendorId),
  });

/** Preview the same creation guard commit enforces against current identities. */
export async function assertNewLineProductIdentity(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: string,
  distinctFrom: readonly ExplicitDistinctFrom[],
) {
  const source = lineIdentifiers(line).length
    ? await lineIdentifierSource(tx, line, vendorId)
    : "";
  const facts = await loadIdentityGuardFacts(tx, [{ line, source }]);
  assertNoUnreviewedIdentity(line, source, facts.get(line)!, distinctFrom);
}

type LearnedIdentifier = {
  source: string;
  kind: ReturnType<typeof lineIdentifiers>[number]["kind"];
  externalId: string;
};
type IdentifierSlot = Pick<LearnedIdentifier, "source" | "externalId"> & {
  kind: string;
};
const learnedKey = ({ source, kind, externalId }: IdentifierSlot) =>
  `${source}\0${kind}\0${externalId}`;
const primarySlotKey = (productId: string, identifier: IdentifierSlot) =>
  `${productId}\0${identifier.source}\0${identifier.kind}`;

/**
 * Live owners of `identifiers`, of any entity kind, and the primary slots
 * `primaryOf` holds for their (source, kind), in one statement.
 */
async function readLearnedIdentifiers(
  tx: DrizzleTransaction,
  identifiers: readonly LearnedIdentifier[],
  primaryOf?: ProductId,
) {
  const owners = new Map<string, string>();
  const primaries = new Set<string>();
  if (!identifiers.length) return { owners, primaries };
  const rows = await tx
    .select({
      entityId: entityExternalId.entityId,
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
      isPrimary: entityExternalId.isPrimary,
    })
    .from(entityExternalId)
    .where(
      and(
        notDeleted(entityExternalId),
        sql`${entityExternalId.source} = ANY(${textArrayParam(identifiers.map(({ source }) => source))})`,
        sql`${entityExternalId.kind} = ANY(${columnArrayParam(identifiers.map(({ kind }) => kind))})`,
        or(
          sql`${entityExternalId.externalId} = ANY(${textArrayParam(identifiers.map(({ externalId }) => externalId))})`,
          primaryOf
            ? and(
                eq(entityExternalId.entityId, primaryOf),
                eq(entityExternalId.isPrimary, true),
              )
            : undefined,
        ),
      ),
    );
  const wanted = new Set(identifiers.map(learnedKey));
  for (const row of rows) {
    const key = learnedKey(row);
    if (wanted.has(key) && !owners.has(key)) owners.set(key, row.entityId);
    if (primaryOf && row.entityId === primaryOf && row.isPrimary)
      primaries.add(primarySlotKey(primaryOf, row));
  }
  return { owners, primaries };
}

const collisionProposal = (
  line: ExtractedPurchaseLine,
  productId: ProductId,
  identifier: LearnedIdentifier,
  ownerProductId: ProductId,
): ProductMatchProposal => ({
  productIds: [productId, ownerProductId],
  evidence: `Order line "${line.title}" carries ${identifier.source}/${identifier.kind} ${identifier.externalId}, which already identifies the other Product. Confirm whether both are the same exact variant before merging.`,
  sourceUrls: line.productUrl ? [line.productUrl] : [],
});

export type LineProducts = ReturnType<typeof lineProductResolver>;

/**
 * Resolves each line's Product in line order, as a per-line resolve would,
 * from reads batched across the lines in `requests`. A line whose SKU an
 * earlier line resolved reuses that Product; a second `new` line with the same
 * title reuses the Product this commit just created. An identifier another
 * Product already owns is never reassigned and never aborts the order: the
 * line keeps its Product, and the pair is proposed for human identity review
 * at that line. Learned identifiers are written by `flush`, which the caller
 * runs after its last `resolve`.
 *
 * Lock order matches a per-line resolve: the issuer registers at the first
 * line that needs it, and a reviewed Product is locked at its first line that
 * learns an identifier. Products this commit creates take no lock.
 */
export function lineProductResolver(
  tx: DrizzleTransaction,
  vendorId: string,
  requests: readonly {
    line: ExtractedPurchaseLine;
    decision: LineIdentityDecision;
  }[],
  options: { onIdentifierCollision?: (proposal: ProductMatchProposal) => void },
) {
  const resolving = requests.filter(
    ({ decision }) =>
      decision.productId || decision.promote || decision.unresolvedReason,
  );
  const creating = resolving.flatMap(({ line, decision }) =>
    !decision.productId && decision.lineKind === "principal" && decision.promote
      ? [line]
      : [],
  );
  const sources = new Map<ExtractedPurchaseLine, string>();
  const guards = new Map<ExtractedPurchaseLine, IdentityGuardFacts>();
  const storedOwners = new Map<string, string>();
  const ownersRead = new Set<string>();
  let liveReviewed = new Map<string, string>();
  let started = false;
  let registered = false;
  const byIdentity = new Map<string, string>();
  const shortcodes = new Map<string, string>();
  const locked = new Set<string>();
  const pendingOwners = new Map<string, ProductId>();
  const pendingPrimaries = new Set<string>();
  const pending: (LearnedIdentifier & {
    productId: ProductId;
    line: ExtractedPurchaseLine;
    isPrimary: boolean;
  })[] = [];

  const emit = async (proposals: readonly ProductMatchProposal[]) => {
    for (const proposal of proposals) {
      if (options.onIdentifierCollision)
        options.onIdentifierCollision(proposal);
      else await upsertAgentProductMatch(tx, proposal);
    }
  };
  const learnedIdentifiers = (line: ExtractedPurchaseLine, source: string) => {
    const normalized = source.trim().toLowerCase();
    return lineIdentifiers(line).map(({ kind, externalId }) => ({
      source: normalized,
      kind,
      externalId,
    }));
  };
  const readStoredOwners = async (identifiers: LearnedIdentifier[]) => {
    const unread = identifiers.filter((id) => !ownersRead.has(learnedKey(id)));
    if (!unread.length) return;
    const { owners } = await readLearnedIdentifiers(tx, unread);
    for (const identifier of unread) ownersRead.add(learnedKey(identifier));
    for (const [key, owner] of owners) storedOwners.set(key, owner);
  };

  // Reads that need no issuer, after the caller's locks.
  const start = async () => {
    started = true;
    // A malformed id fails at its own line, as a per-line resolve would.
    const reviewed = [
      ...new Set(resolving.flatMap(({ decision }) => decision.productId ?? [])),
    ].flatMap((id) => {
      try {
        return [parseEntityId("product", id)];
      } catch {
        return [];
      }
    });
    if (reviewed.length)
      liveReviewed = new Map(
        (
          await tx
            .select({ id: product.id, shortcode: product.shortcode })
            .from(product)
            .where(
              and(
                notDeleted(product),
                sql`${product.id} = ANY(${uuidArrayParam(reviewed)})`,
              ),
            )
        ).map((row) => [row.id, row.shortcode]),
      );
    const plain = creating.filter((line) => !lineIdentifiers(line).length);
    for (const [line, facts] of await loadIdentityGuardFacts(
      tx,
      plain.map((line) => ({ line, source: "" })),
    ))
      guards.set(line, facts);
  };

  // The issuer registers at the first line that needs it; the rest read the
  // registry it leaves. A line that registry cannot answer registers itself
  // and fails there with its own error.
  const sourceFor = async (line: ExtractedPurchaseLine) => {
    if (!lineIdentifiers(line).length) return "";
    const known = sources.get(line);
    if (known !== undefined) return known;
    const source = await lineIdentifierSource(tx, line, vendorId);
    sources.set(line, source);
    if (registered) return source;
    registered = true;
    const rest = resolving.filter(
      (request) =>
        !sources.has(request.line) && lineIdentifiers(request.line).length,
    );
    const looked = await lookupProductIdentifierSources(
      tx,
      rest.map((request) => ({
        url: request.line.productUrl,
        vendorId: parseEntityId("vendor", vendorId),
      })),
    );
    rest.forEach((request, index) => {
      const lookup = looked[index];
      if (lookup?.source) sources.set(request.line, lookup.source);
    });
    const identified = creating.flatMap((created) => {
      const known = sources.get(created);
      return known === undefined || guards.has(created)
        ? []
        : [{ line: created, source: known }];
    });
    for (const [created, facts] of await loadIdentityGuardFacts(tx, identified))
      guards.set(created, facts);
    await readStoredOwners(
      identified.flatMap(({ line: created, source: known }) =>
        learnedIdentifiers(created, known),
      ),
    );
    return source;
  };

  const learn = async (
    productId: ProductId,
    line: ExtractedPurchaseLine,
    source: string,
    reviewed: boolean,
  ) => {
    const identifiers = learnedIdentifiers(line, source);
    if (!identifiers.length) return;
    let owners: ReadonlyMap<string, string> = storedOwners;
    let primaries: ReadonlySet<string> = new Set();
    if (reviewed) {
      if (!locked.has(productId)) {
        await lockExternalIdentifierParents(tx, [
          { entityId: productId, entityKind: "product" },
        ]);
        locked.add(productId);
      }
      ({ owners, primaries } = await readLearnedIdentifiers(
        tx,
        identifiers,
        productId,
      ));
    } else await readStoredOwners(identifiers);
    const proposals: ProductMatchProposal[] = [];
    for (const identifier of identifiers) {
      const key = learnedKey(identifier);
      const owner = pendingOwners.get(key) ?? owners.get(key);
      if (owner) {
        if (owner !== productId)
          proposals.push(
            collisionProposal(
              line,
              productId,
              identifier,
              parseEntityId("product", owner),
            ),
          );
        continue;
      }
      const slot = primarySlotKey(productId, identifier);
      const isPrimary = !primaries.has(slot) && !pendingPrimaries.has(slot);
      pendingOwners.set(key, productId);
      if (isPrimary) pendingPrimaries.add(slot);
      pending.push({ ...identifier, productId, line, isPrimary });
    }
    await emit(proposals);
  };

  const pendingGuardOwners = (): PendingOwner[] =>
    pending.map(({ source, kind, externalId, productId }) => ({
      request: { source, kind, externalId },
      shortcode: shortcodes.get(productId) ?? productId,
    }));

  return {
    async resolve(
      line: ExtractedPurchaseLine,
      decision: LineIdentityDecision,
      onCreated?: (productId: ProductId) => void,
    ): Promise<ProductId | null> {
      // A line decided to carry no Product (expense-only, or coarse-only)
      // keeps none, even when an earlier line with the same SKU resolved one.
      if (
        !decision.productId &&
        !decision.promote &&
        !decision.unresolvedReason
      )
        return null;
      if (!started) await start();
      const source = await sourceFor(line);
      const externalIdentity = lineExternalIdentity(line, source);
      const resolvedEarlier = externalIdentity
        ? byIdentity.get(externalIdentity)
        : null;
      if (resolvedEarlier) return parseEntityId("product", resolvedEarlier);
      if (decision.productId) {
        const reviewedId = parseEntityId("product", decision.productId);
        const shortcode =
          liveReviewed.get(reviewedId) ??
          (
            await tx
              .select({ shortcode: product.shortcode })
              .from(product)
              .where(and(eq(product.id, reviewedId), notDeleted(product)))
          )[0]?.shortcode;
        if (!shortcode)
          throw new Error("The reviewed Product no longer exists.");
        shortcodes.set(reviewedId, shortcode);
        await learn(reviewedId, line, source, true);
        if (externalIdentity) byIdentity.set(externalIdentity, reviewedId);
        return reviewedId;
      }
      if (decision.lineKind !== "principal" || !decision.promote) return null;
      const titleKey = `title:${line.title.trim().toLowerCase()}`;
      const createdEarlier = byIdentity.get(titleKey);
      if (createdEarlier) return parseEntityId("product", createdEarlier);
      let facts = guards.get(line);
      if (!facts) {
        facts = (await loadIdentityGuardFacts(tx, [{ line, source }])).get(
          line,
        )!;
        guards.set(line, facts);
      }
      assertNoUnreviewedIdentity(
        line,
        source,
        facts,
        decision.distinctFrom ?? [],
        pendingGuardOwners(),
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
      shortcodes.set(created.id, created.shortcode);
      await learn(created.id, line, source, false);
      if (externalIdentity) byIdentity.set(externalIdentity, created.id);
      byIdentity.set(titleKey, created.id);
      return created.id;
    },

    /** Writes the identifiers `resolve` learned. A write another transaction
     * raced takes the single-identifier path, which settles it. */
    async flush() {
      const rows = pending.splice(0);
      if (!rows.length) return;
      await ensureExternalSources(
        tx,
        rows.map(({ source }) => source),
      );
      const inserted = await tx
        .insert(entityExternalId)
        .values(
          rows.map((row) => ({
            entityId: row.productId,
            entityKind: "product" as const,
            source: row.source,
            kind: row.kind,
            externalId: row.externalId,
            url: row.line.productUrl ?? null,
            isPrimary: row.isPrimary,
          })),
        )
        .onConflictDoNothing()
        .returning({
          source: entityExternalId.source,
          kind: entityExternalId.kind,
          externalId: entityExternalId.externalId,
        });
      const written = new Set(inserted.map(learnedKey));
      const proposals: ProductMatchProposal[] = [];
      for (const row of rows) {
        if (written.has(learnedKey(row))) continue;
        try {
          await learnPurchaseProductExternalId(tx, {
            productId: row.productId,
            source: row.source,
            kind: row.kind,
            externalId: row.externalId,
            url: row.line.productUrl,
          });
        } catch (error) {
          if (!(error instanceof PurchaseProductExternalIdCollisionError))
            throw error;
          proposals.push(
            collisionProposal(
              row.line,
              row.productId,
              row,
              error.ownerProductId,
            ),
          );
        }
      }
      await emit(proposals);
    },
  };
}

async function recordReplayClaim(
  tx: DrizzleTransaction,
  input: Pick<ImportWriterInput, "source" | "runId">,
  id: typeof importSourceClaim.$inferSelect.id,
) {
  await tx
    .update(importSourceClaim)
    .set({
      checksum: input.source.checksum,
      lastRunId: input.runId,
      updatedAt: new Date(),
    })
    .where(eq(importSourceClaim.id, id));
}

async function attachSourceDocuments(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
  input: ImportWriterInput,
) {
  const attachments = planAttachments(purchaseId, input);
  if (attachments.length)
    await tx.insert(entityAttachment).values(attachments).onConflictDoNothing();
}

/** A reconciliation of a promoted historical observation has no Run. */
type FindingOrigin = Pick<ImportWriterInput, "ledgerPartyId" | "source"> & {
  runId: ImportWriterInput["runId"] | null;
};

type FindingKind =
  | "duplicate_lines"
  | "sum_mismatch"
  | "foreign_currency"
  | "reversal_kind"
  | "kit_double_booked"
  | "variant_doubt"
  | "product_unresolved"
  | "other";

async function fileFinding(
  tx: DrizzleTransaction,
  input: FindingOrigin,
  purchaseId: PurchaseId,
  kind: FindingKind,
  summary: string,
  proposedFix: ProposedImportFix | null,
): Promise<string> {
  const evidenceFingerprint = await sha256Hex(
    JSON.stringify({ source: input.source, kind, purchaseId, proposedFix }),
  );
  const finding = await publishRunFinding(tx, {
    runId: input.runId,
    ledgerPartyId: input.ledgerPartyId,
    entityKind: "purchase",
    entityId: purchaseId,
    kind,
    summary,
    proposedFix,
    evidenceFingerprint,
  });
  return finding.id;
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

export type ImportSourceAssociationInput = Pick<
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

/** Source ownership and accepted order identity are shared by imports and lifecycle links. */
// Accepted observation and original Product identity must be retained atomically.
async function recordImportSourceAssociation(
  tx: DrizzleTransaction,
  input: ImportSourceAssociationInput,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  outputFingerprint: string,
  recordCanonicalProductBindings = true,
) {
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const owned = await loadAssociationRun(tx, input, partyId);
  if (!owned)
    throw new Error(
      "Import source is not owned by this Run's authenticated member.",
    );
  const target = await loadAssociationTarget(tx, input, purchaseId);
  if (!target)
    throw new Error(
      "Import source order does not match the supported Purchase vendor.",
    );
  if (input.vendorAccountId) {
    const ownedAccount = await loadAssociationAccount(tx, input, partyId);
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
  const associationPlan = planSourceAssociation(
    input,
    purchaseId,
    outputFingerprint,
    orderKey,
    family.root.id,
    existing,
    new Date(),
  );
  const { ownerId } = associationPlan;
  orderKey = associationPlan.orderKey;
  const [association] = await tx
    .insert(importSourceOrder)
    .values(associationPlan.values)
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      targetWhere: isNotNull(importSourceOrder.purchaseId),
      set: associationPlan.set,
    })
    .returning({ id: importSourceOrder.id });
  if (!association) throw new Error("Import source order was not persisted");
  if (!existing && recordCanonicalProductBindings) {
    const bindings = planOriginalBindings(association.id, input);
    if (bindings.length) await tx.insert(importSourceProduct).values(bindings);
  }
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
  await recordReplayClaim(tx, input, family.root.id);
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
        (line) =>
          line.lineKind === "principal" &&
          line.amount !== null &&
          line.amount < 0,
      ));
  const unpricedForeign =
    semanticPlan.writeBlockReason === "foreign_currency" &&
    /^[A-Z]{3}$/.test(input.extraction.candidate?.currency ?? "") &&
    !foreignReversal &&
    (input.extraction.status === "ready" ||
      (input.extraction.status === "needs_review" &&
        input.extraction.reason === "foreign_currency"));
  // A USD order with a printed total and unpriced items: the total books as
  // one aggregate Expense and the items as unpriced lines beside it.
  const unpricedItemization =
    semanticPlan.writeBlockReason === "unpriced_itemization";
  const unpriced = unpricedForeign || unpricedItemization;
  const writesLines = !skipsLineWrites || unpriced;
  const valuation = unpriced ? "unknown" : "USD";
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
    skipsLineWrites && !identityOnly && !unpriced
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
    const recordShipments = (purchaseId: PurchaseId) =>
      recordImportedShipmentEvidence(
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
      await recordReplayClaim(tx, input, family.root.id);
      await recordShipments(existingOrder.purchaseId);
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
      await attachSourceDocuments(tx, purchaseId, input);
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
      await recordShipments(purchaseId);
      return importWriterOutput.parse({
        outcome: "updated",
        purchaseId,
        findingIds: [],
        outputFingerprint: existingOrder.outputFingerprint,
      });
    }
    const vendorId = parseEntityId("vendor", input.vendorId);
    const orderId = canonicalOrderId(candidate.orderId);
    const ordered = await reviewedVendorOrderOwner(
      tx,
      { vendorId, orderId },
      input.targetPurchaseId,
    );
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
    const current = unpriced
      ? ledger.filter((row) => row.lineBasis !== "allocation")
      : ledger;
    const originalBindings =
      target && unpriced && current.length
        ? await loadOriginalLineBindings(tx, target.id)
        : { sources: [], bindings: [] };
    const { matchingExpenses, decision } = planLineMatch(
      candidate,
      current,
      unpriced,
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
    // A lifecycle notice dated the empty Purchase it created by its own day;
    // the order's evidence supplies the order date.
    const replacesNoticeDate =
      !!target && confirmation && (await isAwaitingOrderDetails(tx, target.id));
    const usedFallbackDate =
      fallbackAt !== null && (!target?.date || replacesNoticeDate);
    const orderDate = purchaseDateFor(
      replacesNoticeDate
        ? (candidate.orderedAt ?? target?.date ?? null)
        : (target?.date ?? candidate.orderedAt),
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
      replacesNoticeDate,
    );
    if (header.kind === "create")
      target = await insertWithShortcode(tx, "purchase", header.values);
    else {
      await tx
        .update(purchase)
        .set(header.values)
        .where(eq(purchase.id, header.target.id));
      target = header.target;
    }
    const purchaseId = parseEntityId("purchase", target.id);
    // A Shipment recorded before this Purchase held its order number links now.
    if (target.orderId)
      await linkShipmentsByOrderId(databaseForTransaction(tx), systemActor(), {
        purchaseIds: [purchaseId],
      });
    const note = planPurchaseNote(
      purchaseId,
      fallbackAt,
      dateMail?.messageId,
      usedFallbackDate,
    );
    if (note) {
      await tx
        .update(purchase)
        .set({
          notes: sql`concat_ws(E'\n\n', nullif(${purchase.notes}, ''), ${note.research}::text)`,
        })
        .where(eq(purchase.id, note.purchaseId));
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
    await attachSourceDocuments(tx, purchaseId, input);

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
        unpriced,
        loadExpenses: () => existingExpenses(tx, purchaseId),
        lineProducts: (requests) =>
          lineProductResolver(tx, input.vendorId, requests, {
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
        const filled = await tx
          .update(expense)
          .set({ trade: "other" })
          .where(fallback.where)
          .returning({ id: expense.id });
        for (const mutation of createdExpenses)
          if (filled.some((line) => line.id === mutation.targetId))
            mutation.fields.push("trade");
      }
    }
    const classifiedLines = await loadClassifiedPurchaseLines(tx, purchaseId);
    await validateExpenseInheritances(tx, classifiedLines);
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
    await recordShipments(purchaseId);
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
      if (payments.length)
        await tx.insert(purchasePaymentEvidence).values(payments);
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
    await tx.execute(
      sql`UPDATE "Run" SET "ordersSeen" = "ordersSeen" + 1, ${created ? sql`"imported" = "imported" + 1` : sql`"updated" = "updated" + 1`}, "updatedAt" = now() WHERE "id" = ${input.runId}`,
    );

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
