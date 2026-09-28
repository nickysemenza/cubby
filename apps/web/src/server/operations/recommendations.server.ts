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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

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
export const getDuplicateProductRecommendationWorkflow = bindWorkflow(
  workflow<Database, z.output<typeof duplicateProductRecommendationInput>>(
    "recommendations.duplicate",
  )
    .call("find", async ({ context }) =>
      findDuplicateProductIdentities(context),
    )
    .call("resolve", async ({ context }, { input, find }) => {
      const candidate = find.find((item) =>
        item.products.some((product) => product.id === input.sourceId),
      );
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
    })
    .output(({ resolve }) => resolve),
  (
    db: Database,
    input: z.output<typeof duplicateProductRecommendationInput>,
  ) => ({ context: db, input }),
);
type DuplicateDismissInput = z.output<
  typeof dismissDuplicateProductRecommendationInput
>;
export const dismissDuplicateProductRecommendationWorkflow = bindWorkflow(
  workflow<Database, DuplicateDismissInput>("recommendations.duplicate.dismiss")
    .parallel("load", 2, {
      source: async ({ context }, { input }) =>
        resolveOrThrow(context, "product", input.sourceId),
      candidates: async ({ context }) =>
        findDuplicateProductIdentities(context),
    })
    .call("validate", async (_, { input, load }) => {
      const { source: sourceEntityId, candidates } = load;
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
    })
    .commit("dismiss", async ({ context }, { validate }) => {
      await dismissSuggestion(context, {
        ...validate,
        sourceEntityType: "product",
      });
      return { ok: true as const };
    })
    .output(({ dismiss }) => dismiss),
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
export const dismissTagPropagationWorkflow = bindWorkflow(
  workflow<Database, z.output<typeof dismissTagPropagationInput>>(
    "recommendations.tagPropagation.dismiss",
  )
    .call("read", async ({ context }, { input }) => ({
      sourceEntityId: await resolveOrThrow(context, "product", input.sourceId),
      current: await getProductTagPropagation(context, input.sourceId),
      input,
    }))
    .commit("dismiss", async ({ context }, { read }) => {
      const { sourceEntityId, current, input } = read;
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
    })
    .output(({ dismiss }) => dismiss),
  (db: Database, input: z.output<typeof dismissTagPropagationInput>) => ({
    context: db,
    input,
  }),
);
export const dismissProductRecommendationWorkflow = bindWorkflow(
  workflow<Database, z.output<typeof dismissProductRecommendationInput>>(
    "recommendations.product.dismiss",
  )
    .call("read", async ({ context }, { input }) => ({
      sourceEntityId: await resolveOrThrow(context, "product", input.sourceId),
      current: await getProductRelatedness(context, input.sourceId),
      input,
    }))
    .commit("dismiss", async ({ context }, { read }) => {
      const { sourceEntityId, current, input } = read;
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
    })
    .output(({ dismiss }) => dismiss),
  (
    db: Database,
    input: z.output<typeof dismissProductRecommendationInput>,
  ) => ({ context: db, input }),
);
