import type { duplicateProductRecommendationInput } from "@cubby/schemas/recommendations";
import type { z } from "zod";

import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import type { Database } from "~/server/db";
import { getPlacementRecommendation } from "~/server/domains/inventory/service/placement-recommendation.service";
import {
  getProductMatchQueue,
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/domains/product/service/product-match.service";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { assessRecommendation } from "~/server/generic/assessment/repo/assessment-recommendation";
import {
  getActiveAssessmentSuppressionKeys,
  assessmentCandidateKey,
} from "~/server/generic/assessment/repo/assessment-state";
import { findDuplicateProductIdentities } from "~/server/generic/problems/repo/detectors-product";
import {
  getProductRelatedness,
  getProductTagPropagation,
} from "~/server/generic/relatedness/service/relatedness.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export async function getDuplicateProductRecommendationWorkflow(
  db: Database,
  input: z.output<typeof duplicateProductRecommendationInput>,
) {
  const candidate = (await findDuplicateProductIdentities(db)).find((item) =>
    item.products.some((product) => product.id === input.sourceId),
  );
  if (!candidate) return null;
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const dismissals = await getActiveAssessmentSuppressionKeys(db, {
    entityKind: "product",
    entityId: sourceEntityId,
    suggestionKind: "product.duplicate",
  });
  const candidateKey = await assessmentCandidateKey(
    "product.duplicate",
    candidate.products.map((product) => product.id).sort(),
  );
  if (dismissals.has(candidateKey)) return null;
  return {
    ...candidate,
    review: await assessRecommendation(
      db,
      input.sourceId,
      "product.duplicate",
      candidate.products.map((product) => product.id).sort(),
      candidate,
    ),
  };
}

export const relatednessHandlers = implementOperationDomain(
  relatednessContract,
  {
    product: (context, input) => getProductRelatedness(context.db, input),
  },
);

export const recommendationsHandlers = implementOperationDomain(
  recommendationsContract,
  {
    forEntity: (context, input) => getEntityRecommendations(context.db, input),
    placement: (context, input) =>
      getPlacementRecommendation(context.db, input.inventoryId),
    product: async (context, input) => {
      const result = await getProductRelatedness(context.db, input.sourceId);
      return {
        ...result,
        items: await Promise.all(
          result.items.map(async (item) => ({
            ...item,
            review: await assessRecommendation(
              context.db,
              input.sourceId,
              "product.related",
              [item.shortcode],
              item,
            ),
          })),
        ),
      };
    },
    duplicateProduct: (context, input) =>
      getDuplicateProductRecommendationWorkflow(context.db, input),
    tagPropagation: async (context, input) => {
      const result = await getProductTagPropagation(context.db, input.sourceId);
      return {
        ...result,
        proposals: await Promise.all(
          result.proposals.map(async (proposal) => ({
            ...proposal,
            review: await assessRecommendation(
              context.db,
              input.sourceId,
              "product.tag-propagation",
              [proposal.tag],
              proposal,
            ),
          })),
        ),
      };
    },
    productMatches: (context, input) => getProductMatchQueue(context.db, input),
    proposeProductMatch: (context, input) =>
      proposeProductMatch(context.db, input),
    mergeProductMatch: (context, input) => mergeProductMatch(context, input),
  },
);
