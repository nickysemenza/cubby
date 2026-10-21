import type {
  FieldSuggestionsInput,
  enrichmentProposalPrecomputeInput,
  fieldSuggestionsBatchInput,
} from "@cubby/schemas/ai";
import {
  fieldSuggestionSchema,
  fieldSuggestionOutcomeSchema,
} from "@cubby/schemas/ai";
import { usesSavedFieldSuggestionContext } from "@cubby/schemas/field-suggestion";
import {
  parseEntityId,
  type IngredientId,
  type RunId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, exists, or, sql } from "drizzle-orm";
import { z } from "zod";

import { aiContract, aiStreamsContract } from "~/contracts/ai.contract";
import { settleDecisionWorkItems } from "~/server/ai/decision-model";
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
  rememberSavedAnswers,
  rememberSettledQuestions,
  savedAnswerKey,
  settledSignature,
} from "~/server/ai/field-suggest/settled-questions";
import {
  suggestFields,
  withFieldSuggestionBatch,
} from "~/server/ai/field-suggest/suggest-fields";
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
import type { AiSelectionUsage } from "~/server/ai/selection";
import { afterResponse } from "~/server/cf-env";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { applyFinanceCategorySuggestion } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";
import {
  pauseSuggestionSweep,
  resumeSuggestionSweep,
  startSuggestionSweep,
} from "~/server/domains/run/service/suggestion-sweep";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { fieldReviewIdentity } from "~/server/generic/assessment/repo/field-assessment-review";
import { latestSuggestionSweepStatus } from "~/server/generic/assessment/repo/suggestion-review";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";
import { implementSubscriptionDomain } from "~/server/operation-runtime/subscription-domain.server";
import {
  bindBulkWorkflow,
  bindCoordinatorStream,
  defineBulkWorkflow,
  defineCoordinatorStream,
  type BulkWorkflowSummary,
  workflow,
} from "~/server/workflows/runtime";

