import { match } from "ts-pattern";
import { buildSelectOptions } from "~/lib/select-options";

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
const amountRangeValues = ["gte1000", "gte250", "gte50", "credits"] as const;
type AmountRangePreset = (typeof amountRangeValues)[number];

const amountRangeLabels: Record<AmountRangePreset, string> = {
  gte1000: "$1,000 and up",
  gte250: "$250 and up",
  gte50: "$50 and up",
  credits: "Credits (≤ $0)",
};

/** `{value,label}` options for the Amount column filter. */
export const amountRangeOptions = buildSelectOptions(
  amountRangeValues,
  amountRangeLabels,
);

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
