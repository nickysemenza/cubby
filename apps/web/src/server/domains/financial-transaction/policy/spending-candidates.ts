export type SpendingCandidateRead = {
  id: string;
  shortcode: string;
  displayLabel: string | null;
  date: string | null;
  vendorId: string | null;
  expenses: { costMinor: bigint | null; lineKind: string }[];
  payments: { amountMinor: bigint; chargedDate: string | null }[];
  settlements: {
    amountMinor: bigint;
    transactionAmountMinor: bigint;
    allocatedMinor: bigint;
    transactionDeleted: boolean;
    accountDeleted: boolean;
    status: string;
    ledgerTransferId: string | null;
    kind: string;
    reimbursement: boolean;
  }[];
};

/**
 * Reads: live Purchase id/shortcode/displayLabel/date/vendorId; live incurred
 * vendor Expense costMinor/lineKind; PurchasePaymentEvidence amountMinor/chargedAt;
 * live allocations amountMinor and their transaction amountMinor/status/kind/
 * deletedAt/ledgerTransferId/shortcode, account deletedAt, total live allocation
 * amountMinor and reimbursement Expense existence. Every search may be empty.
 */
export function decideSpendingCandidates(
  input: {
    date: string;
    amountMinor: bigint;
    refund: boolean;
    vendorId?: string;
    purchaseId?: string | null;
  },
  purchases: readonly SpendingCandidateRead[],
) {
  const gap = (date: string) =>
    Math.abs(Date.parse(date) - Date.parse(input.date)) / 86_400_000;
  return purchases
    .flatMap((row) => {
      const dated = row.payments.some(
        (payment) => payment.chargedDate !== null,
      );
      const exactPayment = row.payments.some(
        (payment) =>
          payment.amountMinor === input.amountMinor &&
          (payment.chargedDate ?? (!dated ? row.date : null)) !== null &&
          gap(payment.chargedDate ?? row.date!) <= 3,
      );
      const explicit = row.shortcode === input.purchaseId || exactPayment;
      const sameVendor = row.vendorId === input.vendorId;
      const nearby =
        sameVendor && !input.refund && row.date !== null && gap(row.date) <= 14;
      const refundOriginal =
        input.refund &&
        input.purchaseId !== null &&
        sameVendor &&
        row.date !== null &&
        row.date <= input.date &&
        gap(row.date) <= 14 &&
        row.expenses.some(
          (line) =>
            line.costMinor !== null &&
            line.costMinor < 0n &&
            line.lineKind === "principal",
        );
      const paid = row.settlements.filter(
        (payment) => payment.amountMinor > 0n,
      );
      const uncertain = paid.some(
        (payment) =>
          payment.transactionDeleted ||
          payment.accountDeleted ||
          ["void", "expected"].includes(payment.status) ||
          payment.ledgerTransferId !== null ||
          payment.transactionAmountMinor <= 0n ||
          payment.reimbursement ||
          !["purchase", "fee", "refund"].includes(payment.kind) ||
          payment.transactionAmountMinor !== payment.allocatedMinor,
      );
      const partlyPaid =
        row.expenses.length > 0 &&
        paid.length > 0 &&
        (row.expenses.some(
          (line) => line.costMinor === null || line.lineKind === "unclassified",
        ) ||
          uncertain ||
          row.expenses
            .filter(
              (line) =>
                line.costMinor !== null &&
                (line.costMinor >= 0n || line.lineKind !== "principal"),
            )
            .reduce((sum, line) => sum + (line.costMinor ?? 0n), 0n) >
            paid.reduce((sum, payment) => sum + payment.amountMinor, 0n));
      const undated =
        row.expenses.length > 0 &&
        row.payments.some(
          (payment) =>
            payment.chargedDate === null &&
            payment.amountMinor === input.amountMinor,
        );
      const original = explicit || nearby || refundOriginal;
      return original ||
        (sameVendor && !input.refund && (partlyPaid || undated))
        ? [
            {
              id: row.id,
              shortcode: row.shortcode,
              displayLabel: row.displayLabel,
              date: row.date,
              explicit,
              reviewOnly: !original,
            },
          ]
        : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export type CandidateSettlementFacts = {
  /** Remaining capacity for this charge; null when a line is unpriced or a settlement is uncertain. */
  availableMinor: bigint | null;
  paymentsMinor: readonly bigint[];
  /** Same-direction settlements by other charges, and whether each is provably another bank event. */
  otherSettlements: readonly { distinctEvent: boolean }[];
  /** A member identity decision names this candidate. */
  decided: boolean;
};

/**
 * Reads: each candidate's remaining capacity for this charge, retained payment
 * amounts, its settlements by other charges with their bank-event proof, and
 * whether a member decided its identity. A review-only candidate blocks only
 * while its capacity is unknown or open. A nearby candidate stops blocking
 * only when its capacity is exactly zero, no retained payment names this
 * amount, and every other settlement is provably another bank event: spent
 * capacity alone may be this same charge booked twice.
 */
export function blockingSpendingCandidates<
  T extends { id: string; explicit: boolean; reviewOnly: boolean },
>(
  input: { amountMinor: bigint; refund: boolean },
  candidates: readonly T[],
  facts: ReadonlyMap<string, CandidateSettlementFacts>,
): T[] {
  const abs = (value: bigint) => (value < 0n ? -value : value);
  return candidates.filter((candidate) => {
    const fact = facts.get(candidate.id);
    if (!fact || fact.decided || candidate.explicit) return true;
    if (candidate.reviewOnly)
      return fact.availableMinor === null || fact.availableMinor > 0n;
    return (
      input.refund ||
      fact.availableMinor !== 0n ||
      !fact.otherSettlements.length ||
      fact.otherSettlements.some((settlement) => !settlement.distinctEvent) ||
      fact.paymentsMinor.some(
        (amount) => abs(amount) === abs(input.amountMinor),
      )
    );
  });
}
