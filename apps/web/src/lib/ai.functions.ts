import type { enrichmentProposalPrecomputeInput } from "@cubby/schemas/ai";
import type { z } from "zod";

import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const ai = defineOperationDomain(aiContract, {
  describeLocation: { invalidates: ripple.location },
  detectInventoryItems: { invalidates: ripple.inventory },
  approveDetectedInventoryItem: { invalidates: ripple.inventory },
  identifyProduct: { invalidates: ripple.none },
  suggestUsdaFood: { invalidates: ripple.none },
  suggestUsdaFoodBatch: { invalidates: ripple.ingredient },
  suggestIngredientMergeBatch: { invalidates: ripple.ingredient },
  suggestFields: { tags: [["ai", "suggestFields"]], cache: "stable" },
  suggestExternalIdKind: {
    tags: [["ai", "suggestExternalIdKind"]],
    cache: "stable",
  },
  usageRecent: { tags: [["ai", "usage"]] },
  usageSummary: { tags: [["ai", "usage"]] },
});

export const aiStreams = defineOperationDomain(aiStreamsContract);
export const backfillLocationDescriptionsStream = (signal?: AbortSignal) =>
  aiStreams.backfillLocationDescriptions.open(undefined, { signal });
export const precomputeEnrichmentProposalsStream = (
  input: z.input<typeof enrichmentProposalPrecomputeInput>,
  signal?: AbortSignal,
) => aiStreams.precomputeEnrichmentProposals.open(input, { signal });
