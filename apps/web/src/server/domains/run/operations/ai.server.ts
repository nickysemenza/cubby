import {
  detectedInventorySchema,
  detectedProductMatchSchema,
} from "@cubby/schemas/ai";
import type {
  FieldSuggestionsInput,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import {
  fieldSuggestionSchema,
  fieldSuggestionOutcomeSchema,
} from "@cubby/schemas/ai";
import { usesSavedFieldSuggestionContext } from "@cubby/schemas/field-suggestion-policy";
import {
  parseEntityId,
  type IngredientId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, exists, or, sql } from "drizzle-orm";
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
import {
  fieldQuestionKey,
  isSettledOutcome,
  readSettledQuestions,
  rememberSettledQuestions,
  settledSignature,
} from "~/server/ai/field-suggest/settled-questions";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { aiCallOwner, type AiCallOwner } from "~/server/ai/policy/call-owner";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import {
  listAiUsageFilterOptions,
  listRecentAiUsage,
  summarizeAiUsage,
} from "~/server/ai/repo/ai-usage";
import { afterResponse } from "~/server/cf-env";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
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
import { fieldReviewIdentity } from "~/server/generic/suggestions/repo/field-suggestion-review";
import { memberRejectedSql } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { publishExactSuggestion } from "~/server/generic/suggestions/repo/suggestion-publication";
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
const suggestionLog = createLogger("suggestFields");

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
  const manifest =
    prepared?.manifest ?? (await producingAiManifest(context.db));
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
    const publishedFields = {
      id: suggestionTable.id,
      evidence: sql<unknown>`CASE WHEN ${suggestionTable.evidence} ? 'proposal'
        THEN jsonb_build_object('proposal', ${suggestionTable.evidence}->'proposal')
        ELSE '{}'::jsonb END`,
      judgment: sql<unknown>`jsonb_build_object('outcome', ${suggestionTable.judgment}->'outcome')`,
    };
    // A repeated question reuses its published suggestion without opening the
    // publication transaction, which still replays it under the key's lock.
    const [published] = await getDb(context.db)
      .select(publishedFields)
      .from(suggestionTable)
      .where(eq(suggestionTable.publicationKey, publicationKey))
      .limit(1);
    const prediction =
      published ??
      (await publishExactSuggestion(
        context.db,
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
                runId: owner.runId ?? null,
                evaluationId: null,
              }
            : null,
          evidence: z.json().parse({
            basis: input.basis,
            inputs,
            dependencies,
            proposal: suggestion ?? null,
          }),
        },
        {
          runId: owner.runId ?? null,
          model: producer?.model ?? "unknown",
          suggestedValue: suggestion?.value ?? null,
          confidence: suggestion?.probability ?? outcome.probability ?? 0,
          financeReviewFingerprint:
            suggestion?.financeReview?.fingerprint ?? null,
          status: suggestion ? "pending" : "resolved",
          active: false,
          data: { reviewKey },
        },
      ));
    // One round trip for every review that withholds this answer: its own
    // rejection, a rejection of the same served evidence, or a member's miss
    // on a draft.
    const client = getDb(context.db);
    const withholding = [
      exists(
        client
          .select({ id: suggestionTable.id })
          .from(suggestionTable)
          .where(
            and(
              eq(suggestionTable.id, prediction.id),
              eq(suggestionTable.status, "rejected"),
            ),
          ),
      ),
      ...(reviewKey
        ? [
            exists(
              client
                .select({ id: suggestionTable.id })
                .from(suggestionTable)
                .where(
                  and(
                    eq(suggestionTable.family, "field"),
                    eq(suggestionTable.status, "rejected"),
                    sql`${suggestionTable.data}->>'reviewKey' = ${reviewKey}`,
                  ),
                ),
            ),
          ]
        : []),
      ...(recordId === null
        ? [
            exists(
              client
                .select({ id: suggestionTable.id })
                .from(suggestionTable)
                .where(
                  and(
                    eq(suggestionTable.id, prediction.id),
                    memberRejectedSql(sql`${suggestionTable.decisions}`, {
                      dismissed: false,
                    }),
                  ),
                ),
            ),
          ]
        : []),
    ];
    const withheldResult = await client.execute(
      sql`SELECT ${or(...withholding)} AS "withheld"`,
      "objects",
    );
    const [{ withheld }] = z
      .tuple([z.object({ withheld: z.boolean() })])
      .parse(withheldResult);
    if (withheld) {
      output.suggestions[field] = null;
      if (output.outcomes)
        output.outcomes[field] = {
          ...outcome,
          suggestionId: prediction.id,
          reviewStatus: "rejected",
        };
      continue;
    }
    const original = z
      .object({ proposal: fieldSuggestionSchema.nullable() })
      .parse(prediction.evidence);
    const originalJudgment = z
      .object({ outcome: fieldSuggestionOutcomeSchema })
      .parse(prediction.judgment);
    output.suggestions[field] = original.proposal
      ? { ...original.proposal, suggestionId: prediction.id }
      : null;
    if (output.outcomes)
      output.outcomes[field] =
        originalJudgment.outcome.kind === "evaluated"
          ? { ...originalJudgment.outcome, suggestionId: prediction.id }
          : originalJudgment.outcome;
  }
  // A pinned model replays one record for grading; only live answers settle
  // a question. Dedicated saved finance/vendor context keeps its review
  // fingerprint instead. IDs used for canonical automation do not bypass
  // remembered declines. Everything else the answer read beyond the
  // basis is pinned by the input signature and rechecked on read.
  if (
    !input.decisionModel &&
    !(input.entityId && usesSavedFieldSuggestionContext(input.entity))
  ) {
    const settled = await Promise.all(
      Object.entries(output.outcomes ?? {})
        .filter(
          ([field, outcome]) =>
            output.suggestions[field] == null && isSettledOutcome(outcome),
        )
        .map(async ([field, outcome]) => ({
          key: await fieldQuestionKey({ ...input, field }, manifest),
          outcome,
          signature: await settledSignature(
            { entity: input.entity, field },
            outcome,
            captured.inputs,
          ),
        })),
    );
    if (settled.length)
      await afterResponse(
        rememberSettledQuestions(context.db, settled).catch((error) => {
          // SILENT: an unremembered decline is asked again on the next visit.
          suggestionLog.error("failed to remember settled questions", {
            error,
          });
        }),
      );
  }
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
  settledSuggestionQuestions: (context, input) =>
    readSettledQuestions(context.db, input),
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
    items: await summarizeAiUsage(context.db, input.days),
  }),
});

export const aiStreamHandlers = implementSubscriptionDomain(aiStreamsContract, {
  backfillLocationDescriptions: (context, _input, signal) =>
    backfillLocationDescriptionsWorkflow(context.db, signal),
  precomputeEnrichmentProposals: (context, input, signal) =>
    precomputeEnrichmentProposalsWorkflow(context, input, signal),
});
