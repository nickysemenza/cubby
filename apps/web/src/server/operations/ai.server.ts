import type {
  FieldSuggestionsInput,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import {
  parseEntityId,
  type IngredientId,
  type RunId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listRecentAiUsage, summarizeAiUsage } from "~/server/repo/ai-usage";
import { applyFinanceCategorySuggestion } from "~/server/repo/finance-suggestion-context";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { aiCallRunInput, ensureRun } from "~/server/runs/ensure-run";
import {
  suggestIngredientMerge,
  suggestIngredientMergeBatch,
} from "~/server/services/ai-enrichment/ingredient-merge";
import {
  approveDetectedInventoryItem,
  describeLocation,
  detectInventoryItems,
  enqueueLocationDescriptionBackfill,
  selectLocationDescriptionBackfill,
} from "~/server/services/ai-enrichment/location-vision";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment/proposals";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment/usda-match";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  bindBulkWorkflow,
  bindCoordinatorStream,
  defineBulkWorkflow,
  defineCoordinatorStream,
  type BulkWorkflowSummary,
  workflow,
} from "~/server/workflow-runtime";

/** The actor's AI run for the hour: every AI operation opens it once with
 * `ensureRun` before calling out. */
const actorAiRun = (
  context: Pick<AuthenticatedStartOperationContext, "db" | "actorContext">,
  options?: { runKey?: string },
) =>
  ensureRun(
    context.db,
    context.actorContext,
    aiCallRunInput(context.actorContext, options),
  );

type EnrichmentPrecomputeInput = z.output<
  typeof enrichmentProposalPrecomputeInput
>;
type EnrichmentPrecomputeItem = EnrichmentPrecomputeInput["items"][number] & {
  ingredientId: IngredientId;
  runId: RunId;
};
const skippedUsda: EnrichmentProposal["usda"] = {
  food: null,
  confidence: "low",
  reasoning: "",
};
const precomputeEnrichmentDefinition = defineBulkWorkflow({
  name: "ai.precomputeEnrichmentProposals",
  items: workflow<
    AuthenticatedStartOperationContext,
    EnrichmentPrecomputeInput
  >("ai.precomputeEnrichmentProposals.items")
    .call("resolved", async ({ context }, { input }) => {
      // One run for the whole precompute request, not one per item:
      // `resolved` runs once before the item stage fans out, so every
      // item's usda/merge lookup below carries the same run id.
      const runId = await ensureRun(
        context.db,
        context.actorContext,
        aiCallRunInput(context.actorContext),
      );
      const resolved = await resolveLiveShortcodes(
        context.db,
        input.items.map((item) => item.id),
        "ingredient",
      );
      return input.items.flatMap((item) => {
        const id = resolved.get(item.id);
        return id
          ? [
              {
                ...item,
                ingredientId: parseEntityId("ingredient", id),
                runId,
              },
            ]
          : [];
      });
    })
    .output(({ resolved }) => resolved),
  item: workflow<AuthenticatedStartOperationContext, EnrichmentPrecomputeItem>(
    "ai.precomputeEnrichmentProposals.item",
  )
    .parallel("lookups", 2, {
      usda: async ({ context }, { input }) =>
        input.wantUsda
          ? suggestUsdaFood(context.usdaService, context.db, input.name, {
              ingredientId: input.ingredientId,
              runId: input.runId,
            })
          : skippedUsda,
      merge: async ({ context }, { input }) =>
        input.wantMerge
          ? suggestIngredientMerge(
              context.db,
              {
                id: input.ingredientId,
                name: input.name,
              },
              input.runId,
            )
          : null,
    })
    .output(({ input, lookups }): EnrichmentProposal => ({
      id: input.id,
      usda: lookups.usda,
      merge: lookups.merge,
    })),
  finalize: workflow<
    AuthenticatedStartOperationContext,
    BulkWorkflowSummary<EnrichmentPrecomputeItem, EnrichmentProposal>
  >("ai.precomputeEnrichmentProposals.finalize").output(({ input }) => ({
    processed: input.succeeded.length + input.failed.length,
  })),
  onItemError: "continue",
  concurrency: 5,
  progress: (proposal) => proposal,
  errorProgress: (error, item) => {
    console.error(
      `[precomputeEnrichmentProposals] ${item.name} failed:`,
      error,
    );
    return {
      id: item.id,
      usda: {
        food: null,
        confidence: "low",
        reasoning: "Lookup failed.",
      },
      merge: null,
    } satisfies EnrichmentProposal;
  },
});
export const precomputeEnrichmentProposalsWorkflow = bindBulkWorkflow(
  precomputeEnrichmentDefinition,
  (
    context: AuthenticatedStartOperationContext,
    input: EnrichmentPrecomputeInput,
    signal: AbortSignal = new AbortController().signal,
  ) => ({ context, input, signal }),
);
const locationDescriptionBackfillDefinition = defineCoordinatorStream({
  name: "ai.backfillLocationDescriptions",
  select: workflow<Database, undefined>(
    "ai.backfillLocationDescriptions.select",
  )
    .call("locationIds", async ({ context }) =>
      selectLocationDescriptionBackfill(context),
    )
    .output(({ locationIds }) => locationIds),
  commit: workflow<
    Database,
    { readonly input: undefined; readonly selection: readonly LocationId[] }
  >("ai.backfillLocationDescriptions.enqueue")
    .commit("enqueued", async ({ context }, { input: { selection } }) =>
      enqueueLocationDescriptionBackfill(context, selection),
    )
    .output(({ enqueued }) => enqueued),
  total: (locationIds) => locationIds.length,
  completionProgress: (locationIds, result) => ({
    done: result.enqueued,
    total: locationIds.length,
  }),
});
export const backfillLocationDescriptionsWorkflow = bindCoordinatorStream(
  locationDescriptionBackfillDefinition,
  (db: Database, signal?: AbortSignal) => ({
    context: db,
    input: undefined,
    signal,
  }),
);
/** AI reads are authoritative: suggestions must see the row just written. */
const suggestionsForContext = async (
  context: AuthenticatedStartOperationContext,
  input: FieldSuggestionsInput,
) =>
  suggestFields(
    context.db,
    await actorAiRun(context, { runKey: input.runKey }),
    input,
  );

