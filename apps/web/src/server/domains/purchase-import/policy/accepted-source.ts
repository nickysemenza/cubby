import type {
  importSourceOrder,
  importSourceProduct,
  purchasePaymentEvidence,
} from "~/server/db/retained-tables";

type PaymentRead = typeof purchasePaymentEvidence.$inferSelect;
type OriginalLineBindings = {
  sources: Pick<
    typeof importSourceOrder.$inferSelect,
    "id" | "originalOrder"
  >[];
  bindings: Pick<
    typeof importSourceProduct.$inferSelect,
    "lineIndex" | "expenseId" | "sourceOrderId"
  >[];
};
type AcceptedProductChoices = {
  bindings: { lineIndex: number; productId: string | null }[];
  identities: { id: string; mergedIntoId: string | null }[];
};
type TargetReviewFacts = {
  priorSourceOrder: { id: string } | undefined;
  retainedPayments: PaymentRead[];
};
type AcceptedPaymentFacts = {
  accepted: { extraction: ImportWriterInput["extraction"] } | null | undefined;
  retainedPayments: PaymentRead[];
};
import type {
  ExtractedOrderCandidate,
  ExtractedPaymentEvidence,
  ExtractedPurchaseLine,
  ImportWriterInput,
  PaymentTender,
} from "@cubby/schemas/purchase-import";
import { cents, minorToMoney } from "@cubby/shared";

import {
  decideLineWrite,
  importedLineMatchesExpense,
  originalItemFacts,
  sourceFinancialFacts,
  type ExistingExpenseSnapshot,
} from "~/server/domains/purchase-import/policy/import-lines";

export function planLineMatch(
  candidate: ExtractedOrderCandidate,
  current: ExistingExpenseSnapshot[],
  /** Lines are written without cost: a foreign receipt or an unpriced itemization. */
  unpriced: boolean,
  valuation: "USD" | "unknown",
  { sources, bindings }: OriginalLineBindings,
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
  { bindings, identities }: AcceptedProductChoices,
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
  { priorSourceOrder, retainedPayments }: TargetReviewFacts,
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

export function planAcceptedPaymentReview(
  candidate: ExtractedOrderCandidate,
  { accepted, retainedPayments }: AcceptedPaymentFacts,
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
  retained: PaymentRead[],
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
