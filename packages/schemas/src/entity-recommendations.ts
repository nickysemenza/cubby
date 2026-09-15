import { z } from "zod";
import { entityGraphRootSchema } from "./entity-graph";
import {
  expenseShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
  projectShortcode,
} from "./identifiers";
import {
  embeddingReadinessSchema,
  relatednessEvidenceSchema,
} from "./relatedness";

export const entityRecommendationsInput = entityGraphRootSchema;

export const recommendationProjectTarget = z.object({
  id: projectShortcode,
  name: z.string(),
});
export const recommendationLocationTarget = z.object({
  id: locationShortcode,
  name: z.string(),
});
export const recommendationSupportingExpense = z.object({
  id: expenseShortcode,
  name: z.string(),
});

export const recommendationCurrentProjectTarget =
  recommendationProjectTarget.nullable();
export const recommendationCurrentLocationTarget =
  recommendationLocationTarget.nullable();

export const expenseProjectProposal = z.object({
  kind: z.literal("expense-project"),
  expenseId: expenseShortcode,
  target: recommendationProjectTarget,
  effectiveStart: z.string().nullable(),
  effectiveEnd: z.string().nullable(),
  sameTradeCount: z.number().int().nonnegative(),
  exactProductCount: z.number().int().nonnegative(),
  supportingExpenses: z.array(recommendationSupportingExpense).max(3),
  reasons: z.array(z.string()),
});

export const inventoryPlacementProposal = z.object({
  kind: z.literal("inventory-placement"),
  inventoryId: inventoryShortcode,
  target: recommendationLocationTarget,
  reasons: z.array(z.string()),
});

export const productRelatedProposal = z.object({
  kind: z.literal("product-related"),
  target: z.object({ id: productShortcode, name: z.string() }),
  score: z.number(),
  evidence: z.array(relatednessEvidenceSchema),
});

export const entityRecommendationGroup = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("expense-project"),
    status: embeddingReadinessSchema,
    currentTarget: recommendationCurrentProjectTarget,
    proposals: z.array(expenseProjectProposal).max(3),
  }),
  z.object({
    kind: z.literal("inventory-placement"),
    status: embeddingReadinessSchema,
    currentTarget: recommendationCurrentLocationTarget,
    proposals: z.array(inventoryPlacementProposal).max(1),
  }),
  z.object({
    kind: z.literal("product-related"),
    status: embeddingReadinessSchema,
    proposals: z.array(productRelatedProposal),
  }),
]);

export const entityRecommendationsOut = z.object({
  source: entityGraphRootSchema,
  /** Identifies the source context; clients discard a proposal when this changes. */
  basisKey: z.string(),
  groups: z.array(entityRecommendationGroup),
});
export type EntityRecommendationsOut = z.infer<typeof entityRecommendationsOut>;
export type EntityRecommendationGroup = z.infer<
  typeof entityRecommendationGroup
>;
export type ExpenseProjectProposal = z.infer<typeof expenseProjectProposal>;
export type InventoryPlacementProposal = z.infer<
  typeof inventoryPlacementProposal
>;
