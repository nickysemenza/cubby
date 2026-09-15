import { z } from "zod";

export const costTypeValues = ["materials", "tools", "services"] as const;
export const costTypeSchema = z.enum(costTypeValues);
export type CostType = z.infer<typeof costTypeSchema>;

/**
 * The one place the signed-quantity rule is spelled out for callers. MCP
 * advertises this string verbatim, so an agent has no other way to learn that a
 * $0 line carries its direction in the sign — keep it explicit.
 */
export const PRODUCT_QUANTITY_DESCRIPTION =
  'Product units covered by this expense; fractional values are allowed (half a coil thrown away is -0.5). Null means the receipt does not establish quantity. Signed: money direction wins, so a positive-cost line is an acquisition of |qty| and a negative-cost line is an exit of |qty|. On a $0 line the sign IS the fact — a positive quantity is a free acquisition (promo pack, bundled accessory), a negative quantity is a discard/write-off. Zero is legal ONLY on a negative-cost line and means money came back but no unit left — a price concession with the item kept (Amazon "Account adjustment", a partial refund for shipping damage). Prefer 0 over null there: null says the count is unknown and gets reported as data-entry debt.';

/**
 * Product units — signed, fractional, and zero only where the cost is negative.
 * Fractional because the unit is the shelf's unit and `InventoryEntry.amount`
 * has always been divisible. The cross-field half cannot live on this scalar
 * schema (it has no view of `cost`), so `assertQuantitySignMatchesCost` owns
 * the command rule and the persisted-invariant registry audits stored rows.
 * This only rejects the value that is wrong regardless of cost.
 */
export const signedProductQuantity = z
  .number()
  .describe(PRODUCT_QUANTITY_DESCRIPTION);
