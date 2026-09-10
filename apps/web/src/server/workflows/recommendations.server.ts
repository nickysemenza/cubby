import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type {
  dismissDuplicateProductRecommendationInput,
  dismissProductRecommendationInput,
  dismissTagPropagationInput,
  duplicateProductRecommendationInput,
  placementRecommendationInput,
  recommendationWorkbenchInput,
  tagPropagationRecommendationInput,
} from "@cubby/schemas/recommendations";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { findDuplicateProductIdentities } from "~/server/repo/problems";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  dismissSuggestion,
  getActiveSuggestionDismissalKeys,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";
import {
  placementRecommendationWorkflowDefinition,
  productionPlacementRecommendationPorts,
} from "~/server/services/placement-recommendation.service";
import {
  getProductRelatedness,
  productRelatednessWorkflowDefinition,
  productTagPropagationWorkflowDefinition,
  productionRelatednessDependencies,
  getProductTagPropagation,
} from "~/server/services/relatedness.service";
import { bindWorkflow } from "~/server/workflow-runtime";
import {
  callStep,
  committedCallStep,
  parallelStep,
  defineWorkflow,
  defineWorkflowFunction,
  workflowValue,
  workflowInput,
} from "~/server/workflow-runtime/definition";

export const getProductRelatednessWorkflow = bindWorkflow(
  productRelatednessWorkflowDefinition,
  (db: Database, input: ProductShortcode) => ({
    context: { db, dependencies: productionRelatednessDependencies },
    input,
  }),
);
export const getPlacementRecommendationWorkflow = bindWorkflow(
  placementRecommendationWorkflowDefinition,
  (db: Database, input: z.output<typeof placementRecommendationInput>) => ({
    context: { db, ports: productionPlacementRecommendationPorts },
    input,
  }),
);
export const getProductRecommendationWorkflow = bindWorkflow(
  { ...productRelatednessWorkflowDefinition, name: "recommendations.product" },
  (db: Database, input: z.output<typeof recommendationWorkbenchInput>) => ({
    context: { db, dependencies: productionRelatednessDependencies },
    input: input.sourceId,
  }),
);
const findDuplicateCandidates = defineWorkflowFunction<
  Database,
  void,
  Awaited<ReturnType<typeof findDuplicateProductIdentities>>
>("recommendations.duplicate.find", async ({ context }) =>
  findDuplicateProductIdentities(context),
);
const duplicateCandidatesStep = callStep({
  name: "find",
  fn: findDuplicateCandidates,
  input: workflowValue(["$input"], () => undefined),
});
const resolveDuplicateRecommendation = defineWorkflowFunction<
  Database,
  {
    input: z.output<typeof duplicateProductRecommendationInput>;
    candidates: Awaited<ReturnType<typeof findDuplicateProductIdentities>>;
  },
  Awaited<ReturnType<typeof findDuplicateProductIdentities>>[number] | null
>("recommendations.duplicate.resolve", async ({ context }, value) => {
  const { input, candidates } = value;
  const candidate =
    candidates.find((item) =>
      item.products.some((product) => product.id === input.sourceId),
    ) ?? null;
  if (!candidate) return null;
  const sourceEntityId = await resolveOrThrow(
    context,
    "product",
    input.sourceId,
  );
  const dismissals = await getActiveSuggestionDismissalKeys(context, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.duplicate",
  });
  const candidateKey = await suggestionCandidateKey(
    "product.duplicate",
    candidate.products.map((product) => product.id).sort(),
  );
  return dismissals.has(candidateKey) ? null : candidate;
});
const duplicateResolveStep = callStep({
  name: "resolve",
  fn: resolveDuplicateRecommendation,
  input: workflowValue<
    z.output<typeof duplicateProductRecommendationInput>,
    Parameters<typeof resolveDuplicateRecommendation.run>[1]
  >(["$input", "find"], (state) => ({
    input: state.input,
    candidates: duplicateCandidatesStep.output.resolve(state),
  })),
});
export const getDuplicateProductRecommendationWorkflow = bindWorkflow(
  defineWorkflow({
    name: "recommendations.duplicate",
    steps: [duplicateCandidatesStep, duplicateResolveStep],
    output: duplicateResolveStep.output,
  }),
  (
    db: Database,
    input: z.output<typeof duplicateProductRecommendationInput>,
  ) => ({ context: db, input }),
);
type DuplicateDismissInput = z.output<
  typeof dismissDuplicateProductRecommendationInput
