import { ai } from "~/lib/ai.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  approveDetectedInventoryItemWorkflow,
  auditCategoriesWorkflow,
  describeLocationWorkflow,
  detectInventoryItemsWorkflow,
  identifyProductWorkflow,
  listAiUsageRecentWorkflow,
  parseSearchWorkflow,
  suggestCategoryWorkflow,
  suggestIngredientMergeBatchWorkflow,
  suggestLocationTypeWorkflow,
  suggestLocationWorkflow,
  suggestUsdaFoodBatchWorkflow,
  suggestUsdaFoodWorkflow,
  summarizeAiUsageWorkflow,
} from "~/server/workflows/ai.server";

/** AI reads are authoritative: suggestions must see the row just written. */
export const aiHandlers = implementOperationDomain(ai, {
  suggestCategory: {
    readPolicy: "strong",
    run: (context, input) => suggestCategoryWorkflow(context.db, input),
  },
  suggestLocationType: {
    readPolicy: "strong",
    run: (context, input) => suggestLocationTypeWorkflow(context.db, input),
  },
  suggestLocation: {
    readPolicy: "strong",
    run: (context, input) => suggestLocationWorkflow(context.db, input),
  },
  describeLocation: (context, input) =>
    describeLocationWorkflow(context.db, input),
  detectInventoryItems: (context, input) =>
    detectInventoryItemsWorkflow(context.db, input),
  approveDetectedInventoryItem: (context, input) =>
    approveDetectedInventoryItemWorkflow(context, input),
  identifyProduct: (context, input) =>
    identifyProductWorkflow(context.db, input),
  suggestUsdaFood: suggestUsdaFoodWorkflow,
  suggestUsdaFoodBatch: suggestUsdaFoodBatchWorkflow,
  suggestIngredientMergeBatch: (context, input) =>
    suggestIngredientMergeBatchWorkflow(context.db, input),
  parseSearch: (context, input) => parseSearchWorkflow(context.db, input),
  auditCategories: (context) => auditCategoriesWorkflow(context.db),
  usageRecent: {
    readPolicy: "strong",
    run: (context, input) => listAiUsageRecentWorkflow(context.db, input),
  },
  usageSummary: {
    readPolicy: "strong",
    run: (context, input) => summarizeAiUsageWorkflow(context.db, input),
  },
});
