import { plainDate } from "@cubby/schemas/base-entity";
import { buildActorContext } from "@cubby/schemas/context";
import {
  expenseLineKindValues,
  type ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import {
  parseEntityId,
  userId as userIdSchema,
  runEntityId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  importWriterInput,
  importWriterOutput,
  type ExtractedPurchaseLine,
  type ImportWriterInput,
  type ImportWriterOutput,
  type ProposedImportFix,
  type AcceptedSourceOrder,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import {
  PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
  PURCHASE_IMPORT_KIT_DETECTION_FEATURE,
  PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
  PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE,
  PURCHASE_IMPORT_REVERSAL_KIND_FEATURE,
} from "~/server/ai/features";
import { runJevChoice, type JevChoiceResult } from "~/server/ai/jev";
import type { Database, DrizzleTransaction } from "~/server/db";
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
  purchasePaymentEvidence,
  run as runTable,
  runFinding,
  vendorAccount,
} from "~/server/db/schema";
import { assertRunCapabilityById } from "~/server/purchase-import/capabilities";
import { classificationAllowsField } from "~/server/repo/classification-field-policy";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  effectiveExpenseTradeSql,
  validateExpenseInheritance,
} from "~/server/repo/expense-inheritance";
import { validateProductPolicy } from "~/server/repo/inheritance-validation";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import { upsertAgentProductMatch } from "~/server/repo/product-match-candidate";
import {
  externalIdKey,
  findProductsByExternalIds,
} from "~/server/repo/product/find-by-external-ids";
import { findProductNameCandidates } from "~/server/repo/product/resolve-names";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  aggregateReplacementApprovalFingerprint,
  loadAggregateReplacementSnapshot,
  redistributeReplacementAttributions,
} from "./aggregate-replacement";
import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { manufacturerPartRequests } from "./manufacturer-identity";
import {
  lockPartySettlement,
  settlePurchaseFromRetainedPayments,
} from "./retained-settlement";
import { recordRunWrites } from "./run-audit";
import {
  lockImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";
import { sourceOrderKey } from "./source-order-key";
import { decideLineWrite, type ExistingExpenseSnapshot } from "./writer-policy";

const PURCHASE_EXTERNAL_ID_KIND = "retailer_sku" as const;
export const PRODUCT_IDENTITY_RULES =
  "Choose an existing product only when the title, model, size, count, and variant identify the same sellable item. Choose none for a distinct or uncertain variant.";

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
        input.vendorAccountId
          ? sql`${vendorAccount.id} IS NOT NULL`
          : undefined,
      ),
    )
    .limit(1);
  if (!owned)
    throw new Error("Import source is not owned by the authenticated member");
}

async function findPurchase(
  tx: DrizzleTransaction,
  vendorId: ReturnType<typeof parseEntityId<"vendor">>,
  orderId: string | null,
) {
  if (!orderId) return null;
  return tx.query.purchase.findFirst({
    where: and(
      eq(purchase.vendorId, vendorId),
      eq(purchase.orderId, orderId),
      notDeleted(purchase),
    ),
  });
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

export const amazonAsin = (url: string | undefined): string | null => {
  if (!url) return null;
  const parsed = new URL(url);
  if (!/(^|\.)amazon\./u.test(parsed.hostname.toLowerCase())) return null;
  return (
    /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/iu
      .exec(parsed.pathname)?.[1]
      ?.toUpperCase() ?? null
  );
};

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
};

const lineDecisionSubject = (line: ExtractedPurchaseLine) =>
  JSON.stringify({
    title: line.title,
    amount: line.amount,
    extractedLineKind: line.lineKind,
    quantity: line.quantity ?? null,
    sku: line.sku ?? null,
    seller: line.seller ?? null,
    productUrl: line.productUrl ?? null,
  });

