import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  ExtractedOrderCandidate,
  ExtractedPaymentEvidence,
  ExtractedPurchaseLine,
  ImportWriterInput,
  PaymentTender,
} from "@cubby/schemas/purchase-import";
import { cents, minorToMoney, moneyToMinor } from "@cubby/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import { expense, purchase } from "~/server/db/schema";
import type {
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
} from "~/server/db/schema";
import { effectiveExpenseTradeSql } from "~/server/domains/expense/repo/expense-inheritance";
import { financialEvidenceAmountMinor } from "~/server/domains/financial-transaction/repo/financial-evidence";
import type { LiveSourceOrder } from "~/server/domains/purchase-import/repo/source-claim-family";
import { sourceOrderKey } from "~/server/domains/purchase-import/repo/source-order-key";
import {
  decideLineWrite,
  importedLineMatchesExpense,
  originalItemFacts,
  sourceFinancialFacts,
  type ExistingExpenseSnapshot,
} from "~/server/domains/purchase-import/repo/writer-policy";

import { normalizeOrderKey } from "./order-identity";
import type { ImportSourceAssociationInput } from "./writer";
import type { LineIdentityDecision } from "./writer-decisions";
import type { LineMutation } from "./writer-lines";
import type {
  loadAcceptedPaymentFacts,
  loadAcceptedProductChoices,
  loadOriginalLineBindings,
  loadRetainedTender,
  loadTargetReviewFacts,
} from "./writer-load";

export function planLineMatch(
  candidate: ExtractedOrderCandidate,
  current: ExistingExpenseSnapshot[],
  /** Lines are written without cost: a foreign receipt or an unpriced itemization. */
  unpriced: boolean,
  valuation: "USD" | "unknown",
  { sources, bindings }: Awaited<ReturnType<typeof loadOriginalLineBindings>>,
) {
  const originalExpenses = new Map<number, string>();
  for (const source of sources) {
    const prior = source.originalOrder?.extraction.candidate;
    const lines = bindings.filter((row) => row.sourceOrderId === source.id);
    if (
      !prior ||
      JSON.stringify(originalItemFacts(prior)) !==
        JSON.stringify(originalItemFacts(candidate)) ||
      lines.length !== candidate.lines.length ||
      lines.length !== current.length ||
      new Set(lines.map((row) => row.expenseId)).size !== lines.length ||
      lines.some(
        (row) =>
          !row.expenseId || !current.some((item) => item.id === row.expenseId),
      )
    )
      continue;
    for (const line of lines)
      originalExpenses.set(line.lineIndex, line.expenseId!);
    break;
  }
  const matchingExpenses = (line: ExtractedPurchaseLine, lineIndex: number) =>
    current.filter(
      (row) =>
        (!originalExpenses.size ||
          originalExpenses.get(lineIndex) === row.id) &&
        importedLineMatchesExpense(row, line, valuation),
    );
  const decision =
    unpriced && current.length && !originalExpenses.size
      ? { kind: "conflict" as const, reason: "duplicate_lines" as const }
      : decideLineWrite(current, candidate.lines, valuation);
  return { matchingExpenses, decision };
}

export function changedAcceptedProductChoice(
  candidate: ExtractedOrderCandidate,
  resolutions: NonNullable<ImportWriterInput["productResolutions"]>,
  accepted: ImportWriterInput["extraction"] | undefined,
  {
    bindings,
    identities,
  }: Awaited<ReturnType<typeof loadAcceptedProductChoices>>,
) {
  return resolutions.some((resolution) => {
    const line = candidate.lines[resolution.lineIndex];
    if (!line || line.lineKind !== "principal") return false;
    const original = bindings.find(
      (binding) => binding.lineIndex === resolution.lineIndex,
    )?.productId;
    return (
      (resolution.kind === "new" &&
        (!original ||
          JSON.stringify(line) !==
            JSON.stringify(
              accepted?.candidate?.lines[resolution.lineIndex],
            ))) ||
      resolution.kind === "unresolved" ||
      (resolution.kind === "expense_only" && !!original) ||
      (resolution.kind === "existing" &&
        (!original ||
          (original !== resolution.productId &&
            !identities.some(
              (identity) =>
                identity.id === original &&
                identity.mergedIntoId === resolution.productId,
            ))))
    );
  });
}

