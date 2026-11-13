import {
  detectedInventorySchema,
  detectedProductMatchSchema,
} from "@cubby/schemas/ai";
import type {
  FieldSuggestionsInput,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import {
  parseEntityId,
  type IngredientId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import {
  suggestIngredientMerge,
  suggestIngredientMergeBatch,
} from "~/server/ai/enrichment/ingredient-merge";
import {
  approveDetectedInventoryItem,
  describeLocation,
  detectInventoryItems,
  enqueueLocationDescriptionBackfill,
  selectLocationDescriptionBackfill,
} from "~/server/ai/enrichment/location-vision";
import type { EnrichmentProposal } from "~/server/ai/enrichment/proposals";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/ai/enrichment/usda-match";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { aiCallOwner, type AiCallOwner } from "~/server/ai/policy/call-owner";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import {
  listAiUsageFilterOptions,
  listRecentAiUsage,
  summarizeAiUsage,
} from "~/server/ai/repo/ai-usage";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { applyFinanceCategorySuggestion } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import {
  readAutomaticAiStop,
  resumeAutomaticAi,
  stopAutomaticAi,
} from "~/server/domains/run/repo/automatic-ai-stop";
import { publicFieldEnvelopeBatch } from "~/server/generic/derived/repo/public-read";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import type { AuthenticatedOperationContext } from "~/server/operation-runtime/operation.server";
import { implementSubscriptionDomain } from "~/server/operation-runtime/subscription-domain.server";
import { workflow } from "~/server/workflows/runtime/builder";
import {
  bindBulkWorkflow,
  defineBulkWorkflow,
  type BulkWorkflowSummary,
} from "~/server/workflows/runtime/bulk";
import {
  bindCoordinatorStream,
  defineCoordinatorStream,
} from "~/server/workflows/runtime/stream";

const log = createLogger("precomputeEnrichmentProposals");

type EnrichmentPrecomputeInput = z.output<
  typeof enrichmentProposalPrecomputeInput
>;
type EnrichmentPrecomputeItem = EnrichmentPrecomputeInput["items"][number] & {
  ingredientId: IngredientId;
  owner: AiCallOwner;
};
const skippedUsda: EnrichmentProposal["usda"] = {
  food: null,
  confidence: "low",
  reasoning: "",
};
const precomputeEnrichmentDefinition = defineBulkWorkflow({
  name: "ai.precomputeEnrichmentProposals",
  items: workflow<AuthenticatedOperationContext, EnrichmentPrecomputeInput>(
    "ai.precomputeEnrichmentProposals.items",
  )
    .call("resolved", async ({ context }, { input }) => {
      const owner = aiCallOwner(context.actorContext);
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
                owner,
              },
            ]
          : [];
      });
    })
    .output(({ resolved }) => resolved),
  item: workflow<AuthenticatedOperationContext, EnrichmentPrecomputeItem>(
    "ai.precomputeEnrichmentProposals.item",
  )
    .parallel("lookups", 2, {
      usda: async ({ context }, { input }) =>
        input.wantUsda
          ? suggestUsdaFood(context.usdaService, context.db, input.name, {
              ingredientId: input.ingredientId,
              owner: input.owner,
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
              input.owner,
            )
          : null,
    })
    .output(({ input, lookups }): EnrichmentProposal => ({
      id: input.id,
      usda: lookups.usda,
      merge: lookups.merge,
    })),
  finalize: workflow<
    AuthenticatedOperationContext,
    BulkWorkflowSummary<EnrichmentPrecomputeItem, EnrichmentProposal>
  >("ai.precomputeEnrichmentProposals.finalize").output(({ input }) => ({
    processed: input.succeeded.length + input.failed.length,
  })),
  onItemError: "continue",
  concurrency: 5,
  progress: (proposal) => proposal,
  errorProgress: (error, item) => {
    log.error(`${item.name} failed`, { error });
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
    context: AuthenticatedOperationContext,
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
export const inferFieldSuggestions = async (
  context: Pick<AuthenticatedOperationContext, "db" | "actorContext">,
  input: FieldSuggestionsInput,
  ports?: Parameters<typeof suggestFields>[3],
  prepared?: {
    manifest: Awaited<ReturnType<typeof producingAiManifest>>;
    recordId?: Awaited<ReturnType<typeof resolveOrThrow>>;
  },
) => {
  const owner = aiCallOwner(context.actorContext);
  const recordId = input.entityId
    ? (prepared?.recordId ??
      (await resolveOrThrow(context.db, input.entity, input.entityId)))
    : null;
  const captured = await withAiInputs(false, () =>
    suggestFields(context.db, owner, input, {
      ...ports,
      ...(recordId ? { recordId } : {}),
      ...(input.decisionModel ? { decisionModel: input.decisionModel } : {}),
      ...(input.precedents === false ? { precedents: false } : {}),
    }),
  );
  const output = captured.result;

  return output;
};

export const aiHandlers = implementOperationDomain(aiContract, {
  describeLocation: async (context, input) => {
    return describeLocation(
      context.db,
      await resolveOrThrow(context.db, "location", input.locationId),
      aiCallOwner(context.actorContext),
    );
  },
  detectInventoryItems: async (context, input) => {
    const detected = await detectInventoryItems(
      context.db,
      await resolveOrThrow(context.db, "location", input.locationId),
      aiCallOwner(context.actorContext),
      input.imageIds,
    );
    const matches = await publicFieldEnvelopeBatch({
      db: context.db,
      reads: detected.items.flatMap((item) =>
        item.matchedProduct
          ? [
              {
                entity: "product",
                schema: detectedProductMatchSchema,
                row: item.matchedProduct,
              },
            ]
          : [],
      ),
    });
    return {
      ...detectedInventorySchema.parse({
        ...detected,
        items: detected.items.map((item) => ({
          ...item,
          matchedProduct: item.matchedProduct ? matches.shift() : null,
        })),
      }),
      analyzedAt: detected.analyzedAt,
    };
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
      ...aiCallOwner(context.actorContext),
      operation: "identifyProduct",
      cacheStatus: "none",
    }),
  suggestUsdaFood: async (context, input) =>
    suggestUsdaFood(context.usdaService, context.db, input.ingredientName, {
      owner: aiCallOwner(context.actorContext),
    }),
  suggestUsdaFoodBatch: async (context, input) => {
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
      aiCallOwner(context.actorContext),
    );
  },
  suggestIngredientMergeBatch: async (context, input) => {
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
      aiCallOwner(context.actorContext),
    );
    return suggestions.map(({ source, target, ...suggestion }) => ({
      ...suggestion,
      source: { id: source.shortcode, name: source.name },
      target: target ? { id: target.shortcode, name: target.name } : null,
    }));
  },
  applyFinanceCategorySuggestion: (context, input) =>
    applyFinanceCategorySuggestion(context, input),
  decisionCatalog: async (context) => {
    const { decisionCatalog } = await import("~/server/ai/decision-catalog");
    return decisionCatalog(context.db);
  },
  automaticWork: async (context) => ({
    stoppedAt: (await readAutomaticAiStop(context.db))?.stoppedAt ?? null,
  }),
  stopAutomaticWork: (context) =>
    stopAutomaticAi(context.db, context.actorContext),
  resumeAutomaticWork: async (context) => {
    const resumed = await resumeAutomaticAi(context.db);
    const { wakeJobs } =
      await import("~/server/workflows/background-tasks/publish");
    await wakeJobs({ source: "automatic-ai-resume" });
    return resumed;
  },
  // Both presentations share the page run grouping and authoritative inference.
  suggestFields: (context, input) => inferFieldSuggestions(context, input),
  suggestExternalIdKind: async (context, input) =>
    suggestExternalIdKind(input, {
      db: context.db,
      ...aiCallOwner(context.actorContext),
      operation: "suggestExternalIdKind",
      cacheStatus: "none",
    }),
  usageFilterOptions: (context) => listAiUsageFilterOptions(context.db),
  usageRecent: async (context, input) => ({
    items: await listRecentAiUsage(context.db, input),
  }),
  usageSummary: async (context, input) => ({
    items: await summarizeAiUsage(context.db, input.days, input.groupBy),
  }),
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreamsContract, {
  backfillLocationDescriptions: (context, _input, signal) =>
    backfillLocationDescriptionsWorkflow(context.db, signal),
  precomputeEnrichmentProposals: (context, input, signal) =>
    precomputeEnrichmentProposalsWorkflow(context, input, signal),
});
