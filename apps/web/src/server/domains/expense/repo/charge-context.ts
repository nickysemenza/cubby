import {
  type expenseShortcode,
  parseEntityId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getExpenseByID } from "~/server/domains/expense/repo/crud";
import {
  getPurchaseExpenses,
  getPurchaseLinkIdentityByID,
} from "~/server/domains/purchase/repo/purchase";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

type ChargeContextInput = z.output<typeof expenseShortcode>;
const requirePurchase = (id: PurchaseId | null): PurchaseId => {
  if (id === null)
    throw new Error("Charge-context purchase branch received null");
  return id;
};

export const expenseChargeContextWorkflow = bindWorkflow(
  workflow<Database, ChargeContextInput>("expense.chargeContext")
    .call("resolveExpense", ({ context }, { input }) =>
      resolveOrThrow(context, "expense", input),
    )
    .call("loadExpense", ({ context }, { resolveExpense }) =>
      getExpenseByID(context, resolveExpense),
    )
    .call("resolvePurchase", async ({ context }, { loadExpense }) => {
      if (!loadExpense.purchaseId) return null;
      const id = await resolveLiveShortcode(
        context,
        loadExpense.purchaseId,
        "purchase",
      );
      return id === null ? null : parseEntityId("purchase", id);
    })
    .branch("purchaseAvailable", {
      when: async (_, { resolvePurchase }) => resolvePurchase !== null,
      whenTrue: (branch) =>
        branch
          .parallel("chargeReads", 2, {
            purchase: ({ context }, { input: { resolvePurchase } }) =>
              getPurchaseLinkIdentityByID(
                context,
                requirePurchase(resolvePurchase),
              ),
            lines: ({ context }, { input: { resolvePurchase } }) =>
              getPurchaseExpenses(context, requirePurchase(resolvePurchase)),
          })
          .output(({ input, chargeReads }) =>
            chargeReads.purchase
              ? {
                  purchase: chargeReads.purchase,
                  siblings: chargeReads.lines.filter(
                    (row) => row.id !== input.input,
                  ),
                }
              : null,
          ),
      whenFalse: (branch) => branch.output(() => null),
    })
    .output(({ purchaseAvailable }) => purchaseAvailable),
);
