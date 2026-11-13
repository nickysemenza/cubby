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
