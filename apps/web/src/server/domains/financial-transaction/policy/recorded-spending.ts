export type CapacityRead = {
  lines: readonly {
    costMinor: bigint | null;
    lineKind: string;
    future: boolean;
    economicRole: string;
    bookingTransactionCode: string | null;
  }[];
  settlements: readonly {
    transactionId: string;
    transactionCode: string;
    amountMinor: bigint;
    transactionAmountMinor: bigint;
    allocatedMinor: bigint;
    deleted: boolean;
    accountDeleted: boolean;
    status: string;
    ledgerTransferId: string | null;
    kind: string;
  }[];
};
const sign = (value: bigint) => (value < 0n ? -1 : value > 0n ? 1 : 0);
/** Reads: all live incurred vendor Expense costs/roles and every linked allocation's transaction/account validity, total allocations and reimbursement provenance. */
export function availableSpendingMinor(
  graph: CapacityRead | undefined,
  amountMinor: bigint,
  currentId?: string,
) {
  if (!graph) return null;
  const lines = graph.lines.filter(
    (line) => !line.future && line.economicRole === "vendor",
  );
  if (
    !lines.length ||
    lines.some(
      (line) => line.costMinor === null || line.lineKind === "unclassified",
    )
  )
    return null;
  const matching = lines.filter(
    (line) =>
      line.costMinor !== null &&
      (amountMinor < 0n
        ? line.costMinor < 0n && line.lineKind === "principal"
        : line.costMinor >= 0n || line.lineKind !== "principal"),
  );
  const reimbursements = new Set(
    graph.lines
      .filter((line) => line.economicRole === "reimbursement")
      .map((line) => line.bookingTransactionCode),
  );
  const other = graph.settlements.filter(
    (entry) =>
      entry.transactionId !== currentId &&
      entry.kind !== "income" &&
      !reimbursements.has(entry.transactionCode) &&
      sign(entry.amountMinor) === sign(amountMinor),
  );
  if (
    other.some(
      (entry) =>
        entry.deleted ||
        entry.accountDeleted ||
        ["void", "expected"].includes(entry.status) ||
        entry.ledgerTransferId ||
        !["purchase", "fee", "refund"].includes(entry.kind) ||
        entry.allocatedMinor !== entry.transactionAmountMinor ||
        sign(entry.amountMinor) !== sign(entry.transactionAmountMinor),
    )
  )
    return null;
  return (
    matching.reduce((sum, line) => sum + (line.costMinor ?? 0n), 0n) -
    other.reduce((sum, entry) => sum + entry.amountMinor, 0n)
  );
}

/** Reads: every live allocation slice, each linked Purchase id/shortcode/capacity, and the stored/current booking lineage fingerprints; an empty set remains unbooked. */
export function recordedSpendingOutcome(input: {
  amountMinor: bigint;
  beneficiariesSpecified: boolean;
  lineageMatches: boolean;
  allocations: readonly { purchaseId: string; amountMinor: bigint }[];
  purchases: readonly {
    id: string;
    shortcode: string;
    availableMinor: bigint | null;
  }[];
}) {
  if (!input.allocations.length) return null;
  if (input.beneficiariesSpecified)
    return {
      kind: "review" as const,
      reason:
        "Beneficiaries apply only to a new aggregate Expense; preserve existing spending attribution.",
    };
  if (!input.lineageMatches)
    return {
      kind: "review" as const,
      reason: "The booking lineage changed; reconcile the existing Expenses.",
    };
  const complete =
    input.allocations.reduce((sum, row) => sum + row.amountMinor, 0n) ===
    input.amountMinor;
  const booked = input.purchases.every((purchase) => {
    const allocation = input.allocations.find(
      (row) => row.purchaseId === purchase.id,
    );
    return (
      allocation &&
      sign(allocation.amountMinor) === sign(input.amountMinor) &&
      purchase.availableMinor === allocation.amountMinor
    );
  });
  return complete && booked
    ? {
        kind: "booked" as const,
        purchaseIds: input.purchases.map((row) => row.shortcode),
      }
    : {
        kind: "review" as const,
        reason:
          "Existing allocations need reconciliation before booking more spending.",
      };
}