export function planTargetReview(
  candidate: ExtractedOrderCandidate,
  explicitResolutions: NonNullable<ImportWriterInput["productResolutions"]>,
  current: ExistingExpenseSnapshot[],
  unpricedForeign: boolean,
  { decision, matchingExpenses }: ReturnType<typeof planLineMatch>,
  {
    priorSourceOrder,
    retainedPayments,
  }: Awaited<ReturnType<typeof loadTargetReviewFacts>>,
) {
  const bindingNeedsReview =
    decision.kind === "no_op" &&
    explicitResolutions.some((resolution) => {
      if (resolution.kind !== "new" && resolution.kind !== "existing")
        return false;
      const line = candidate.lines[resolution.lineIndex];
      if (!line || line.lineKind !== "principal") return false;
      const matches = matchingExpenses(line, resolution.lineIndex);
      if (matches.length !== 1) return true;
      const row = matches[0]!;
      if (row.productId)
        return (
          resolution.kind === "new" || row.productId !== resolution.productId
        );
      return row.sourceClaimed || Boolean(priorSourceOrder);
    });
  const firstClaim = retainedPayments[0]?.sourceClaimId;
  const priorPaymentFacts = sourceFinancialFacts({
    ...candidate,
    payments: retainedPayments
      .filter((row) => row.sourceClaimId === firstClaim)
      .map((row) => ({
        amount: minorToMoney(row.amountMinor),
        chargedAt: row.chargedAt?.toISOString(),
        cardLastFour: row.cardLastFour ?? undefined,
      })),
  }).payments;
  const incompatiblePayments =
    !unpricedForeign &&
    candidate.payments.length > 0 &&
    retainedPayments.length > 0 &&
    JSON.stringify(priorPaymentFacts) !==
      JSON.stringify(sourceFinancialFacts(candidate).payments);
  const changedBinding = explicitResolutions.some(
    (resolution) =>
      resolution.kind === "existing" &&
      current.some(
        (row) =>
          row.title === candidate.lines[resolution.lineIndex]?.title &&
          row.productId &&
          row.productId !== resolution.productId,
      ),
  );
  return {
    recordCanonicalProductBindings: !priorSourceOrder,
    conflict:
      decision.kind === "conflict" ||
      decision.kind === "review_aggregate" ||
      incompatiblePayments ||
      changedBinding ||
      bindingNeedsReview,
  };
}

export function planPurchaseHeader(
  input: ImportWriterInput,
  candidate: ExtractedOrderCandidate,
  target: typeof purchase.$inferSelect | null | undefined,
  orderId: string | null,
  orderDate: string | null,
  assignedLine: boolean,
  /** The target is a lifecycle notice's empty Purchase, dated by the notice. */
  replacesNoticeDate = false,
) {
  const vendorId = parseEntityId("vendor", input.vendorId);
  const vendorAccountId = input.vendorAccountId
    ? parseEntityId("vendorAccount", input.vendorAccountId)
    : null;
  const total =
    candidate.currency === "USD" && candidate.printedGrandTotal !== null
      ? moneyToMinor(candidate.printedGrandTotal)
      : null;
  const projectId = input.defaultProjectId
    ? parseEntityId("project", input.defaultProjectId)
    : null;
  if (!target)
    return {
      kind: "create" as const,
      values: {
        vendorId,
        vendorAccountId,
        defaultTrade: input.defaultTrade,
        defaultProjectId: projectId,
        runId: input.runId,
        orderId,
        displayLabel: candidate.merchant,
        date: orderDate,
        statedTotal: total,
      },
    };
  const canFillTrade =
    target.defaultTrade === null &&
    target.defaultProjectId === null &&
    input.defaultTrade !== undefined;
  return {
    kind: "update" as const,
    target,
    values: {
      orderId: target.orderId ?? orderId,
      date: replacesNoticeDate ? orderDate : (target.date ?? orderDate),
      vendorAccountId: target.vendorAccountId ?? vendorAccountId,
      defaultTrade:
        target.defaultTrade ??
        (canFillTrade && !assignedLine ? input.defaultTrade : null),
      defaultProjectId: target.defaultProjectId ?? projectId,
      runId: target.runId ?? input.runId,
      displayLabel: target.displayLabel ?? candidate.merchant,
      statedTotal: target.statedTotal ?? total,
    },
  };
}