export async function chooseLineStage(
  db: Database,
  runId: string,
  index: number,
  line: ExtractedPurchaseLine,
  stage: "role" | "kit" | "promotion" | "reversal",
) {
  const specs = {
    role: {
      feature: PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
      choices: expenseLineKindValues,
      rules:
        "Classify the receipt row's financial role. Principal is a purchased or returned item; taxes, shipping, discounts, fees, tips, and other adjustments are not products.",
    },
    kit: {
      feature: PURCHASE_IMPORT_KIT_DETECTION_FEATURE,
      choices: ["kit_with_components", "single", "n_pack"] as const,
      rules:
        "Classify the sellable item. A kit has distinct reusable components, an n-pack is repeated units of one item, and a single is one sellable product.",
    },
    promotion: {
      feature: PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE,
      choices: ["promote", "coarse_only"] as const,
      rules:
        "Choose promote only when the line identifies a durable sellable product worth creating or linking. Choose coarse_only for services, vague bundles, fees, warranties, or insufficient identity.",
    },
    reversal: {
      feature: PURCHASE_IMPORT_REVERSAL_KIND_FEATURE,
      choices: ["return", "concession", "cancellation", "replacement"] as const,
      rules:
        "Classify a negative item row: return means units left the household; concession means the item was kept; cancellation means it was never acquired; replacement means the money line accompanies a replacement rather than a returned unit.",
    },
  } as const;
  const spec = specs[stage];
  return runJevChoice({
    feature: spec.feature,
    subject: lineDecisionSubject(line),
    rules: spec.rules,
    choices: spec.choices,
    allowNone: false,
    usage: {
      db,
      operation: `purchaseImport.${stage}.${index}`,
      runId: runEntityId.parse(runId),
    },
  });
}

// The staged decision pipeline intentionally keeps all five model decisions and
// deterministic short-circuits in one ordered pass over each source line.
// eslint-disable-next-line complexity
async function decideLineIdentities(
  db: Database,
  input: ImportWriterInput,
): Promise<LineIdentityDecision[]> {
  const decisions: LineIdentityDecision[] = [];
  const decisionsByExternalIdentity = new Map<string, LineIdentityDecision>();
  const candidate = input.extraction.candidate;
  if (!candidate) return [];
  const vendorId = parseEntityId("vendor", input.vendorId);
  const sources = await Promise.all(
    candidate.lines.map((line) =>
      lineIdentifiers(line).length
        ? resolveProductIdentifierSource(db, { url: line.productUrl, vendorId })
        : Promise.resolve(""),
    ),
  );
  const exactRequests = candidate.lines.map((line, index) => [
    ...lineIdentifiers(line).map((identifier) => ({
      ...identifier,
      source: sources[index]!,
    })),
    ...manufacturerPartRequests(line),
  ]);
  const exactHits = await findProductsByExternalIds(db, exactRequests.flat());
  for (const [index, line] of candidate.lines.entries()) {
    const role = await chooseLineStage(db, input.runId, index, line, "role");
    const selectedRole = expenseLineKindValues[role.selectedIndex ?? -1];
    const lineKind =
      selectedRole && role.probability >= 0.85 ? selectedRole : line.lineKind;
    const kit = await chooseLineStage(db, input.runId, index, line, "kit");
    const kitKind =
      (["kit_with_components", "single", "n_pack"] as const)[
        kit.selectedIndex ?? 1
      ] ?? "single";
    const promotion = await chooseLineStage(
      db,
      input.runId,
      index,
      line,
      "promotion",
    );
    const promote =
      promotion.selectedIndex === 0 && promotion.probability >= 0.6;
    const reversal =
      line.amount < 0
        ? await chooseLineStage(db, input.runId, index, line, "reversal")
        : null;
    const reversalKind = reversal
      ? ((["return", "concession", "cancellation", "replacement"] as const)[
          reversal.selectedIndex ?? 1
        ] ?? "concession")
      : null;
    const baseDecision = { lineKind, kitKind, reversalKind };
    if (!classificationAllowsField("expense", { lineKind }, "productId")) {
      decisions.push({
        productId: null,
        promote: false,
        variantDoubt: false,
        probability: 1,
        unresolvedReason: null,
        ...baseDecision,
      });
      continue;
    }
    const identity = lineExternalIdentity(line, sources[index]!);
    const decidedEarlier = identity
      ? decisionsByExternalIdentity.get(identity)
      : null;
    if (decidedEarlier) {
      decisions.push(decidedEarlier);
      continue;
    }
    const matches = new Map(
      (exactRequests[index] ?? [])
        .flatMap((identifier) => exactHits.get(externalIdKey(identifier)) ?? [])
        .map((hit) => [hit.id, hit]),
    );
    if (matches.size > 0) {
      const match = [...matches.values()][0]!;
      const ambiguous = matches.size > 1;
      const decision = {
        productId: ambiguous ? null : match.id,
        promote: !ambiguous,
        variantDoubt: ambiguous,
        probability: ambiguous ? 0 : 1,
        unresolvedReason: ambiguous
          ? "Exact identifiers refer to different Products; choose the intended Product."
          : null,
        ...baseDecision,
      };
      decisions.push(decision);
      if (identity) decisionsByExternalIdentity.set(identity, decision);
      continue;
    }
    const candidates = await findProductNameCandidates(db, line.title);
    if (candidates.length === 0) {
      const decision = {
        productId: null,
        promote,
        variantDoubt: false,
        probability: 1,
        unresolvedReason: null,
        ...baseDecision,
      };
      decisions.push(decision);
      if (identity) decisionsByExternalIdentity.set(identity, decision);
      continue;
    }
    const choice = await runJevChoice({
      feature: PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
      subject: JSON.stringify({
        title: line.title,
        sku: line.sku ?? null,
        seller: line.seller ?? null,
        productUrl: line.productUrl ?? null,
      }),
      rules: PRODUCT_IDENTITY_RULES,
      choices: candidates.map(
        (candidate) =>
          `${candidate.name} | manufacturer=${candidate.manufacturer || "unknown"} | model=${candidate.model ?? "unknown"}`,
      ),
      usage: {
        db,
        operation: `purchaseImport.productIdentity.${index}`,
        runId: runEntityId.parse(input.runId),
      },
    });
    const selected =
      choice.selectedIndex === null ? null : candidates[choice.selectedIndex];
    if (selected && choice.probability >= 0.85) {
      const decision = {
        productId: selected.id,
        promote: true,
        variantDoubt: false,
        probability: choice.probability,
        unresolvedReason: null,
        ...baseDecision,
      };
      decisions.push(decision);
      if (identity) decisionsByExternalIdentity.set(identity, decision);
    } else {
      const decision = {
        productId: null,
        promote,
        variantDoubt: choice.probability >= 0.6,
        probability: choice.probability,
        unresolvedReason: null,
        ...baseDecision,
      };
      decisions.push(decision);
      if (identity) decisionsByExternalIdentity.set(identity, decision);
    }
  }
  return decisions;
}

