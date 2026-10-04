import { z } from "zod";

export const costTypeValues = ["materials", "tools", "services"] as const;
export const costTypeSchema = z.enum(costTypeValues);
export type CostType = z.infer<typeof costTypeSchema>;

export const COST_TYPE_LABELS = {
  materials: "Materials",
  tools: "Tools",
  services: "Services",
} as const satisfies Record<CostType, string>;

/**
 * The disposition capture (a sale, return, or write-off of a Product recorded
 * as an Expense): its editor copy and default cost type. Web's expense dialog
 * reads them from its `disposition` context and native's Record sale hero
 * action from `nativeHeroActionPlans`, so both clients open the same editor.
 */
export const EXPENSE_DISPOSITION_COST_TYPE =
  "tools" as const satisfies CostType;
export const EXPENSE_DISPOSITION_EDITOR = {
  title: "Record Sale or Disposal",
  description:
    "Enter a negative cost for a sale or return, or 0 with a negative quantity if it broke or was given away.",
} as const;

export const EXPENSE_DATE_REQUIRED_MESSAGE =
  "A date is required when the cost is known and not $0. Clear the cost (unknown), set it to $0, or enter a date.";

/**
 * The one date/cost rule, shared by the schema refine, the repo guard, the
 * editor, and mirrored by the `Expense_date_cost_check` DB CHECK. An absent date
 * is legal only where no dated spend is claimed: a free ($0) row or a row whose
 * cost is unknown (null — e.g. a historical acquisition). Any other known cost
 * needs the date it was spent.
 */
const unknownOrZeroCost = z.union([z.null(), z.undefined(), z.literal(0)]);
export const canClearExpenseDate = (cost: unknown): boolean =>
  unknownOrZeroCost.safeParse(cost).success;

export const hasValidExpenseDate = (expense: {
  cost: number | null;
  date: string | null;
}): boolean => expense.date !== null || canClearExpenseDate(expense.cost);

/**
 * The one place the signed-quantity rule is spelled out for callers. MCP
 * advertises this string verbatim, so an agent has no other way to learn that a
 * $0 line carries its direction in the sign — keep it explicit.
 */
export const PRODUCT_QUANTITY_DESCRIPTION =
  'Product units covered by this expense; fractional values are allowed (half a coil thrown away is -0.5). Null means the receipt does not establish quantity. Signed: money direction wins, so a positive-cost line is an acquisition of |qty| and a negative-cost line is an exit of |qty|. On a $0 line the sign IS the fact — a positive quantity is a free acquisition (promo pack, bundled accessory), a negative quantity is a discard/write-off. Zero is legal ONLY on a negative-cost line and means money came back but no unit left — a price concession with the item kept (Amazon "Account adjustment", a partial refund for shipping damage). Prefer 0 over null there: null says the count is unknown and gets reported as data-entry debt. A positive quantity with cost null and no date records a historical acquisition whose price and date are unknown; it counts toward expected quantity but is never a price sample and never creates stock.';

/**
 * Product units — signed, fractional, and zero only where the cost is negative.
 * Fractional because the unit is the shelf's unit and `InventoryEntry.amount`
 * has always been divisible; see `Expense.productQuantity` in schema.ts. See
 * `Expense.productQuantity` in schema.ts for the full ledger rule; the DB CHECK
 * enforces the same pairing. The cross-field half cannot live on this schema
 * (it has no view of `cost`), so `assertQuantitySignMatchesCost` owns it and is
 * what every write path actually calls — this only rejects the value that is
 * wrong regardless of cost.
 */
export const signedProductQuantity = z
  .number()
  .describe(PRODUCT_QUANTITY_DESCRIPTION);
