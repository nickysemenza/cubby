import {
  financialTransactionSettlementViolation,
  allocationSumViolation,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
const sign = (value: bigint) => (value < 0n ? -1 : value > 0n ? 1 : 0);
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
  const sumViolation = allocationSumViolation(
    input.next.map((row) => row.amountMinor),
    input.transactionAmountMinor,
  );
  if (sumViolation) return sumViolation;
  return (
    financialTransactionSettlementViolation({
      linked: true,
      kind: input.kind,
      amount: sign(input.transactionAmountMinor),
    })?.message ?? null
  );
}
