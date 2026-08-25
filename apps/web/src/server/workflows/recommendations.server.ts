import { productShortcode } from "@cubby/schemas/identifiers";
import {
  dismissDuplicateProductRecommendationInput,
  dismissProductRecommendationInput,
  dismissTagPropagationInput,
  duplicateProductRecommendationInput,
  duplicateProductRecommendationOut,
  placementRecommendationInput,
  placementRecommendationOut,
  recommendationOkSchema,
  recommendationWorkbenchInput,
  recommendationWorkbenchOut,
  tagPropagationRecommendationInput,
  tagPropagationRecommendationOut,
} from "@cubby/schemas/recommendations";
import { relatednessOutSchema } from "@cubby/schemas/relatedness";
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
import { getPlacementRecommendation } from "~/server/services/placement-recommendation.service";
import {
  getProductRelatedness,
  getProductTagPropagation,
} from "~/server/services/relatedness.service";

export const recommendationWorkflowSchemas = {
  relatedness: { input: productShortcode, output: relatednessOutSchema },
  placement: {
    input: placementRecommendationInput,
    output: placementRecommendationOut,
  },
  product: {
    input: recommendationWorkbenchInput,
    output: recommendationWorkbenchOut,
  },
  duplicateProduct: {
    input: duplicateProductRecommendationInput,
    output: duplicateProductRecommendationOut,
  },
  dismissDuplicateProduct: {
    input: dismissDuplicateProductRecommendationInput,
    output: recommendationOkSchema,
  },
  tagPropagation: {
    input: tagPropagationRecommendationInput,
    output: tagPropagationRecommendationOut,
  },
  dismissTagPropagation: {
    input: dismissTagPropagationInput,
    output: recommendationOkSchema,
  },
  dismissProduct: {
    input: dismissProductRecommendationInput,
    output: recommendationOkSchema,
  },
} as const;

export const getProductRelatednessWorkflow = (
  db: Database,
  sourceId: z.output<typeof productShortcode>,
) => getProductRelatedness(db, sourceId);
export const getPlacementRecommendationWorkflow = (
  db: Database,
  input: z.output<typeof placementRecommendationInput>,
) => getPlacementRecommendation(db, input.inventoryId);
export const getProductRecommendationWorkflow = (
  db: Database,
  input: z.output<typeof recommendationWorkbenchInput>,
) => getProductRelatedness(db, input.sourceId);
export const getDuplicateProductRecommendationWorkflow = async (
  db: Database,
  input: z.output<typeof duplicateProductRecommendationInput>,
) => {
  const candidates = await findDuplicateProductIdentities(db);
  const candidate =
    candidates.find((item) =>
      item.products.some((product) => product.id === input.sourceId),
    ) ?? null;
  if (!candidate) return null;
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const dismissals = await getActiveSuggestionDismissalKeys(db, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.duplicate",
  });
  const candidateKey = await suggestionCandidateKey(
    "product.duplicate",
    candidate.products.map((product) => product.id).sort(),
  );
  return dismissals.has(candidateKey) ? null : candidate;
};
export const dismissDuplicateProductRecommendationWorkflow = async (
  db: Database,
  input: z.output<typeof dismissDuplicateProductRecommendationInput>,
) => {
  const [sourceEntityId, candidates] = await Promise.all([
    resolveOrThrow(db, "product", input.sourceId),
    findDuplicateProductIdentities(db),
  ]);
  const candidate = candidates.find((item) =>
    item.products.some((product) => product.id === input.sourceId),
  );
  if (!candidate)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Duplicate recommendation is no longer current",
    );
  await dismissSuggestion(db, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.duplicate",
    candidateKey: await suggestionCandidateKey(
      "product.duplicate",
      candidate.products.map((product) => product.id).sort(),
    ),
  });
  return { ok: true as const };
};
export const getTagPropagationRecommendationWorkflow = (
  db: Database,
  input: z.output<typeof tagPropagationRecommendationInput>,
) => getProductTagPropagation(db, input.sourceId);
export const dismissTagPropagationWorkflow = async (
  db: Database,
  input: z.output<typeof dismissTagPropagationInput>,
) => {
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const current = await getProductTagPropagation(db, input.sourceId);
  if (!current.proposals.some((proposal) => proposal.tag === input.tag))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Tag recommendation is no longer current",
    );
  await dismissSuggestion(db, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.tag-propagation",
    candidateKey: await suggestionCandidateKey("product.tag-propagation", [
      input.tag,
    ]),
  });
  return { ok: true as const };
};
export const dismissProductRecommendationWorkflow = async (
  db: Database,
  input: z.output<typeof dismissProductRecommendationInput>,
) => {
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const current = await getProductRelatedness(db, input.sourceId);
  if (!current.items.some((item) => item.shortcode === input.targetId))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Recommendation is no longer current",
    );
  await dismissSuggestion(db, {
    sourceEntityType: "product",
    sourceEntityId,
    suggestionKind: "product.related",
    candidateKey: await suggestionCandidateKey("product.related", [
      input.targetId,
    ]),
  });
  return { ok: true as const };
};