export function planPurchaseTarget(
  input: ImportWriterInput,
  orderId: string | null,
  chosen: typeof purchase.$inferSelect | undefined,
  ordered: typeof purchase.$inferSelect | undefined,
) {
  if (input.targetPurchaseId && !chosen)
    throw new Error("The reviewed Purchase target no longer exists.");
  if (
    chosen &&
    (chosen.vendorId !== parseEntityId("vendor", input.vendorId) ||
      (chosen.orderId !== null &&
        !(
          orderId !== null &&
          normalizeOrderKey(chosen.orderId) === normalizeOrderKey(orderId)
        ) &&
        !(orderId === null && input.targetPurchaseId)))
  )
    throw new Error(
      "The reviewed Purchase target has a different vendor or order identity.",
    );
  if (chosen && ordered && chosen.id !== ordered.id)
    throw new Error(
      "Another Purchase already owns this vendor order. Review the two Purchases before importing.",
    );
  return chosen ?? ordered;
}

export function planLockedPurchase(
  target: typeof purchase.$inferSelect,
  locked: typeof purchase.$inferSelect | undefined,
) {
  if (
    !locked ||
    locked.vendorId !== target.vendorId ||
    locked.orderId !== target.orderId
  )
    throw new Error("The reviewed Purchase target changed during import.");
  return locked;
}

export function planAcceptedPaymentReview(
  candidate: ExtractedOrderCandidate,
  {
    accepted,
    retainedPayments,
  }: Awaited<ReturnType<typeof loadAcceptedPaymentFacts>>,
) {
  const acceptedCandidate = accepted?.extraction.candidate;
  const proposedFacts = sourceFinancialFacts(candidate);
  const acceptedFacts = acceptedCandidate
    ? sourceFinancialFacts(acceptedCandidate)
    : null;
  const retainedFacts = sourceFinancialFacts({
    ...candidate,
    payments: retainedPayments.map((payment) => ({
      amount: minorToMoney(payment.amountMinor),
      chargedAt: payment.chargedAt?.toISOString(),
      cardLastFour: payment.cardLastFour ?? undefined,
    })),
  });
  return (
    !acceptedFacts ||
    JSON.stringify(acceptedFacts) !== JSON.stringify(proposedFacts) ||
    (candidate.currency === "USD" &&
      JSON.stringify(retainedFacts.payments) !==
        JSON.stringify(proposedFacts.payments))
  );
}

export function planSourceIdentity(
  input: ImportWriterInput,
  partyId: typeof ledgerParty.$inferSelect.id,
) {
  return {
    ledgerPartyId: partyId,
    vendorAccountId: input.vendorAccountId
      ? parseEntityId("vendorAccount", input.vendorAccountId)
      : null,
    kind: input.source.kind,
    externalKey: input.source.externalKey,
    checksum: input.source.checksum,
    firstRunId: input.runId,
    lastRunId: input.runId,
  };
}

export function planSourceKey(input: ImportWriterInput) {
  const candidate = input.extraction.candidate;
  if (!candidate)
    throw new Error(
      "Unreadable imports require a typed candidate before writing",
    );
  return {
    candidate,
    orderKey: sourceOrderKey({
      vendorId: input.vendorId,
      orderId: candidate.orderId,
      orderLocator: input.orderLocator,
    }),
  };
}

export function planSourceOrder(
  input: ImportWriterInput,
  orderKey: string,
  existingOrder: LiveSourceOrder | null | undefined,
) {
  if (
    input.targetPurchaseId &&
    existingOrder &&
    input.targetPurchaseId !== existingOrder.purchaseId
  )
    throw new Error(
      "This source order already belongs to a different Purchase.",
    );
  return existingOrder?.orderKey ?? orderKey;
}

export function planPaymentEvidence(
  candidate: ExtractedOrderCandidate,
  purchaseId: typeof purchase.$inferSelect.id,
  sourceClaimId: typeof importSourceClaim.$inferSelect.id,
) {
  return candidate.currency === "USD"
    ? candidate.payments.map((payment, evidenceIndex) => ({
        purchaseId,
        sourceClaimId,
        amountMinor: financialEvidenceAmountMinor(payment.amount),
        chargedAt: payment.chargedAt ? new Date(payment.chargedAt) : null,
        cardLastFour: payment.cardLastFour,
        tender: payment.tender ?? ("unknown" as const),
        description: payment.description,
        evidenceIndex,
      }))
    : [];
}

export function receiptProductQuantity(
  productId: string | null,
  line: ExtractedPurchaseLine,
  decision: Pick<LineIdentityDecision, "reversalKind">,
): number | null {
  if (!productId || line.quantity === undefined) return null;
  // An unpriced item line is an acquisition; only a printed negative reverses.
  if (line.amount === null || line.amount >= 0) return Math.abs(line.quantity);
  if (decision.reversalKind === "return") return -Math.abs(line.quantity);
  return decision.reversalKind === "concession" ? 0 : null;
}

