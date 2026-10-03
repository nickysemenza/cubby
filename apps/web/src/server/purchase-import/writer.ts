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
} from "@cubby/schemas/purchase-import";
import { and, eq, ilike, isNotNull, or, sql } from "drizzle-orm";

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
  ledgerParty,
  ledgerSourceClaim,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  product,
  purchase,
  purchasePaymentEvidence,
  run as runTable,
  runFinding,
  vendorAccount,
} from "~/server/db/schema";
import { assertRunCapabilityById } from "~/server/purchase-import/capabilities";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { validateExpenseInheritance } from "~/server/repo/expense-inheritance";
import { upsertAgentProductMatch } from "~/server/repo/product-match-candidate";
import {
  externalIdKey,
  findProductsByExternalIds,
} from "~/server/repo/product/find-by-external-ids";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { sha256Hex } from "~/server/semantic/hash";
import { dateOnly } from "~/server/utils/date-only";

import {
  aggregateReplacementApprovalFingerprint,
  loadAggregateReplacementSnapshot,
  redistributeReplacementAttributions,
} from "./aggregate-replacement";
import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import {
  lockPartySettlement,
  settlePurchaseFromRetainedPayments,
} from "./retained-settlement";
import { recordRunWrites } from "./run-audit";
import { decideLineWrite, type ExistingExpenseSnapshot } from "./writer-policy";

const PURCHASE_EXTERNAL_ID_KIND = "retailer_sku" as const;
export const PRODUCT_IDENTITY_RULES =
  "Choose an existing product only when the title, model, size, count, and variant identify the same sellable item. Choose none for a distinct or uncertain variant.";

const orderedDate = (value: string | null): string =>
  dateOnly(value ? new Date(value) : undefined);

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

async function attachPendingMailEvidence(
  tx: DrizzleTransaction,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  ledgerPartyId: ReturnType<typeof parseEntityId<"ledgerParty">>,
  vendorId: ReturnType<typeof parseEntityId<"vendor">>,
  orderId: string | null,
) {
  if (!orderId) return;
  const attachments = await tx
    .select({
      imageId: orderMailAttachment.imageId,
      filename: orderMailAttachment.filename,
    })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .innerJoin(
      orderMailAttachment,
      and(
        eq(orderMailAttachment.orderMailId, orderMail.id),
        isNotNull(orderMailAttachment.imageId),
      ),
    )
    .where(
      and(
        eq(orderMail.ledgerPartyId, ledgerPartyId),
        eq(orderMail.vendorId, vendorId),
        eq(orderMailEvent.orderId, orderId),
      ),
    );
  for (const attachment of attachments) {
    if (!attachment.imageId) continue;
    await tx
      .insert(entityAttachment)
      .values({
        entityId: purchaseId,
        entityKind: "purchase",
        role: "attachment",
        imageId: attachment.imageId,
        documentKind: attachment.filename.toLowerCase().includes("receipt")
          ? "receipt"
          : "invoice",
      })
      .onConflictDoNothing();
  }
}

const externalSource = (url: string | undefined, vendorId: string): string => {
  if (!url) return `vendor-${vendorId}`;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return (
    host
      .split(".")[0]
      ?.replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "vendor"
  );
};

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

const lineIdentifiers = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
) => [
  ...(line.sku
    ? [{ kind: PURCHASE_EXTERNAL_ID_KIND, externalId: line.sku }]
    : []),
  ...(amazonAsin(line.productUrl)
    ? [{ kind: "asin" as const, externalId: amazonAsin(line.productUrl)! }]
    : []),
];

/** The same vendor SKU in one order must resolve to one Product decision. */
export const lineExternalIdentity = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
  vendorId: string,
): string | null =>
  lineIdentifiers(line)[0]
    ? `${externalSource(line.productUrl, vendorId)}:${lineIdentifiers(line)[0]?.kind}:${lineIdentifiers(line)[0]?.externalId}`
    : null;

