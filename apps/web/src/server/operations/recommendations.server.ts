import type { duplicateProductRecommendationInput } from "@cubby/schemas/recommendations";
import type { z } from "zod";

import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { assessRecommendation } from "~/server/repo/assessment-recommendation";
import {
  getActiveAssessmentSuppressionKeys,
  assessmentCandidateKey,
} from "~/server/repo/assessment-state";
import { findDuplicateProductIdentities } from "~/server/repo/problems/detectors-product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getEntityRecommendations } from "~/server/services/entity-recommendations.service";
import { getPlacementRecommendation } from "~/server/services/placement-recommendation.service";
import {
  getProductMatchQueue,
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/services/product-match.service";
import {
  getProductRelatedness,
  getProductTagPropagation,
} from "~/server/services/relatedness.service";

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