export function planImportedExpense(
  purchaseId: typeof purchase.$inferSelect.id,
  line: ExtractedPurchaseLine,
  identity: LineIdentityDecision,
  productId: string | null,
  orderDate: string | null,
  unpriced: boolean,
) {
  const parsedProductId = productId
    ? parseEntityId("product", productId)
    : null;
  return {
    values: {
      purchaseId,
      name: line.title,
      notes: line.seller ? `Seller: ${line.seller}` : null,
      url: line.productUrl ?? null,
      cost: unpriced ? null : line.amount,
      date: orderDate,
      lineKind: identity.lineKind,
      lineBasis: "item_line" as const,
      costType:
        line.costType ??
        (identity.expenseOnly && identity.lineKind === "principal"
          ? ("services" as const)
          : ("materials" as const)),
      trade: null,
      economicRole: "vendor" as const,
      productId: parsedProductId,
      productQuantity: receiptProductQuantity(parsedProductId, line, identity),
    },
    fields: [
      "name",
      "cost",
      "lineKind",
      "productId",
      "productQuantity",
      "purchaseId",
      ...(line.productUrl ? ["url"] : []),
    ],
  };
}

function planExpenseProductBinding(
  row: ExistingExpenseSnapshot,
  line: ExtractedPurchaseLine,
  identity: LineIdentityDecision,
  productId: string,
) {
  return row.productId
    ? null
    : {
        id: parseEntityId("expense", row.id),
        values: {
          productId: parseEntityId("product", productId),
          productQuantity:
            row.productQuantity ??
            receiptProductQuantity(productId, line, identity),
        },
      };
}

export type LineFinding = {
  kind:
    | "product_unresolved"
    | "variant_doubt"
    | "kit_double_booked"
    | "reversal_kind";
  summary: string;
};

export function planIdentityFindings(
  line: ExtractedPurchaseLine,
  identity: LineIdentityDecision,
): LineFinding[] {
  const findings: LineFinding[] = [];
  if (identity.unresolvedReason)
    findings.push({
      kind: "product_unresolved",
      summary: `Product resolution is required for “${line.title}”: ${identity.unresolvedReason}`,
    });
  if (identity.variantDoubt)
    findings.push({
      kind: "variant_doubt",
      summary: `The existing match for “${line.title}” does not establish its exact ordered variant. Review the distinct Product before merging.`,
    });
  return findings;
}

export function planInsertedFindings(
  line: ExtractedPurchaseLine,
  identity: LineIdentityDecision,
): LineFinding[] {
  const findings: LineFinding[] = [];
  if (identity.unresolvedReason && identity.lineKind === "principal")
    findings.push({
      kind: "product_unresolved",
      summary: `Product resolution is required for “${line.title}”: ${identity.unresolvedReason}`,
    });
  if (identity.variantDoubt)
    findings.push({
      kind: "variant_doubt",
      summary: `Created a distinct product for “${line.title}” because the closest existing match was uncertain (${Math.round(identity.probability * 100)}%).`,
    });
  if (identity.kitKind === "kit_with_components")
    findings.push({
      kind: "kit_double_booked",
      summary: `“${line.title}” appears to be a kit. Review its component accounting before receiving inventory.`,
    });
  if (
    identity.lineKind === "principal" &&
    line.amount !== null &&
    line.amount < 0 &&
    identity.reversalKind !== "return" &&
    identity.reversalKind !== "concession"
  )
    findings.push({
      kind: "reversal_kind",
      summary: `“${line.title}” was classified as ${identity.reversalKind ?? "an uncertain reversal"}; no inventory quantity was inferred.`,
    });
  return findings;
}

export function planLineMode(
  input: ImportWriterInput,
  candidate: ExtractedOrderCandidate,
  identityOnly: boolean,
  unpricedForeign: boolean,
  decision: ReturnType<typeof planLineMatch>["decision"],
) {
  const reason =
    input.extraction.status === "needs_review" ? input.extraction.reason : null;
  const detail =
    input.extraction.status === "needs_review"
      ? input.extraction.detail
      : "Imported order requires review.";
  if (identityOnly) return { kind: "identity" as const };
  const lineWrite =
    decision.kind === "no_op"
      ? ("no_op" as const)
      : decision.kind === "insert"
        ? ("insert" as const)
        : ("none" as const);
  // The printed total books as one aggregate beside unpriced item lines; the
  // missing item prices are expected evidence, not a review finding.
  if (reason === "unpriced_itemization")
    return { kind: "unpriced_itemization" as const, lines: lineWrite };
  if (reason === "sum_mismatch" || reason === "missing_total")
    return { kind: "aggregate" as const, detail };
  if (
    !unpricedForeign &&
    (reason === "foreign_currency" || candidate.currency !== "USD")
  )
    return {
      kind: "foreign" as const,
      detail:
        input.extraction.status === "needs_review"
          ? input.extraction.detail
          : `Order uses ${candidate.currency}; no expense lines were written.`,
    };
  return { kind: lineWrite };
}

