import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  ExtractedOrderCandidate,
  ExtractedPurchaseLine,
  ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { minorToMoney, moneyToMinor } from "@cubby/shared";

import { purchase } from "~/server/db/schema";

import { normalizeOrderKey } from "./order-identity";
import type {
  loadAcceptedProductChoices,
  loadAcceptedPaymentFacts,
  loadOriginalLineBindings,
  loadOrderedPurchases,
  loadTargetReviewFacts,
} from "./writer-load";
import {
  decideLineWrite,
  importedLineMatchesExpense,
  originalItemFacts,
  sourceFinancialFacts,
  type ExistingExpenseSnapshot,
} from "./writer-policy";

export function planLineMatch(
  candidate: ExtractedOrderCandidate,
  current: ExistingExpenseSnapshot[],
  unpricedForeign: boolean,
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
    unpricedForeign && current.length && !originalExpenses.size
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
      date: target.date ?? orderDate,
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

export function planOrderedPurchase(
  { matches, lined }: Awaited<ReturnType<typeof loadOrderedPurchases>>,
  targetPurchaseId: string | null | undefined,
) {
  if (matches.length > 1) {
    const reviewed = matches.find((row) => row.id === targetPurchaseId);
    if (reviewed && !lined.some((row) => row.purchaseId !== reviewed.id))
      return reviewed;
    throw new Error(
      `Several Purchases of this Vendor carry this order id (${matches.map((row) => row.shortcode).join(", ")}). Name one as targetPurchaseId, or converge them with purchase_import.converge_duplicate_source_order.`,
    );
  }
  return matches[0];
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
