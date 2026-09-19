import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  approveDetectedInventoryItemWorkflow,
  backfillLocationDescriptionsWorkflow,
  describeLocationWorkflow,
  detectInventoryItemsWorkflow,
  identifyProductWorkflow,
  listAiUsageRecentWorkflow,
  precomputeEnrichmentProposalsWorkflow,
  suggestFieldsWorkflow,
  suggestIngredientMergeBatchWorkflow,
  suggestUsdaFoodBatchWorkflow,
  suggestUsdaFoodWorkflow,
  summarizeAiUsageWorkflow,
} from "~/server/workflows/ai.server";

/** AI reads are authoritative: suggestions must see the row just written. */
export const aiHandlers = implementOperationDomain(aiContract, {
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
  suggestFields: (context, input) => suggestFieldsWorkflow(context.db, input),
  usageRecent: {
    run: (context, input) => listAiUsageRecentWorkflow(context.db, input),
  },
  usageSummary: {
    run: (context, input) => summarizeAiUsageWorkflow(context.db, input),
  },
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreamsContract, {
  backfillLocationDescriptions: (context, _input, signal) =>
    backfillLocationDescriptionsWorkflow(context.db, signal),
  precomputeEnrichmentProposals: (context, input, signal) =>
    precomputeEnrichmentProposalsWorkflow(context, input, signal),
});
