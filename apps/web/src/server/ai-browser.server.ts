import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { ensureRun } from "~/server/runs/ensure-run";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  approveDetectedInventoryItemWorkflow,
  backfillLocationDescriptionsWorkflow,
  describeLocationWorkflow,
  detectInventoryItemsWorkflow,
  identifyProductWorkflow,
  listAiUsageRecentWorkflow,
  precomputeEnrichmentProposalsWorkflow,
  suggestExternalIdKindWorkflow,
  suggestFieldsWorkflow,
  suggestIngredientMergeBatchWorkflow,
  suggestUsdaFoodBatchWorkflow,
  suggestUsdaFoodWorkflow,
  summarizeAiUsageWorkflow,
} from "~/server/workflows/ai.server";

/** AI reads are authoritative: suggestions must see the row just written. */
export const aiHandlers = implementOperationDomain(aiContract, {
  describeLocation: async (context, input) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return describeLocationWorkflow({ db: context.db, runId }, input);
  },
  detectInventoryItems: async (context, input) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return detectInventoryItemsWorkflow({ db: context.db, runId }, input);
  },
  approveDetectedInventoryItem: (context, input) =>
    approveDetectedInventoryItemWorkflow(context, input),
  identifyProduct: async (context, input) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return identifyProductWorkflow({ db: context.db, runId }, input);
  },
  suggestUsdaFood: suggestUsdaFoodWorkflow,
  suggestUsdaFoodBatch: suggestUsdaFoodBatchWorkflow,
  suggestIngredientMergeBatch: async (context, input) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return suggestIngredientMergeBatchWorkflow(
      { db: context.db, runId },
      input,
    );
  },
  suggestFields: (context, input) => suggestFieldsWorkflow(context, input),
  suggestExternalIdKind: (context, input) =>
    suggestExternalIdKindWorkflow(context, input),
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
