import { productCategorySummary } from "./product-category-fields";
import { z } from "zod";
import { moneyNullable, positiveMoneyNullable } from "./money";

/** Cycle-safe Product field schemas used by generated contracts. */
export const productCategory = productCategorySummary;

export const productPricingOut = z.object({
  derivedPrice: moneyNullable,
  effectivePrice: moneyNullable,
  source: z.enum(["explicit", "derived", "none"]),
  knownExpenseCount: z.number().int().nonnegative(),
  unknownExpenseCount: z.number().int().nonnegative(),
  // Sum of acquisition quantities, which are fractional for by-weight lines.
  knownUnitCount: z.number().nonnegative(),
  partial: z.boolean(),
});

export { moneyNullable, positiveMoneyNullable };

/**
 * Whether a Product is used up (`consumable`) or kept and reused (`durable`).
 * Independent of `stockTracked`, the choice to count stock. Unset means
 * undecided; nothing penalizes it and it never rewrites existing Expenses —
 * it only informs project suggestions and worklist filters. Adding a value
 * widens the generated CHECK: ship the migration before the code.
 */
/** Shelf against ledger where both are comparable (product `quantityVarianceState`). */
export const productQuantityVarianceState = z.enum(["matched", "mismatched"]);
export const productKindValues = ["consumable", "durable"] as const;
export const productKindSchema = z.enum(productKindValues);
export type ProductKind = z.infer<typeof productKindSchema>;

export const PRODUCT_KIND_LABELS = {
  consumable: "Consumable",
  durable: "Durable",
} as const satisfies Record<ProductKind, string>;
