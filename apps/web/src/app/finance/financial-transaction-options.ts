import { match } from "ts-pattern";
/**
 * Fixed preset values for the Amount column filter.
 *
 * `credits` is `amountMax: 0`, mirroring the expense ledger's `credits` bucket:
 * a negative amount is a refund or an inbound payout, and both are real rows
 * here rather than data errors — see `purchaseSettlementKinds`, where `refund`
 * and `income` are validated negative by construction.
 *
 * There is no `has` / `none` half. Unlike `Expense.cost`, `amount` is NOT NULL,
 * so a presence filter over it could only ever be a no-op.
 */
/** Resolves the Amount column's selected preset into the server fields it owns. */
export function resolveAmountFilter(preset: string | undefined): {
  amountMin?: number;
  amountMax?: number;
} {
  return match(preset)
    .with("gte1000", () => ({ amountMin: 1000 }))
    .with("gte250", () => ({ amountMin: 250 }))
    .with("gte50", () => ({ amountMin: 50 }))
    .with("credits", () => ({ amountMax: 0 }))
    .otherwise(() => ({}));
}