>;
type DuplicateCandidates = Awaited<
  ReturnType<typeof findDuplicateProductIdentities>
>;
type DuplicateDismissal = Parameters<typeof dismissSuggestion>[1];
const duplicateSourceId = defineWorkflowFunction<
  Database,
  DuplicateDismissInput,
  string
>("recommendations.duplicate.resolveSource", async ({ context }, input) =>
  resolveOrThrow(context, "product", input.sourceId),
);
const duplicateSourceStep = callStep({
  name: "resolve",
  fn: duplicateSourceId,
  input: workflowInput<DuplicateDismissInput>(),
});
const duplicateCandidatesForDismiss = defineWorkflowFunction<
  Database,
  DuplicateDismissInput,
  DuplicateCandidates
>("recommendations.duplicate.findForDismiss", async ({ context }) =>
  findDuplicateProductIdentities(context),
);
const duplicateCandidateStep = callStep({
  name: "find",
  fn: duplicateCandidatesForDismiss,
  input: workflowInput<DuplicateDismissInput>(),
});
const duplicateParallelStep = parallelStep({
  name: "load",
  input: workflowInput<DuplicateDismissInput>(),
  concurrency: 2,
  branches: {
    source: defineWorkflow({
      name: "source",
      steps: [duplicateSourceStep],
      output: duplicateSourceStep.output,
    }),
    candidates: defineWorkflow({
      name: "candidates",
      steps: [duplicateCandidateStep],
      output: duplicateCandidateStep.output,
    }),
  },
});
const duplicateValidate = defineWorkflowFunction<
  Database,
  {
    sourceEntityId: string;
    candidates: DuplicateCandidates;
    input: DuplicateDismissInput;
  },
  DuplicateDismissal
>(
  "recommendations.duplicate.validate",
  async (_, { sourceEntityId, candidates, input }) => {
    const candidate = candidates.find((item) =>
      item.products.some((product) => product.id === input.sourceId),
    );
    if (!candidate)
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "Duplicate recommendation is no longer current",
      );
    return {
      sourceEntityType: "product",
      sourceEntityId,
      suggestionKind: "product.duplicate",
      candidateKey: await suggestionCandidateKey(
        "product.duplicate",
        candidate.products.map((product) => product.id).sort(),
      ),
    };
  },
);
const duplicateValidateStep = callStep({
  name: "validate",
  fn: duplicateValidate,
  input: workflowValue<
    DuplicateDismissInput,
    {
      sourceEntityId: string;
      candidates: DuplicateCandidates;
      input: DuplicateDismissInput;
    }
  >(["$input", "load"], (state) => {
    const loaded = duplicateParallelStep.output.resolve(state);
    return {
      input: state.input,
      sourceEntityId: loaded.source,
      candidates: loaded.candidates,
    };
  }),
});
const duplicateDismiss = defineWorkflowFunction<
  Database,
  DuplicateDismissal,
  { ok: true }
