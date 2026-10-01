import type {
  dismissDuplicateProductRecommendationInput,
  dismissProductRecommendationInput,
  dismissTagPropagationInput,
  duplicateProductRecommendationInput,
} from "@cubby/schemas/recommendations";
import type { z } from "zod";

import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { findDuplicateProductIdentities } from "~/server/repo/problems/detectors-product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  dismissSuggestion,
  getActiveSuggestionDismissalKeys,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";
import { getEntityRecommendations } from "~/server/services/entity-recommendations.service";
import { getPlacementRecommendation } from "~/server/services/placement-recommendation.service";
import {
  dismissProductMatchPair,
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
  const dismissals = await getActiveSuggestionDismissalKeys(db, {
    entityKind: "product",
    entityId: sourceEntityId,
    suggestionKind: "product.duplicate",
  });
  const candidateKey = await suggestionCandidateKey(
    "product.duplicate",
    candidate.products.map((product) => product.id).sort(),
  );
  return dismissals.has(candidateKey) ? null : candidate;
}

export async function dismissDuplicateProductRecommendationWorkflow(
  db: Database,
  input: z.output<typeof dismissDuplicateProductRecommendationInput>,
) {
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
    entityKind: "product",
    entityId: sourceEntityId,
    suggestionKind: "product.duplicate",
    candidateKey: await suggestionCandidateKey(
      "product.duplicate",
      candidate.products.map((product) => product.id).sort(),
    ),
  });
  return { ok: true as const };
}

export async function dismissTagPropagationWorkflow(
  db: Database,
  input: z.output<typeof dismissTagPropagationInput>,
) {
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const current = await getProductTagPropagation(db, input.sourceId);
  if (!current.proposals.some((proposal) => proposal.tag === input.tag))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Tag recommendation is no longer current",
    );
  await dismissSuggestion(db, {
    entityKind: "product",
    entityId: sourceEntityId,
    suggestionKind: "product.tag-propagation",
    candidateKey: await suggestionCandidateKey("product.tag-propagation", [
      input.tag,
    ]),
  });
  return { ok: true as const };
}

export async function dismissProductRecommendationWorkflow(
  db: Database,
  input: z.output<typeof dismissProductRecommendationInput>,
) {
  const sourceEntityId = await resolveOrThrow(db, "product", input.sourceId);
  const current = await getProductRelatedness(db, input.sourceId);
  if (!current.items.some((item) => item.shortcode === input.targetId))
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Recommendation is no longer current",
    );
  await dismissSuggestion(db, {
    entityKind: "product",
    entityId: sourceEntityId,
    suggestionKind: "product.related",
    candidateKey: await suggestionCandidateKey("product.related", [
      input.targetId,
    ]),
  });
  return { ok: true as const };
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
    product: (context, input) =>
      getProductRelatedness(context.db, input.sourceId),
    duplicateProduct: (context, input) =>
      getDuplicateProductRecommendationWorkflow(context.db, input),
    tagPropagation: (context, input) =>
      getProductTagPropagation(context.db, input.sourceId),
    dismissDuplicateProduct: (context, input) =>
      dismissDuplicateProductRecommendationWorkflow(context.db, input),
    dismissTagPropagation: (context, input) =>
      dismissTagPropagationWorkflow(context.db, input),
    dismissProduct: (context, input) =>
      dismissProductRecommendationWorkflow(context.db, input),
    productMatches: (context, input) => getProductMatchQueue(context.db, input),
    proposeProductMatch: (context, input) =>
      proposeProductMatch(context.db, input),
    dismissProductMatch: (context, input) =>
      dismissProductMatchPair(context.db, input),
    mergeProductMatch: (context, input) => mergeProductMatch(context, input),
  },
);
