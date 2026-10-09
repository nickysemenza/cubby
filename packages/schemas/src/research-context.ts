import { z } from "zod";
import { expenseOut } from "./generated/expense.gen";
import { purchaseOut } from "./generated/purchase.gen";
import { vendorOut } from "./generated/vendor.gen";
import { productShortcode } from "./identifier-fields";

/** Current records are investigation leads; only retained sources authorize writes. */
export const researchPurchaseContext = purchaseOut
  .pick({ orderId: true, date: true, statedTotal: true })
  .extend({
    purchaseRef: purchaseOut.shape.id,
    vendor: vendorOut
      .pick({ name: true, website: true })
      .extend({ vendorRef: vendorOut.shape.id }),
    lines: z
      .array(
        expenseOut
          .pick({ name: true, cost: true, productQuantity: true })
          .extend({ productRef: productShortcode.nullable() }),
      )
      .max(20),
  });

export const researchPurchaseContextBatch = z.object({
  purchases: z.array(researchPurchaseContext).max(50),
  incomplete: z
    .boolean()
    .describe(
      "The bounded context omits more Purchases or lines; it is not an exhaustive search.",
    ),
});