export type LineIdentityDecision = {
  productId: string | null;
  promote: boolean;
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

const productSearchPatterns = (title: string) =>
  title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .slice(0, 3)
    .map((token) => `%${token.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);

// The staged decision pipeline intentionally keeps all five model decisions and
// deterministic short-circuits in one ordered pass over each source line.
// eslint-disable-next-line complexity
async function decideLineIdentities(
  db: Database,
  input: ImportWriterInput,
): Promise<LineIdentityDecision[]> {
  const database = getDb(db);
  const decisions: LineIdentityDecision[] = [];
  const decisionsByExternalIdentity = new Map<string, LineIdentityDecision>();
  const candidate = input.extraction.candidate;
  if (!candidate) return [];
  const exactRequests = candidate.lines.map((line) =>
    lineIdentifiers(line).map((identifier) => ({
      ...identifier,
      source: externalSource(line.productUrl, input.vendorId),
    })),
  );
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
    if (lineKind !== "principal") {
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
    const identity = lineExternalIdentity(line, input.vendorId);
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
    const patterns = productSearchPatterns(line.title);
    const candidates = patterns.length
      ? await database
          .select({
            id: product.id,
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
          .orderBy(product.name)
          .limit(20)
      : [];
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
    if (line.lineKind !== "principal") {
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
) {
  const source = externalSource(line.productUrl, vendorId);
  const externalIdentity = lineExternalIdentity(line, vendorId);
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

async function writeClaim(
  tx: DrizzleTransaction,
  input: ImportWriterInput,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
  outputFingerprint: string,
) {
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  await tx
    .insert(importSourceClaim)
    .values({
      ledgerPartyId: partyId,
      vendorAccountId: input.vendorAccountId
        ? parseEntityId("vendorAccount", input.vendorAccountId)
        : null,
      kind: input.source.kind,
      externalKey: input.source.externalKey,
      checksum: input.source.checksum,
      purchaseId,
      firstRunId: input.runId,
      lastRunId: input.runId,
      outputFingerprint,
    })
    .onConflictDoUpdate({
      target: [
        importSourceClaim.ledgerPartyId,
        importSourceClaim.kind,
        importSourceClaim.externalKey,
      ],
      set: {
        checksum: input.source.checksum,
        purchaseId,
        lastRunId: input.runId,
        outputFingerprint,
        updatedAt: new Date(),
      },
    });
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
): Promise<ImportWriterOutput> {
  const input = importWriterInput.parse(rawInput);
  // Validation consumes this exact deterministic projection before any writer
  // side effect. Keep it on the mutation path so plan drift is explicit.
  const semanticPlan = buildPurchaseImportPlan(input.extraction);
  await assertRunCapabilityById(db, input.runId, "business_writer");
  await assertImportOwnership(db, input, actorUserId);
  const skipsLineWrites = semanticPlan.writeBlockReason !== null;
  const explicitResolutions = input.productResolutions;
  const identityDecisions = skipsLineWrites
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
    const existingClaim = await tx.query.importSourceClaim.findFirst({
      where: and(
        eq(importSourceClaim.ledgerPartyId, partyId),
        eq(importSourceClaim.kind, input.source.kind),
        eq(importSourceClaim.externalKey, input.source.externalKey),
      ),
    });
    if (
      input.targetPurchaseId &&
      existingClaim?.purchaseId &&
      input.targetPurchaseId !== existingClaim.purchaseId
    )
      throw new Error("This source already belongs to a different Purchase.");
    if (existingClaim && existingClaim.checksum === input.source.checksum) {
      await tx
        .update(importSourceClaim)
        .set({ lastRunId: input.runId })
        .where(eq(importSourceClaim.id, existingClaim.id));
      return importWriterOutput.parse({
        outcome: "replayed",
        purchaseId: existingClaim.purchaseId,
        findingIds: [],
        outputFingerprint: existingClaim.outputFingerprint,
      });
    }
    const isSourceRefresh = existingClaim !== undefined;

    const candidate = input.extraction.candidate;
    if (!candidate)
      throw new Error(
        "Unreadable imports require a typed candidate before writing",
      );
    const vendorId = parseEntityId("vendor", input.vendorId);
    const vendorAccountId = input.vendorAccountId
      ? parseEntityId("vendorAccount", input.vendorAccountId)
      : null;
    const ordered = await findPurchase(tx, vendorId, candidate.orderId);
    const selectedId = input.targetPurchaseId ?? existingClaim?.purchaseId;
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
        (chosen.orderId !== null && chosen.orderId !== candidate.orderId))
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
        date: orderedDate(candidate.orderedAt),
        statedTotal: candidate.printedGrandTotal,
      });
    } else if (!isSourceRefresh) {
      await tx
        .update(purchase)
        .set({
          orderId: target.orderId ?? candidate.orderId,
          vendorAccountId: target.vendorAccountId ?? vendorAccountId,
          defaultTrade: target.defaultTrade ?? input.defaultTrade,
          defaultProjectId:
            target.defaultProjectId ??
            (input.defaultProjectId
              ? parseEntityId("project", input.defaultProjectId)
              : null),
          runId: target.runId ?? input.runId,
          displayLabel: target.displayLabel ?? candidate.merchant,
          statedTotal: target.statedTotal ?? candidate.printedGrandTotal,
        })
        .where(eq(purchase.id, target.id));
    }
    const purchaseId = parseEntityId("purchase", target.id);
    const findingIds: string[] = [];
    let replacementExpenseId: string | null = null;
    const rowMutations: Array<{
      targetKind: "expense" | "product";
      targetId: string;
      mutationKind: "create" | "update" | "delete";
      fields: string[];
    }> = [];

    await attachEvidence(tx, purchaseId, input);
    await attachPendingMailEvidence(
      tx,
      purchaseId,
      partyId,
      vendorId,
      candidate.orderId,
    );

    const reviewReason =
      input.extraction.status === "needs_review"
        ? input.extraction.reason
        : null;
    const reviewDetail =
      input.extraction.status === "needs_review"
        ? input.extraction.detail
        : "Imported order requires review.";
    const lines = candidate.lines;
    if (reviewReason === "sum_mismatch" || reviewReason === "missing_total") {
      if (candidate.printedGrandTotal !== null) {
        const current = await existingExpenses(tx, purchaseId);
        if (current.length === 0) {
          const inserted = await insertWithShortcode(tx, "expense", {
            purchaseId,
            name: candidate.merchant ?? "Imported order",
            cost: candidate.printedGrandTotal,
            date: orderedDate(candidate.orderedAt),
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
          );
          const quantity = receiptProductQuantity(productId, line, identity);
          const inserted = await insertWithShortcode(tx, "expense", {
            purchaseId,
            name: line.title,
            notes: line.seller ? `Seller: ${line.seller}` : null,
            cost: line.amount,
            date: orderedDate(candidate.orderedAt),
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
          if (
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

    const classifiedLines = await tx.query.expense.findMany({
      where: and(eq(expense.purchaseId, purchaseId), notDeleted(expense)),
    });
    for (const line of classifiedLines)
      await validateExpenseInheritance(tx, line);

    if (candidate.allShipmentsDelivered === true) {
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
    await writeClaim(tx, input, purchaseId, claimFingerprint);
    const claim = await tx.query.importSourceClaim.findFirst({
      where: and(
        eq(
          importSourceClaim.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(importSourceClaim.kind, input.source.kind),
        eq(importSourceClaim.externalKey, input.source.externalKey),
      ),
    });
    if (!claim) throw new Error("Import source claim was not persisted");

    if (isSourceRefresh) {
      await tx
        .delete(purchasePaymentEvidence)
        .where(eq(purchasePaymentEvidence.sourceClaimId, claim.id));
    }
    for (const [evidenceIndex, payment] of candidate.payments.entries()) {
      await tx.insert(purchasePaymentEvidence).values({
        purchaseId,
        sourceClaimId: claim.id,
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
    if (replacementExpenseId) {
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
                identityDecisions,
                reviewedLineAttributions,
              ),
            },
            reviewedLineIdentities: identityDecisions,
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