export const aiHandlers = implementOperationDomain(aiContract, {
  describeLocation: async (context, input) => {
    const runId = await actorAiRun(context);
    return describeLocation(
      context.db,
      await resolveOrThrow(context.db, "location", input.locationId),
      runId,
    );
  },
  detectInventoryItems: async (context, input) => {
    const runId = await actorAiRun(context);
    return detectInventoryItems(
      context.db,
      await resolveOrThrow(context.db, "location", input.locationId),
      runId,
    );
  },
  approveDetectedInventoryItem: async (context, input) =>
    approveDetectedInventoryItem(
      context.db,
      {
        ...input,
        locationId: await resolveOrThrow(
          context.db,
          "location",
          input.locationId,
        ),
      },
      context.actorContext,
    ),
  identifyProduct: async (context, input) =>
    getAiClient().identifyProduct(input.imageUrls, {
      db: context.db,
      runId: await actorAiRun(context),
      operation: "identifyProduct",
      cacheStatus: "none",
    }),
  suggestUsdaFood: async (context, input) =>
    suggestUsdaFood(context.usdaService, context.db, input.ingredientName, {
      runId: await actorAiRun(context),
    }),
  suggestUsdaFoodBatch: async (context, input) => {
    const runId = await actorAiRun(context);
    const ids = await resolveAllOrThrow(
      context.db,
      "ingredient",
      input.ingredients.map((item) => item.id),
    );
    return suggestUsdaFoodBatch(
      context.usdaService,
      context.db,
      input.ingredients.map((item, index) => ({
        id: ids[index]!,
        name: item.name,
      })),
      runId,
    );
  },
  suggestIngredientMergeBatch: async (context, input) => {
    const runId = await actorAiRun(context);
    const ids = await resolveAllOrThrow(
      context.db,
      "ingredient",
      input.ingredients.map((item) => item.id),
    );
    const suggestions = await suggestIngredientMergeBatch(
      context.db,
      input.ingredients.map((item, index) => ({
        id: ids[index]!,
        shortcode: item.id,
        name: item.name,
      })),
      runId,
    );
    return suggestions.map(({ source, target, ...suggestion }) => ({
      ...suggestion,
      source: { id: source.shortcode, name: source.name },
      target: target ? { id: target.shortcode, name: target.name } : null,
    }));
  },
  applyFinanceCategorySuggestion: (context, input) =>
    applyFinanceCategorySuggestion(context, input),
  // Both presentations share the page run grouping and authoritative inference.
  suggestFields: suggestionsForContext,
  suggestFieldsReview: async (context, input) => {
    const { suggestions, ...contextual } = await suggestionsForContext(
      context,
      input,
    );
    return {
      ...contextual,
      suggestions: Object.entries(suggestions).map(([field, suggestion]) => ({
        field,
        suggestion,
      })),
    };
  },
  suggestExternalIdKind: async (context, input) =>
    suggestExternalIdKind(input, {
      db: context.db,
      runId: await actorAiRun(context, { runKey: input.runKey }),
      operation: "suggestExternalIdKind",
      cacheStatus: "none",
    }),
  usageRecent: (context, input) => listRecentAiUsage(context.db, input.limit),
  usageSummary: (context, input) => summarizeAiUsage(context.db, input.days),
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreamsContract, {
  backfillLocationDescriptions: (context, _input, signal) =>
    backfillLocationDescriptionsWorkflow(context.db, signal),
  precomputeEnrichmentProposals: (context, input, signal) =>
    precomputeEnrichmentProposalsWorkflow(context, input, signal),
});