export function planAggregateExpense(
  purchaseId: typeof purchase.$inferSelect.id,
  candidate: ExtractedOrderCandidate,
  orderDate: string | null,
  current: ExistingExpenseSnapshot[],
) {
  if (candidate.printedGrandTotal === null || current.length) return null;
  return {
    purchaseId,
    name: candidate.merchant ?? "Imported order",
    cost: candidate.printedGrandTotal,
    date: orderDate,
    lineKind: "principal" as const,
    lineBasis: "allocation" as const,
    costType: "materials" as const,
    trade: null,
  };
}

export function planFallbackExpenses(expenseIds: readonly string[]) {
  const ids = requested(
    expenseIds.map((id) => ({
      entity: "expense",
      id: parseEntityId("expense", id),
    })),
  );
  return {
    where: and(
      ids.match({ entity: "expense", id: sql`${expense.id}` }),
      eq(expense.lineKind, "principal"),
      isNull(effectiveExpenseTradeSql()),
      notDeleted(expense),
    ),
  };
}

export function planPurchaseNote(
  purchaseId: typeof purchase.$inferSelect.id,
  fallbackAt: string | null,
  messageId: string | undefined,
  used: boolean,
) {
  return used && fallbackAt && messageId !== undefined
    ? {
        purchaseId,
        research: `Order date defaults to email receipt time (${fallbackAt}); no printed order date was supplied.\nhttps://mail.google.com/mail/u/0/#all/${messageId}`,
      }
    : null;
}

export function planLineAction(
  mode: "identity" | "no_op" | "insert",
  line: ExtractedPurchaseLine,
  lineIndex: number,
  identityDecisions: LineIdentityDecision[],
  lineMatch: ReturnType<typeof planLineMatch>,
) {
  const identity =
    identityDecisions[lineIndex] ??
    (mode === "insert"
      ? {
          productId: null,
          promote: false,
          variantDoubt: false,
          unresolvedReason: null,
          probability: 0,
          lineKind: line.lineKind,
          kitKind: "single" as const,
          reversalKind: null,
        }
      : undefined);
  if (!identity || (mode !== "insert" && identity.lineKind !== "principal"))
    return { kind: "skip" as const };
  if (mode === "no_op" && identity.unresolvedReason) {
    const matches = lineMatch.matchingExpenses(line, lineIndex);
    return {
      kind: "unresolved" as const,
      expenseId:
        matches.length === 1 && matches[0]
          ? parseEntityId("expense", matches[0].id)
          : null,
      finding: {
        kind: "product_unresolved" as const,
        summary: `Product resolution is required for “${line.title}”: ${identity.unresolvedReason}`,
      },
    };
  }
  if (mode === "no_op" && !identity.productId && !identity.promote)
    return { kind: "skip" as const };
  return { kind: "resolve" as const, identity };
}

export function planResolvedNoOp(
  line: ExtractedPurchaseLine,
  lineIndex: number,
  identity: LineIdentityDecision,
  productId: string,
  lineMatch: ReturnType<typeof planLineMatch>,
) {
  const matches = lineMatch.matchingExpenses(line, lineIndex);
  const row = matches[0];
  if (matches.length !== 1 || !row)
    throw new Error("Reviewed item Expense binding changed during import.");
  return {
    row,
    binding: planExpenseProductBinding(row, line, identity, productId),
  };
}

export function planRunWrites(
  purchaseId: typeof purchase.$inferSelect.id,
  created: boolean,
  usedFallbackNote: boolean,
  mutations: LineMutation[],
) {
  return [
    {
      entityKind: "purchase" as const,
      entityId: purchaseId,
      action: created ? ("create" as const) : ("update" as const),
      fields: [
        "header",
        "documents",
        "expenses",
        "paymentEvidence",
        ...(usedFallbackNote ? ["notes"] : []),
      ],
    },
    ...mutations.map(({ targetKind, targetId, mutationKind, fields }) => ({
      entityKind: targetKind,
      entityId: targetId,
      action:
        mutationKind === "create" ? ("create" as const) : ("update" as const),
      fields,
    })),
  ];
}

