/** Live Expense rows after provenance has identified costs carried by another line. */
export function bookingAction(input: {
  economicRole: string;
  transactionAmountMinor: bigint;
  expenses: readonly {
    costMinor: bigint | null;
    future: boolean;
    economicRole: string;
    lineKind: string;
    carriedElsewhere: boolean;
  }[];
  previouslySettledMinor: bigint;
}) {
  const vendorLines = input.expenses.filter(
    (line) =>
      !line.future && line.economicRole === "vendor" && !line.carriedElsewhere,
  );
  if (
    input.economicRole === "vendor" &&
    vendorLines.some((line) => line.costMinor === null)
  )
    return {
      kind: "refused" as const,
      reason:
        "Finish pricing the existing Expense lines before linking settlement.",
    };
  if (
    input.economicRole === "vendor" &&
    vendorLines.some((line) => line.lineKind === "unclassified")
  )
    return {
      kind: "refused" as const,
      reason:
        "Classify the unresolved receipt roles before linking settlement; their amounts may already cover this transaction.",
    };
  const negative = input.transactionAmountMinor < 0n;
  const bookedMinor = vendorLines
    .filter((line) =>
      negative
        ? line.costMinor !== null &&
          line.costMinor < 0n &&
          line.lineKind === "principal"
        : (line.costMinor ?? 0n) >= 0n || line.lineKind !== "principal",
    )
    .reduce((sum, line) => sum + (line.costMinor ?? 0n), 0n);
  const difference = bookedMinor - input.previouslySettledMinor;
  const remainingMinor = negative
    ? difference < 0n
      ? difference
      : 0n
    : difference > 0n
      ? difference
      : 0n;
  const remaining = remainingMinor < 0n ? -remainingMinor : remainingMinor;
  const amount = negative
    ? -input.transactionAmountMinor
    : input.transactionAmountMinor;
  if (input.economicRole === "vendor" && remaining > 0n && remaining < amount)
    return {
      kind: "refused" as const,
      reason:
        "Existing Expenses cover only part of this transaction. Review the remaining amount and individual lines before booking.",
    };
  return {
    kind: "ready" as const,
    action:
      input.economicRole === "vendor" && remaining >= amount
        ? "link_existing"
        : "create_aggregate",
    existingBookedMinor: bookedMinor,
    previouslySettledMinor: input.previouslySettledMinor,
    remainingBookedMinor: remainingMinor,
  };
}