type ExplicitProductResolution = NonNullable<
  ImportWriterInput["productResolutions"]
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
  ) => Promise<JevChoiceResult>,
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
    });
  }
  return decisions;
}

export function receiptProductQuantity(
  productId: string | null,
  line: ExtractedPurchaseLine,
  decision: LineIdentityDecision,
): number | null {
  if (!productId || line.quantity === undefined) return null;
  if (line.amount >= 0) return Math.abs(line.quantity);
  if (decision.reversalKind === "return") return -Math.abs(line.quantity);
  return decision.reversalKind === "concession" ? 0 : null;
}

export async function resolveLineProduct(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  decision: LineIdentityDecision,
  vendorId: string,
  productsByExternalIdentity: Map<string, string>,
  onCreated?: (productId: ProductId) => void,
) {
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
      where: and(eq(product.id, productId), notDeleted(product)),
    });
    if (!liveProduct) throw new Error("The reviewed Product no longer exists.");
    await learnLineIdentifiers(tx, productId, line, source);
    if (externalIdentity)
      productsByExternalIdentity.set(externalIdentity, productId);
    return productId;
  }
  if (decision.lineKind !== "principal" || !decision.promote) return null;
  const created = await insertWithShortcode(tx, "product", {
    name: line.title,
    manufacturer: "",
  });
  onCreated?.(created.id);
  await learnLineIdentifiers(tx, created.id, line, source);
  if (externalIdentity)
    productsByExternalIdentity.set(externalIdentity, created.id);
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
) {
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
      await upsertAgentProductMatch(tx, {
        productIds: [productId, error.ownerProductId],
        evidence: `Order line "${line.title}" carries ${error.source}/${error.kind} ${error.externalId}, which already identifies the other Product. Confirm whether both are the same exact variant before merging.`,
        sourceUrls: line.productUrl ? [line.productUrl] : [],
      });
    }
  }
}

