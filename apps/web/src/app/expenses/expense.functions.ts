import { expenseContract } from "~/contracts/expense.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const expense = defineOperationDomain(expenseContract, {
  chartData: { tags: [["expense", "chartData"]] },
  analytics: { tags: [["expense", "analytics"]] },
  monthlySummary: { tags: [["expense", "monthlySummary"]] },
  analyze: { tags: [["expense", "analyze"]] },
  facetCounts: { tags: [["expense", "facetCounts"]] },
  tradeAffinity: { tags: [["expense", "tradeAffinity"]] },
  chargeContext: { tags: [["expense", "chargeContext"]] },
  inventoryOwnershipContext: {
    tags: [["expense", "inventoryOwnershipContext"]],
  },
  confirmInventoryBeneficiary: { invalidates: ripple.expense },
});
