import { ai, aiStreams } from "~/lib/ai.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  approveDetectedInventoryItemWorkflow,
  auditCategoriesWorkflow,
  backfillLocationDescriptionsWorkflow,
  describeLocationWorkflow,
  detectInventoryItemsWorkflow,
  identifyProductWorkflow,
  listAiUsageRecentWorkflow,
  parseSearchWorkflow,
  precomputeEnrichmentProposalsWorkflow,
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
    run: (context, input) => suggestCategoryWorkflow(context.db, input),
  },
  suggestLocationType: {
    run: (context, input) => suggestLocationTypeWorkflow(context.db, input),
  },
  suggestLocation: {
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
    run: (context, input) => listAiUsageRecentWorkflow(context.db, input),
  },
  usageSummary: {
    run: (context, input) => summarizeAiUsageWorkflow(context.db, input),
  },
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreams, {
  backfillLocationDescriptions: (context) =>
    backfillLocationDescriptionsWorkflow(context.db),
  precomputeEnrichmentProposals: (context, input) =>
    precomputeEnrichmentProposalsWorkflow(context, input),
});
