import type {
  FieldSuggestionsInput,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import {
  fieldSuggestionSchema,
  fieldSuggestionOutcomeSchema,
} from "@cubby/schemas/ai";
import {
  parseEntityId,
  type IngredientId,
  type RunId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/refresh-policy";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { producingAiManifest } from "~/server/repo/ai-refresh";
import {
  listAiUsageFilterOptions,
  listRecentAiUsage,
  summarizeAiUsage,
} from "~/server/repo/ai-usage";
import { publishAssessment } from "~/server/repo/assessment";
import { getDb, withTransactionDatabase } from "~/server/repo/database-helpers";
import { fieldReviewIdentity } from "~/server/repo/field-assessment-review";
import { applyFinanceCategorySuggestion } from "~/server/repo/finance-suggestion-context";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  latestSuggestionSweepStatus,
  listSuggestions,
  suggestionCounts,
} from "~/server/repo/suggestion-review";
import { aiCallRunInput, ensureRun } from "~/server/runs/ensure-run";
import {
  pauseSuggestionSweep,
  resumeSuggestionSweep,
  startSuggestionSweep,
} from "~/server/runs/suggestion-sweep";
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

const log = createLogger("precomputeEnrichmentProposals");

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
export const inferFieldAssessments = async (
  context: Pick<AuthenticatedStartOperationContext, "db" | "actorContext">,
  input: FieldSuggestionsInput,
  ports?: Parameters<typeof suggestFields>[3],
) => {
  const runId = await actorAiRun(context, { runKey: input.runKey });
  const manifest = await producingAiManifest(context.db);
  const captured = await withAiInputs(false, () =>
    suggestFields(context.db, runId, input, {
      ...ports,
      ...(input.decisionModel ? { decisionModel: input.decisionModel } : {}),
    }),
  );
  const output = captured.result;
  const recordId = input.entityId
    ? await resolveOrThrow(context.db, input.entity, input.entityId)
    : null;
  for (const [field, outcome] of Object.entries(output.outcomes ?? {})) {
    if (outcome.kind !== "evaluated") continue;
    const suggestion = output.suggestions[field];
    const inputs = captured.inputs.filter(
      (value) => value.operation === `suggestFields.${input.entity}.${field}`,
    );
    const producer = inputs.at(-1);
    const dependencies = dependencyStamps(manifest, [
      ...fieldDependencyKeys(input.entity, field),
      ...inputs.map((call) => call.feature),
    ]);
    const reviewKey = await fieldReviewIdentity({
      entity: input.entity,
      recordId,
      field,
      currentValue: input.basis[field],
      proposal: suggestion,
      model: producer?.model ?? null,
      inputs,
      dependencies,
    });
    const fingerprint = await sha256Hex(
      JSON.stringify({
        basis: input.basis,
        inputs,
        field,
        dependencies,
        reviewKey,
      }),
    );
    const publicationKey = `field-inference:${input.entity}:${recordId}:${field}:${fingerprint}`;
    const prediction = await withTransactionDatabase(
      context.db,
      async (transactionDb) => {
        await getDb(transactionDb).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${publicationKey},0))`,
        );
        const [existing] = await getDb(transactionDb)
          .select()
          .from(assessment)
          .where(eq(assessment.publicationKey, publicationKey))
          .limit(1);
        if (existing) return existing;
        return publishAssessment(
          transactionDb,
          {
            publicationKey,
            family: "field",
            subject: {
              kind: "field",
              entity: input.entity,
              recordId,
              field,
              draft: !input.entityId,
            },
            judgment: z.json().parse({
              value: suggestion?.value ?? null,
              ...(suggestion
                ? {
                    operation: suggestion.operation,
                    removals: suggestion.removals,
                  }
                : {}),
              outcome,
            }),
            fingerprint,
            producer: producer
              ? {
                  kind: "model",
                  model: producer.model,
                  revision: producer.promptVersion,
                  runId,
                  evaluationId: null,
                }
              : null,
            evidence: z.json().parse({
              basis: input.basis,
              inputs,
              proposal: suggestion ?? null,
            }),
          },
          {
            runId,
            model: producer?.model ?? "unknown",
            suggestedValue: suggestion?.value ?? null,
            confidence: suggestion?.probability ?? outcome.probability ?? 0,
            financeReviewFingerprint:
              suggestion?.financeReview?.fingerprint ?? null,
            status: suggestion ? "pending" : "resolved",
            active: false,
            data: { reviewKey },
          },
        );
      },
    );
    const [state] = await getDb(context.db)
      .select({ status: assessmentState.status })
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .limit(1);
    const matchingWrong = reviewKey
      ? await getDb(context.db)
          .select({ id: assessmentState.id })
          .from(assessmentState)
          .where(
            and(
              eq(assessmentState.family, "field"),
              eq(assessmentState.status, "rejected"),
              sql`${assessmentState.data}->>'reviewKey' = ${reviewKey}`,
            ),
          )
          .limit(1)
      : [];
    const draftMiss =
      recordId === null
        ? await getDb(context.db)
            .select({ id: feedback.id })
            .from(feedback)
            .where(
              and(
                eq(feedback.assessmentId, prediction.id),
                eq(feedback.authority, "member"),
                eq(feedback.verdict, "wrong"),
              ),
            )
            .limit(1)
        : [];
    if (
      state?.status === "rejected" ||
      draftMiss.length ||
      matchingWrong.length
    ) {
      output.suggestions[field] = null;
      if (output.outcomes) delete output.outcomes[field];
      continue;
    }
    const original = z
      .object({ proposal: fieldSuggestionSchema.nullable() })
      .parse(prediction.evidence);
    const originalJudgment = z
      .object({ outcome: fieldSuggestionOutcomeSchema })
      .parse(prediction.judgment);
    output.suggestions[field] = original.proposal
      ? { ...original.proposal, assessmentId: prediction.id }
      : null;
    if (output.outcomes)
      output.outcomes[field] =
        originalJudgment.outcome.kind === "evaluated"
          ? { ...originalJudgment.outcome, assessmentId: prediction.id }
          : originalJudgment.outcome;
  }
  return output;
};

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
      input.imageIds,
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
  listSuggestionReviewQueue: (context, input) =>
    listSuggestions(context.db, input),
  suggestionCounts: (context, input) => suggestionCounts(context.db, input),
  decisionCatalog: async (context) => {
    const { decisionCatalog } = await import("~/server/ai/decision-catalog");
    return decisionCatalog(context.db);
  },
  startSuggestionSweep: (context, input) =>
    startSuggestionSweep(context.db, input, { context }),
  pauseSuggestionSweep: async (context, input) => {
    await pauseSuggestionSweep(context.db, parseEntityId("run", input.runId));
    return { paused: true as const };
  },
  resumeSuggestionSweep: async (context, input) => {
    const id = parseEntityId("run", input.runId);
    await resumeSuggestionSweep(context.db, id, { context });
    return { id };
  },
  latestSuggestionSweepStatus: (context) =>
    latestSuggestionSweepStatus(context.db),
  // Both presentations share the page run grouping and authoritative inference.
  suggestFields: (context, input) => inferFieldAssessments(context, input),
  suggestFieldsReview: async (context, input) => {
    const { suggestions, ...contextual } = await inferFieldAssessments(
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
  usageFilterOptions: (context) => listAiUsageFilterOptions(context.db),
  usageRecent: (context, input) => listRecentAiUsage(context.db, input),
  usageSummary: (context, input) => summarizeAiUsage(context.db, input.days),
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreamsContract, {
  backfillLocationDescriptions: (context, _input, signal) =>
    backfillLocationDescriptionsWorkflow(context.db, signal),
  precomputeEnrichmentProposals: (context, input, signal) =>
    precomputeEnrichmentProposalsWorkflow(context, input, signal),
});