>("recommendations.duplicate.dismiss", async ({ context }, input) => {
  await dismissSuggestion(context, input);
  return { ok: true };
});
const duplicateDismissStep = committedCallStep({
  name: "dismiss",
  fn: duplicateDismiss,
  input: duplicateValidateStep.output,
});
export const dismissDuplicateProductRecommendationWorkflow = bindWorkflow(
  defineWorkflow({
    name: "recommendations.duplicate.dismiss",
    steps: [duplicateParallelStep, duplicateValidateStep, duplicateDismissStep],
    output: duplicateDismissStep.output,
  }),
  (db: Database, input: DuplicateDismissInput) => ({ context: db, input }),
);
export const getTagPropagationRecommendationWorkflow = bindWorkflow(
  productTagPropagationWorkflowDefinition,
  (
    db: Database,
    input: z.output<typeof tagPropagationRecommendationInput>,
  ) => ({
    context: { db, dependencies: productionRelatednessDependencies },
    input: input.sourceId,
  }),
);
const readTagDismissal = defineWorkflowFunction<
  Database,
  z.output<typeof dismissTagPropagationInput>,
  {
    sourceEntityId: string;
    current: Awaited<ReturnType<typeof getProductTagPropagation>>;
    input: z.output<typeof dismissTagPropagationInput>;
  }
>("recommendations.tagPropagation.read", async ({ context }, input) => ({
  sourceEntityId: await resolveOrThrow(context, "product", input.sourceId),
  current: await getProductTagPropagation(context, input.sourceId),
  input,
}));
const tagReadStep = callStep({
  name: "read",
  fn: readTagDismissal,
  input: workflowInput<z.output<typeof dismissTagPropagationInput>>(),
});
const dismissTag = defineWorkflowFunction<
  Database,
  Awaited<ReturnType<typeof readTagDismissal.run>>,
  { ok: true }
>("recommendations.tagPropagation.dismiss", async ({ context }, value) => {
  const { sourceEntityId, current, input } = value;
  if (!current.proposals.some((proposal) => proposal.tag === input.tag))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Tag recommendation is no longer current",
    );
  await dismissSuggestion(context, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.tag-propagation",
    candidateKey: await suggestionCandidateKey("product.tag-propagation", [
      input.tag,
    ]),
  });
  return { ok: true as const };
});
const tagDismissStep = committedCallStep({
  name: "dismiss",
  fn: dismissTag,
  input: tagReadStep.output,
});
export const dismissTagPropagationWorkflow = bindWorkflow(
  defineWorkflow({
    name: "recommendations.tagPropagation.dismiss",
    steps: [tagReadStep, tagDismissStep],
    output: tagDismissStep.output,
  }),
  (db: Database, input: z.output<typeof dismissTagPropagationInput>) => ({
    context: db,
    input,
  }),
);
const readProductDismissal = defineWorkflowFunction<
  Database,
  z.output<typeof dismissProductRecommendationInput>,
  {
    sourceEntityId: string;
    current: Awaited<ReturnType<typeof getProductRelatedness>>;
    input: z.output<typeof dismissProductRecommendationInput>;
  }
>("recommendations.product.read", async ({ context }, input) => ({
  sourceEntityId: await resolveOrThrow(context, "product", input.sourceId),
  current: await getProductRelatedness(context, input.sourceId),
  input,
}));
const productReadStep = callStep({
  name: "read",
  fn: readProductDismissal,
  input: workflowInput<z.output<typeof dismissProductRecommendationInput>>(),
});
const dismissProduct = defineWorkflowFunction<
  Database,
  Awaited<ReturnType<typeof readProductDismissal.run>>,
  { ok: true }
>("recommendations.product.dismiss", async ({ context }, value) => {
  const { sourceEntityId, current, input } = value;
  if (!current.items.some((item) => item.shortcode === input.targetId))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Recommendation is no longer current",
    );
  await dismissSuggestion(context, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.related",
    candidateKey: await suggestionCandidateKey("product.related", [
      input.targetId,
    ]),
  });
  return { ok: true as const };
});
const productDismissStep = committedCallStep({
  name: "dismiss",
  fn: dismissProduct,
  input: productReadStep.output,
});
export const dismissProductRecommendationWorkflow = bindWorkflow(
  defineWorkflow({
    name: "recommendations.product.dismiss",
    steps: [productReadStep, productDismissStep],
    output: productDismissStep.output,
  }),
  (
    db: Database,
    input: z.output<typeof dismissProductRecommendationInput>,
  ) => ({ context: db, input }),
);