export function planFinancialProjection(
  candidate: ExtractedOrderCandidate,
  accepted: ImportWriterInput["extraction"] | undefined,
) {
  return accepted?.candidate
    ? JSON.stringify(sourceFinancialFacts(accepted.candidate)) ===
        JSON.stringify(sourceFinancialFacts(candidate))
    : true;
}

const tenderFactKey = (payment: {
  amount: number;
  chargedAt: string | null;
  cardLastFour: string | null;
}) =>
  `${cents(payment.amount)}|${payment.chargedAt ?? ""}|${payment.cardLastFour ?? ""}`;

export function planLearnedTender(
  proposed: readonly ExtractedPaymentEvidence[],
) {
  const learned = new Map<string, PaymentTender | null>();
  for (const payment of proposed) {
    const tender = payment.tender ?? "unknown";
    const key = tenderFactKey({
      amount: payment.amount,
      chargedAt: payment.chargedAt
        ? new Date(payment.chargedAt).toISOString()
        : null,
      cardLastFour: payment.cardLastFour ?? null,
    });
    const prior = learned.get(key);
    learned.set(key, prior === undefined || prior === tender ? tender : null);
  }
  return [...learned.values()].some((tender) => tender && tender !== "unknown")
    ? learned
    : null;
}

export function planTenderUpdates(
  learned: NonNullable<ReturnType<typeof planLearnedTender>>,
  retained: Awaited<ReturnType<typeof loadRetainedTender>>,
) {
  return retained.flatMap((row) => {
    if (row.tender !== "unknown") return [];
    const tender = learned.get(
      tenderFactKey({
        amount: minorToMoney(row.amountMinor),
        chargedAt: row.chargedAt?.toISOString() ?? null,
        cardLastFour: row.cardLastFour,
      }),
    );
    return !tender || tender === "unknown" ? [] : [{ id: row.id, tender }];
  });
}

export function planAttachments(
  purchaseId: typeof purchase.$inferSelect.id,
  input: ImportWriterInput,
) {
  return [
    input.primaryDocumentImageId
      ? {
          entityId: purchaseId,
          entityKind: "purchase" as const,
          role: "attachment" as const,
          imageId: input.primaryDocumentImageId,
          documentKind: "order_confirmation" as const,
        }
      : null,
    input.screenshotImageId
      ? {
          entityId: purchaseId,
          entityKind: "purchase" as const,
          role: "attachment" as const,
          imageId: input.screenshotImageId,
          documentKind: "other" as const,
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
}

export function planSourceAssociation(
  input: ImportSourceAssociationInput,
  purchaseId: typeof purchase.$inferSelect.id,
  outputFingerprint: string,
  orderKey: string,
  rootId: typeof importSourceClaim.$inferSelect.id,
  existing: LiveSourceOrder | null | undefined,
  updatedAt: Date,
) {
  if (existing && existing.purchaseId !== purchaseId)
    throw new Error(
      "This source order already belongs to a different Purchase.",
    );
  const ownerId = existing?.sourceClaimId ?? rootId;
  const key = existing?.orderKey ?? orderKey;
  return {
    ownerId,
    orderKey: key,
    values: {
      sourceClaimId: ownerId,
      orderKey: key,
      purchaseId,
      checksum: input.source.checksum,
      outputFingerprint,
      originalOrder: input.originalOrder ?? null,
    },
    set: {
      purchaseId,
      checksum: input.source.checksum,
      outputFingerprint,
      originalOrder: existing
        ? existing.originalOrder
        : (input.originalOrder ?? null),
      ...(existing ? {} : { acceptedObservationId: null }),
      updatedAt,
    },
  };
}

export function planOriginalBindings(
  sourceOrderId: typeof importSourceOrder.$inferSelect.id,
  input: ImportSourceAssociationInput,
) {
  if (!input.originalOrder || !input.productBindings?.length) return [];
  for (const binding of input.productBindings)
    if (!input.originalOrder.extraction.candidate?.lines[binding.lineIndex])
      throw new Error(
        "Import Product binding does not name an original order line.",
      );
  return input.productBindings.map((binding) => ({
    sourceOrderId,
    lineIndex: binding.lineIndex,
    productId: binding.productId,
    expenseId: binding.expenseId,
  }));
}