async function fileFinding(
  tx: DrizzleTransaction,
  input: ImportWriterInput,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  kind:
    | "duplicate_lines"
    | "sum_mismatch"
    | "foreign_currency"
    | "reversal_kind"
    | "kit_double_booked"
    | "variant_doubt"
    | "product_unresolved"
    | "arrived"
    | "other",
  summary: string,
  proposedFix: ProposedImportFix | null,
): Promise<string> {
  const evidenceFingerprint = await sha256Hex(
    JSON.stringify({ source: input.source, kind, purchaseId, proposedFix }),
  );
  const [row] = await tx
    .insert(runFinding)
    .values({
      runId: input.runId,
      ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
      entityKind: "purchase",
      entityId: purchaseId,
      kind,
      summary,
      proposedFix,
      evidenceFingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: runFinding.id });
  if (row) return row.id;
  const existing = await tx.query.runFinding.findFirst({
    where: and(
      eq(
        runFinding.ledgerPartyId,
        parseEntityId("ledgerParty", input.ledgerPartyId),
      ),
      eq(runFinding.entityId, purchaseId),
      eq(runFinding.kind, kind),
      eq(runFinding.evidenceFingerprint, evidenceFingerprint),
      eq(runFinding.status, "open"),
    ),
  });
  if (!existing) throw new Error("Import finding conflict did not resolve");
  return existing.id;
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
  productBindings?: ReadonlyArray<
    Pick<typeof importSourceProduct.$inferInsert, "lineIndex" | "productId">
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
    })),
  );
}

/** Source ownership and accepted order identity are shared by imports and lifecycle links. */
async function recordImportSourceAssociation(
  tx: Pick<DrizzleTransaction, "insert" | "select" | "update">,
  input: ImportSourceAssociationInput,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  outputFingerprint: string,
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
  const orderKey = sourceOrderKey({
    vendorId: input.vendorId,
    orderId: input.orderId,
    orderLocator: input.orderLocator,
  });
  const retained = await readSourceFamilyOrder(tx, family, orderKey, "update");
  const existing = retained?.association;
  const ownerId = retained?.claim.id ?? family.root.id;
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
      set: {
        checksum: input.source.checksum,
        outputFingerprint,
        originalOrder: existing?.originalOrder ?? input.originalOrder ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: importSourceOrder.id });
  if (!association) throw new Error("Import source order was not persisted");
  await recordOriginalProductBindings(
    tx,
    association.id,
    existing?.originalOrder,
    input,
  );
  await tx
    .update(importSourceClaim)
    .set({
      checksum: input.source.checksum,
      lastRunId: input.runId,
      updatedAt: new Date(),
    })
    .where(eq(importSourceClaim.id, ownerId));
  return ownerId;
}

/**
 * Atomic vendor-order writer. The source claim is checked before any conflict
 * rules, so an exact replay is a true no-op even when the destination has
 * since accumulated additional evidence.
 */
