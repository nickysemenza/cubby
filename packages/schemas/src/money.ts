import { z } from "zod";

const CENT_EPSILON = 1e-7;

const isWholeCentAmount = (value: number): boolean =>
  Number.isFinite(value) &&
  Math.abs(value * 100 - Math.round(value * 100)) <= CENT_EPSILON;

export const wholeCentAmount = z
  .number()
  .finite()
  .refine(isWholeCentAmount, "amount must resolve to a whole cent");

// A dollar-denominated field (cost/price/total/spend/budget/valuation/…)
// follows the same read-vs-write split as `amount`/`positiveAmount` in
// codec.ts: write boundaries reject a negative dollar figure, read/output
// shapes stay unconstrained. Unlike `positiveAmount` (which requires a
// strictly-positive value), the write variant here is `.nonnegative()` — $0
// is a legitimate cost (a free sample, a $0 line item) — matching every
// existing `.nonnegative()` money write site in this package; it is named
// "positive" only to keep the read/write pair's naming parallel to
// `amount`/`positiveAmount`.
//
// - `money` / `moneyNullable`: read shapes.
// - `positiveMoney` / `positiveMoneyNullable`: write boundaries.
export const money = z.number();
export const moneyNullable = money.nullable();
export const positiveMoney = z.number().nonnegative();
export const positiveMoneyNullable = positiveMoney.nullable();
