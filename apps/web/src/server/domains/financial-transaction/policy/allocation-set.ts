import {
  financialTransactionSettlementViolation,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
const sign = (value: bigint) => (value < 0n ? -1 : value > 0n ? 1 : 0);
const dollars = (value: bigint) =>
  `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, "0")}`;
/** Reads: FinancialTransaction amountMinor/kind and the entire proposed allocation purchaseId/amountMinor set, including an empty set. */
export function allocationSetViolation(input: {
  transactionAmountMinor: bigint;
  kind: FinancialTransactionKind;
  next: readonly { purchaseId: string; amountMinor: bigint }[];
}): string | null {
  if (
    new Set(input.next.map((row) => row.purchaseId)).size !== input.next.length
  )
    return "A transaction cannot allocate to the same Purchase twice; combine them into one slice.";
  for (const row of input.next) {
    if (row.amountMinor === 0n)
      return "An allocation of zero says nothing — remove it instead.";
    if (sign(row.amountMinor) !== sign(input.transactionAmountMinor))
      return "Every allocation must carry the same sign as its transaction. A charge and a credit are two settlement events; record them as two transactions.";
  }
  if (!input.next.length) return null;
  const total = input.next.reduce((sum, row) => sum + row.amountMinor, 0n);
  if (total !== input.transactionAmountMinor)
    return `Allocations must sum to the transaction amount: got ${dollars(total)}, expected ${dollars(input.transactionAmountMinor)}.`;
  return (
    financialTransactionSettlementViolation({
      linked: true,
      kind: input.kind,
      amount: sign(input.transactionAmountMinor),
    })?.message ?? null
  );
}