export async function importVendorOrder(
  db: Database,
  rawInput: ImportWriterInput,
  actorUserId: string,
  options: { applyUnassignedPurposeFallback?: boolean } = {},
): Promise<ImportWriterOutput> {
  const input = importWriterInput.parse(rawInput);
  // Validation consumes this exact deterministic projection before any writer
  // side effect. Keep it on the mutation path so plan drift is explicit.
  const semanticPlan = buildPurchaseImportPlan(input.extraction);
  await assertRunCapabilityById(db, input.runId, "business_writer");
  await assertImportOwnership(db, input, actorUserId);
  const skipsLineWrites = semanticPlan.writeBlockReason !== null;
  const identityOnly = [
    "missing_currency",
    "foreign_currency",
    "missing_date",
    "missing_total",
  ].includes(semanticPlan.writeBlockReason ?? "");
  const explicitResolutions = input.productResolutions;
  const identityDecisions =
    skipsLineWrites && !identityOnly
      ? []
      : explicitResolutions
        ? await explicitLineDecisions(
            input.extraction.candidate?.lines ?? [],
            explicitResolutions,
            (index, line) =>
              chooseLineStage(db, input.runId, index, line, "reversal"),
          )
        : await decideLineIdentities(db, input);
  // The callback is the transaction's explicit policy matrix; splitting it
  // would hide the all-or-nothing write boundary.
  // eslint-disable-next-line complexity
  return withTransaction(db, async (tx) => {
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    // First, before any row lock: a settlement pass holds this lock while it
    // waits on Purchase rows, so taking it after writing the Purchase would
    // deadlock against that pass.
    await lockPartySettlement(tx, partyId);
    const [ownedScope] = await tx
      .select({ partyId: ledgerParty.id })
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
              eq(
                vendorAccount.vendorId,
                parseEntityId("vendor", input.vendorId),
              ),
              notDeleted(vendorAccount),
            )
          : sql`false`,
      )
      .where(
        and(
          eq(ledgerParty.id, partyId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
          input.vendorAccountId
            ? sql`${vendorAccount.id} IS NOT NULL`
            : undefined,
        ),
      )
      .limit(1);
    if (!ownedScope) {
      throw new Error("Import source is not owned by the authenticated member");
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
    const candidate = input.extraction.candidate;
    if (!candidate)
      throw new Error(
        "Unreadable imports require a typed candidate before writing",
      );
    const orderKey = sourceOrderKey({
      vendorId: input.vendorId,
      orderId: candidate.orderId,
      orderLocator: input.orderLocator,
    });
    const existingOrder = (
      await readSourceFamilyOrder(tx, family, orderKey, "update")
    )?.association;
    if (
      input.targetPurchaseId &&
      existingOrder &&
      input.targetPurchaseId !== existingOrder.purchaseId
    )
      throw new Error(
        "This source order already belongs to a different Purchase.",
      );
    if (existingOrder && existingOrder.checksum === input.source.checksum) {
      await tx
        .update(importSourceClaim)
        .set({ lastRunId: input.runId })
        .where(eq(importSourceClaim.id, existingOrder.sourceClaimId));
      return importWriterOutput.parse({
        outcome: "replayed",
        purchaseId: existingOrder.purchaseId,
        findingIds: [],
        outputFingerprint: existingOrder.outputFingerprint,
      });
    }
    const isSourceRefresh = existingOrder !== undefined;

    const vendorId = parseEntityId("vendor", input.vendorId);
    const vendorAccountId = input.vendorAccountId
      ? parseEntityId("vendorAccount", input.vendorAccountId)
      : null;
    const ordered = await findPurchase(tx, vendorId, candidate.orderId);
    const selectedId = input.targetPurchaseId ?? existingOrder?.purchaseId;
    const chosen = selectedId
      ? await tx.query.purchase.findFirst({
          where: and(
            eq(purchase.id, parseEntityId("purchase", selectedId)),
            notDeleted(purchase),
          ),
        })
      : undefined;
    if (selectedId && !chosen)
      throw new Error("The reviewed Purchase target no longer exists.");
    if (
      chosen &&
      (chosen.vendorId !== vendorId ||
        (chosen.orderId !== null &&
          chosen.orderId !== candidate.orderId &&
          !(candidate.orderId === null && input.targetPurchaseId)))
    )
      throw new Error(
        "The reviewed Purchase target has a different vendor or order identity.",
      );
    if (chosen && ordered && chosen.id !== ordered.id)
      throw new Error(
        "Another Purchase already owns this vendor order. Review the two Purchases before importing.",
      );
    let target = chosen ?? ordered;
    const created = target == null;
    const orderDate = purchaseDateFor(
      candidate.orderedAt,
      target?.date ?? null,
    );
    if (!target) {
      target = await insertWithShortcode(tx, "purchase", {
        vendorId,
        vendorAccountId,
        defaultTrade: input.defaultTrade,
        defaultProjectId: input.defaultProjectId
          ? parseEntityId("project", input.defaultProjectId)
          : null,
        runId: input.runId,
        orderId: candidate.orderId,
        displayLabel: candidate.merchant,
        date: orderDate,
        statedTotal:
          candidate.currency === "USD" ? candidate.printedGrandTotal : null,
      });
    } else if (!isSourceRefresh) {
      // A null trade can be intentional Project inheritance. Filling a
      // Purchase default would take precedence over existing line Projects.
      const canFillTrade =
        target.defaultTrade === null &&
        target.defaultProjectId === null &&
        input.defaultTrade !== undefined;
      const [assignedLine] = canFillTrade
        ? await tx
            .select({ id: expense.id })
            .from(expense)
            .where(
              and(
                eq(expense.purchaseId, target.id),
                eq(expense.lineKind, "principal"),
                notDeleted(expense),
                or(
                  isNotNull(expense.projectId),
                  isNotNull(expense.trade),
                  isNotNull(effectiveExpenseTradeSql()),
                ),
              ),
            )
            .limit(1)
        : [];
      await tx
        .update(purchase)
        .set({
          orderId: target.orderId ?? candidate.orderId,
          date: target.date ?? orderDate,
          vendorAccountId: target.vendorAccountId ?? vendorAccountId,
          defaultTrade:
            target.defaultTrade ??
            (canFillTrade && !assignedLine ? input.defaultTrade : null),
          defaultProjectId:
            target.defaultProjectId ??
            (input.defaultProjectId
              ? parseEntityId("project", input.defaultProjectId)
              : null),
          runId: target.runId ?? input.runId,
          displayLabel: target.displayLabel ?? candidate.merchant,
          statedTotal:
            target.statedTotal ??
            (candidate.currency === "USD" ? candidate.printedGrandTotal : null),
        })
        .where(eq(purchase.id, target.id));
    }
    const purchaseId = parseEntityId("purchase", target.id);
    const findingIds: string[] = [];
    const productLines: NonNullable<
      ImportSourceAssociationInput["productBindings"]
    >[number][] = [];
    let replacementExpenseId: string | null = null;
    const rowMutations: Array<{
      targetKind: "expense" | "product";
      targetId: string;
      mutationKind: "create" | "update" | "delete";
      fields: string[];
    }> = [];

    await attachEvidence(tx, purchaseId, input);

    const reviewReason =
      input.extraction.status === "needs_review"
        ? input.extraction.reason
        : null;
    const reviewDetail =
      input.extraction.status === "needs_review"
        ? input.extraction.detail
        : "Imported order requires review.";
    // An identified Purchase retains its original candidate before incomplete
    // pricing or dates can support canonical Expense rows.
    const lines = identityOnly ? [] : candidate.lines;
    if (identityOnly) {
      // A changed source preserves its first accepted snapshot; it cannot mint
      // a new unbound Product while overwriting that immutable ordered context.
      if (!isSourceRefresh) {
        const productsByExternalIdentity = new Map<string, string>();
        for (const [lineIndex, line] of candidate.lines.entries()) {
          const identity = identityDecisions[lineIndex];
          if (!identity || identity.lineKind !== "principal") continue;
          const productId = await resolveLineProduct(
            tx,
            line,
            identity,
            input.vendorId,
            productsByExternalIdentity,
            (createdId) =>
              rowMutations.push({
                targetKind: "product",
                targetId: createdId,
                mutationKind: "create",
                fields: ["name", "externalIds"],
              }),
          );
          if (productId) productLines.push({ lineIndex, productId });
          if (identity.unresolvedReason)
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "product_unresolved",
                `Product resolution is required for “${line.title}”: ${identity.unresolvedReason}`,
                null,
              ),
            );
          if (identity.variantDoubt)
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "variant_doubt",
                `The existing match for “${line.title}” does not establish its exact ordered variant. Review the distinct Product before merging.`,
                null,
              ),
            );
        }
      }
    } else if (
      reviewReason === "sum_mismatch" ||
      reviewReason === "missing_total"
    ) {
      if (candidate.printedGrandTotal !== null) {
        const current = await existingExpenses(tx, purchaseId);
        if (current.length === 0) {
          const inserted = await insertWithShortcode(tx, "expense", {
            purchaseId,
            name: candidate.merchant ?? "Imported order",
            cost: candidate.printedGrandTotal,
            date: orderDate,
            lineKind: "principal",
            lineBasis: "allocation",
            costType: "materials",
            trade: null,
          });
          rowMutations.push({
            targetKind: "expense",
            targetId: inserted.id,
            mutationKind: "create",
            fields: ["name", "cost", "lineKind", "purchaseId"],
          });
        }
      }
      findingIds.push(
        await fileFinding(
          tx,
          input,
          purchaseId,
          "sum_mismatch",
          reviewDetail,
          null,
        ),
      );
    } else if (
      reviewReason === "foreign_currency" ||
      candidate.currency !== "USD"
    ) {
      findingIds.push(
        await fileFinding(
          tx,
          input,
          purchaseId,
          "foreign_currency",
          input.extraction.status === "needs_review"
            ? input.extraction.detail
            : `Order uses ${candidate.currency}; no expense lines were written.`,
          null,
        ),
      );
    } else {
      const current = await existingExpenses(tx, purchaseId);
      const decision = decideLineWrite(current, lines);
      if (decision.kind === "conflict") {
        // A fresh accepted original can support existing Product lines without
        // repeating financial lines or changing the first source snapshot.
        for (const resolution of explicitResolutions ?? []) {
          if (
            resolution.kind === "existing" &&
            candidate.lines[resolution.lineIndex]?.lineKind === "principal" &&
            current.some(
              (line) =>
                line.lineKind === "principal" &&
                line.productId === resolution.productId,
            )
          )
            productLines.push({
              lineIndex: resolution.lineIndex,
              productId: parseEntityId("product", resolution.productId),
            });
        }
        findingIds.push(
          await fileFinding(
            tx,
            input,
            purchaseId,
            "duplicate_lines",
            "Existing purchase lines are not the single replaceable aggregate shape.",
            null,
          ),
        );
      } else if (decision.kind === "review_aggregate") {
        if (target.itemizationEvidence) {
          findingIds.push(
            await fileFinding(
              tx,
              input,
              purchaseId,
              "duplicate_lines",
              "Reviewed item lines already exist. Compare the new evidence before changing them.",
              null,
            ),
          );
        } else {
          replacementExpenseId = decision.aggregate.id;
        }
      } else if (decision.kind === "insert") {
        const productsByExternalIdentity = new Map<string, string>();
        await tx
          .update(purchase)
          .set({ itemizationEvidence: true })
          .where(eq(purchase.id, purchaseId));
        for (const [lineIndex, line] of decision.lines.entries()) {
          const identity = identityDecisions[lineIndex] ?? {
            productId: null,
            promote: false,
            variantDoubt: false,
            unresolvedReason: null,
            probability: 0,
            lineKind: line.lineKind,
            kitKind: "single" as const,
            reversalKind: null,
          };
          const productId = await resolveLineProduct(
            tx,
            line,
            identity,
            input.vendorId,
            productsByExternalIdentity,
            // Recorded on this run so its follow-up enrichment and Changes
            // list know which Products the import created.
            (createdId) =>
              rowMutations.push({
                targetKind: "product",
                targetId: createdId,
                mutationKind: "create",
                fields: ["name", "externalIds"],
              }),
          );
          const quantity = receiptProductQuantity(productId, line, identity);
          if (productId) productLines.push({ lineIndex, productId });
          const inserted = await insertWithShortcode(tx, "expense", {
            purchaseId,
            name: line.title,
            notes: line.seller ? `Seller: ${line.seller}` : null,
            // The line's product page is where a later enrichment pass starts.
            url: line.productUrl ?? null,
            cost: line.amount,
            date: orderDate,
            lineKind: identity.lineKind,
            lineBasis: "item_line",
            costType: "materials",
            trade: null,
            economicRole: "vendor",
            productId,
            productQuantity: quantity,
          });
          rowMutations.push({
            targetKind: "expense",
            targetId: inserted.id,
            mutationKind: "create",
            fields: [
              "name",
              "cost",
              "lineKind",
              "productId",
              "productQuantity",
              "purchaseId",
              ...(line.productUrl ? ["url"] : []),
            ],
          });
          if (identity.unresolvedReason && identity.lineKind === "principal") {
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "product_unresolved",
                `Product resolution is required for “${line.title}”: ${identity.unresolvedReason}`,
                null,
              ),
            );
          }
          if (identity.variantDoubt) {
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "variant_doubt",
                `Created a distinct product for “${line.title}” because the closest existing match was uncertain (${Math.round(identity.probability * 100)}%).`,
                null,
              ),
            );
          }
          if (identity.kitKind === "kit_with_components") {
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "kit_double_booked",
                `“${line.title}” appears to be a kit. Review its component accounting before receiving inventory.`,
                null,
              ),
            );
          }
          // Only a principal line reverses a stocked item; a negative
          // discount, tax, or shipping line is an ordinary adjustment.
          if (
            identity.lineKind === "principal" &&
            line.amount < 0 &&
            identity.reversalKind !== "return" &&
            identity.reversalKind !== "concession"
          ) {
            findingIds.push(
              await fileFinding(
                tx,
                input,
                purchaseId,
                "reversal_kind",
                `“${line.title}” was classified as ${identity.reversalKind ?? "an uncertain reversal"}; no inventory quantity was inferred.`,
                null,
              ),
            );
          }
        }
      }
    }

    if (options.applyUnassignedPurposeFallback) {
      const createdExpenses = rowMutations.filter(
        (mutation) =>
          mutation.targetKind === "expense" &&
          mutation.mutationKind === "create",
      );
      if (createdExpenses.length) {
        // Resolve inheritance after Products exist. A Purchase-wide default
        // would override an already chosen household Project on food lines.
        const filled = await tx
          .update(expense)
          .set({ trade: "other" })
          .where(
            and(
              inArray(
                expense.id,
                createdExpenses.map((mutation) =>
                  parseEntityId("expense", mutation.targetId),
                ),
              ),
              eq(expense.lineKind, "principal"),
              isNull(effectiveExpenseTradeSql()),
              notDeleted(expense),
            ),
          )
          .returning({ id: expense.id });
        for (const mutation of createdExpenses)
          if (filled.some((line) => line.id === mutation.targetId))
            mutation.fields.push("trade");
      }
    }
    const classifiedLines = await tx.query.expense.findMany({
      where: and(eq(expense.purchaseId, purchaseId), notDeleted(expense)),
    });
    for (const line of classifiedLines)
      await validateExpenseInheritance(tx, line);
    // A line's Product must be allowed by its effective spending category.
    await validateProductPolicy(tx, { purchaseId });

    // Receiving is for stocked items: a line that carries or will carry a
    // Product, or goods still unresolved. Expense-only lines (meals, tickets)
    // and lines Jev judged not worth a Product have nothing to receive — the
    // same rule delivery mail applies later (gmail/process.ts). A Product line
    // already on the Purchase counts too (an aggregate awaiting replacement
    // has none).
    const stocksItems = identityDecisions.some(
      (decision) =>
        decision.lineKind === "principal" &&
        Boolean(
          decision.productId || decision.promote || decision.unresolvedReason,
        ),
    );
    const [stockedLine] = stocksItems
      ? []
      : await tx
          .select({ id: expense.id })
          .from(expense)
          .where(
            and(
              eq(expense.purchaseId, purchaseId),
              eq(expense.lineKind, "principal"),
              isNotNull(expense.productId),
              notDeleted(expense),
            ),
          )
          .limit(1);
    if (
      candidate.allShipmentsDelivered === true &&
      (stocksItems || stockedLine)
    ) {
      findingIds.push(
        await fileFinding(
          tx,
          input,
          purchaseId,
          "arrived",
          "All shipments are marked delivered. Review and receive this purchase.",
          { kind: "receive_purchase", purchaseId },
        ),
      );
    }

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
    );
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
      if (isSourceRefresh) {
        await tx
          .delete(purchasePaymentEvidence)
          .where(
            and(
              eq(purchasePaymentEvidence.sourceClaimId, sourceClaimId),
              eq(purchasePaymentEvidence.purchaseId, purchaseId),
            ),
          );
      }
      for (const [evidenceIndex, payment] of candidate.payments.entries()) {
        await tx.insert(purchasePaymentEvidence).values({
          purchaseId,
          sourceClaimId,
          amount: payment.amount,
          chargedAt: payment.chargedAt ? new Date(payment.chargedAt) : null,
          cardLastFour: payment.cardLastFour,
          description: payment.description,
          evidenceIndex,
        });
      }
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
    if (replacementExpenseId) {
      const reviewedIdentities = identityDecisions.map((decision) => ({
        ...decision,
        expenseOnly: decision.expenseOnly ?? false,
      }));
      const preview = await loadAggregateReplacementSnapshot(
        tx,
        purchaseId,
        replacementExpenseId,
      );
      const reviewedLineAttributions =
        await redistributeReplacementAttributions(
          tx,
          preview.allocations,
          lines,
        );
      findingIds.push(
        await fileFinding(
          tx,
          input,
          purchaseId,
          "duplicate_lines",
          "Review replacing the recorded aggregate with these receipt lines. The preview preserves category, project, notes and each party's exact cents.",
          {
            kind: "replace_aggregate_line",
            purchaseId,
            lines,
            reviewSnapshot: {
              ...preview.snapshot,
              fingerprint: await aggregateReplacementApprovalFingerprint(
                preview.snapshot.fingerprint,
                lines,
                reviewedIdentities,
                reviewedLineAttributions,
              ),
            },
            reviewedLineIdentities: reviewedIdentities,
            reviewedLineAttributions,
          },
        ),
      );
    }
    await recordRunWrites(
      tx,
      buildActorContext(userIdSchema.parse(actorUserId), "mcp", {
        runId: runEntityId.parse(input.runId),
      }),
      [
        {
          entityKind: "purchase",
          entityId: purchaseId,
          action: created ? "create" : "update",
          fields: ["header", "documents", "expenses", "paymentEvidence"],
        },
        ...rowMutations.map(
          ({ targetKind, targetId, mutationKind, fields }) => ({
            entityKind: targetKind,
            entityId: targetId,
            action:
              mutationKind === "create"
                ? ("create" as const)
                : ("update" as const),
            fields,
          }),
        ),
      ],
    );
    await tx.execute(sql`UPDATE "Run" SET
      "ordersSeen" = "ordersSeen" + 1,
      ${created ? sql`"imported" = "imported" + 1` : sql`"updated" = "updated" + 1`},
      "updatedAt" = now()
      WHERE "id" = ${input.runId}`);

    return importWriterOutput.parse({
      outcome: created ? "created" : "updated",
      purchaseId,
      findingIds,
      outputFingerprint: claimFingerprint,
    });
  });
}
