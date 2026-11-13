import type { ImportWriterInput } from "@cubby/schemas/purchase-import";

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

/** Accepted extraction decides pricing and identity-only writes; foreign reversals carry no USD cost. */
export function importLineWritePolicy(
  extraction: ImportWriterInput["extraction"],
) {
  const semanticPlan = buildPurchaseImportPlan(extraction);

  const skipsLineWrites = semanticPlan.writeBlockReason !== null;
  const foreignReversal =
    extraction.candidate?.currency !== "USD" &&
    (extraction.candidate?.sourceEvent === "refunded" ||
      extraction.candidate?.sourceEvent === "cancelled" ||
      extraction.candidate?.lines.some(
        (line) =>
          line.lineKind === "principal" &&
          line.amount !== null &&
          line.amount < 0,
      ));
  const unpricedForeign =
    semanticPlan.writeBlockReason === "foreign_currency" &&
    /^[A-Z]{3}$/.test(extraction.candidate?.currency ?? "") &&
    !foreignReversal &&
    (extraction.status === "ready" ||
      (extraction.status === "needs_review" &&
        extraction.reason === "foreign_currency"));
  // A USD order with a printed total and unpriced items: the total books as
  // one aggregate Expense and the items as unpriced lines beside it.
  const unpricedItemization =
    semanticPlan.writeBlockReason === "unpriced_itemization";
  const unpriced = unpricedForeign || unpricedItemization;
  const writesLines = !skipsLineWrites || unpriced;
  const valuation: "unknown" | "USD" = unpriced ? "unknown" : "USD";
  const identityOnly =
    !unpricedForeign &&
    !foreignReversal &&
    [
      "missing_currency",
      "foreign_currency",
      "missing_date",
      "missing_total",
    ].includes(semanticPlan.writeBlockReason ?? "");
  return {
    semanticPlan,
    skipsLineWrites,
    foreignReversal,
    unpricedForeign,
    unpricedItemization,
    unpriced,
    writesLines,
    valuation,
    identityOnly,
  };
}