const log = createLogger("precomputeEnrichmentProposals");
const suggestionLog = createLogger("suggestFields");

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
  prepared?: {
    runId: RunId;
    manifest: Awaited<ReturnType<typeof producingAiManifest>>;
    recordId?: Awaited<ReturnType<typeof resolveOrThrow>>;
  },
) => {
  const runId =
    prepared?.runId ?? (await actorAiRun(context, { runKey: input.runKey }));
  const manifest =
    prepared?.manifest ?? (await producingAiManifest(context.db));
  const recordId = input.entityId
    ? (prepared?.recordId ??
      (await resolveOrThrow(context.db, input.entity, input.entityId)))
    : null;
  if (
    input.savedRecord === true &&
    recordId &&
    input.basisMode === "suggested" &&
    !input.decisionModel
  ) {
    const { scheduleSavedFieldQuestion } =
      await import("~/server/domains/run/service/ai-refresh");
    for (const field of input.targets)
      await scheduleSavedFieldQuestion(
        context.db,
        {
          kind: "field",
          entity: input.entity,
          recordId,
          field,
          assessmentIds: [],
        },
        { suggestPorts: ports },
      );
  }
  const captured = await withAiInputs(false, () =>
    suggestFields(context.db, runId, input, {
      ...ports,
      ...(input.decisionModel ? { decisionModel: input.decisionModel } : {}),
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
      id: assessment.id,
      evidence: sql<unknown>`CASE WHEN ${assessment.evidence} ? 'proposal'
        THEN jsonb_build_object('proposal', ${assessment.evidence}->'proposal')
        ELSE '{}'::jsonb END`,
      judgment: sql<unknown>`jsonb_build_object('outcome', ${assessment.judgment}->'outcome')`,
    };
    // A repeated question reuses its published assessment without opening the
    // locking transaction; the transaction below still rechecks under its lock.
    const [published] = await getDb(context.db)
      .select(publishedFields)
      .from(assessment)
      .where(eq(assessment.publicationKey, publicationKey))
      .limit(1);
    const prediction =
      published ??
      (await withTransactionDatabase(context.db, async (transactionDb) => {
        await getDb(transactionDb).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${publicationKey},0))`,
        );
        const [existing] = await getDb(transactionDb)
          .select(publishedFields)
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
      }));
    // One round trip for every review that withholds this answer: its own
    // rejection, a rejection of the same served evidence, or a member's miss
    // on a draft.
    const client = getDb(context.db);
    const withholding = [
      exists(
        client
          .select({ id: assessmentState.id })
          .from(assessmentState)
          .where(
            and(
              eq(assessmentState.id, prediction.id),
              eq(assessmentState.status, "rejected"),
            ),
          ),
      ),
      ...(reviewKey
        ? [
            exists(
              client
                .select({ id: assessmentState.id })
                .from(assessmentState)
                .where(
                  and(
                    eq(assessmentState.family, "field"),
                    eq(assessmentState.status, "rejected"),
                    sql`${assessmentState.data}->>'reviewKey' = ${reviewKey}`,
                  ),
                ),
            ),
          ]
        : []),
      ...(recordId === null
        ? [
            exists(
              client
                .select({ id: feedback.id })
                .from(feedback)
                .where(
                  and(
                    eq(feedback.assessmentId, prediction.id),
                    eq(feedback.authority, "member"),
                    eq(feedback.verdict, "wrong"),
                  ),
                ),
            ),
          ]
        : []),
    ];
    const withheldResult = await client.execute(
      sql`SELECT ${or(...withholding)} AS "withheld"`,
    );
    const [{ withheld }] = z
      .tuple([z.object({ withheld: z.boolean() })])
      .parse(withheldResult.rows);
    if (withheld) {
      output.suggestions[field] = null;
      if (output.outcomes)
        output.outcomes[field] = {
          ...outcome,
          assessmentId: prediction.id,
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
      ? { ...original.proposal, assessmentId: prediction.id }
      : null;
    if (output.outcomes)
      output.outcomes[field] =
        originalJudgment.outcome.kind === "evaluated"
          ? { ...originalJudgment.outcome, assessmentId: prediction.id }
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
  // A saved record's complete final answer becomes the preview its list row
  // shows while the next live ask revalidates it. Withheld answers are stored
  // too, so a review replaces the older preview rather than leaving it.
  const savedEntityId = input.savedRecord === true ? input.entityId : undefined;
  if (savedEntityId && !input.decisionModel) {
    const previews = await Promise.all(
      Object.entries(output.outcomes ?? {}).map(async ([field, outcome]) => ({
        key: await savedAnswerKey(
          { ...input, field, entityId: savedEntityId },
          manifest,
        ),
        preview: { suggestion: output.suggestions[field] ?? null, outcome },
      })),
    );
    if (previews.length)
      await afterResponse(
        rememberSavedAnswers(context.db, previews).catch((error) => {
          // SILENT: an unremembered preview only means the next visit waits
          // for its live ask.
          suggestionLog.error("failed to remember saved answer previews", {
            error,
          });
        }),
      );
  }
  return output;
};

/** A list's finite enrichment set shares setup, vocabularies and decision waves. */
export async function inferFieldAssessmentsBatch(
  context: Parameters<typeof inferFieldAssessments>[0],
  input: z.output<typeof fieldSuggestionsBatchInput>,
  ports?: Parameters<typeof suggestFields>[3],
) {
  const manifest = await producingAiManifest(context.db);
  const recordIds = new Map<
    string,
    Awaited<ReturnType<typeof resolveOrThrow>>
  >();
  for (const entity of new Set(input.items.map((item) => item.entity))) {
    const codes = input.items.flatMap((item) =>
      item.entity === entity && item.entityId ? [item.entityId] : [],
    );
    if (!codes.length) continue;
    const resolved = await resolveLiveShortcodes(
      context.db,
      [...new Set(codes)],
      entity,
    );
    for (const [code, id] of resolved) recordIds.set(code, id);
  }
  const runs = new Map<string | undefined, Promise<RunId>>();
  const usages = new Map<string, AiSelectionUsage>();
  const results = await withFieldSuggestionBatch(() =>
    settleDecisionWorkItems(input.items, async (item) => {
      let pendingRun = runs.get(item.runKey);
      if (!pendingRun) {
        pendingRun = actorAiRun(context, { runKey: item.runKey });
        runs.set(item.runKey, pendingRun);
      }
      const runId = await pendingRun;
      return inferFieldAssessments(
        context,
        item,
        {
          ...ports,
          usageFor: (operation) => {
            const key = JSON.stringify([runId, operation]);
            let usage = usages.get(key);
            if (!usage) {
              usage = {
                db: ports?.recordUsage === false ? undefined : context.db,
                runId,
                operation,
                cacheStatus: "none",
                force: ports?.force,
              };
              usages.set(key, usage);
            }
            return usage;
          },
        },
        {
          runId,
          manifest,
          recordId: item.entityId ? recordIds.get(item.entityId) : undefined,
        },
      );
    }),
  );
  return {
    results: results.map((result) =>
      result.status === "fulfilled"
        ? { ok: true as const, value: result.value }
        : {
            ok: false as const,
            message:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
    ),
  };
}

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
  settledSuggestionQuestions: (context, input) =>
    readSettledQuestions(context.db, input),
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
  suggestFieldsBatch: (context, input) =>
    inferFieldAssessmentsBatch(context, input),
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
