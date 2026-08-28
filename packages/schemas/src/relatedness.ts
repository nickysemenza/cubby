import { z } from "zod";
import { entitySchema, type Entity } from "./entity-core";
import type { RelationshipPathStep } from "./entity-integrity";

/**
 * The one declaration of an entity pair's semantic/relatedness capability.
 * Search derives its public allowlist from this registry; feature surfaces must
 * additionally respect `active`, so a declared future pair cannot leak live.
 */
export const relatednessPairRegistry = {
  product_to_product: {
    source: "product",
    target: "product",
    active: true,
    capabilities: ["semantic", "rail", "problems"] as const,
  },
  expense_to_product: {
    source: "expense",
    target: "product",
    active: false,
    capabilities: ["semantic"] as const,
  },
  ingredient_to_ingredient: {
    source: "ingredient",
    target: "ingredient",
    active: false,
    capabilities: ["semantic", "rail"] as const,
  },
  recipe_to_recipe: {
    source: "recipe",
    target: "recipe",
    active: false,
    capabilities: ["semantic", "rail"] as const,
  },
  wish_to_product: {
    source: "wish",
    target: "product",
    active: false,
    capabilities: ["semantic", "wish-ownership"] as const,
  },
  vendor_to_vendor: {
    source: "vendor",
    target: "vendor",
    active: false,
    capabilities: ["semantic", "rail"] as const,
  },
  location_to_location: {
    source: "location",
    target: "location",
    active: false,
    capabilities: ["semantic", "rail"] as const,
  },
} as const satisfies Record<
  string,
  {
    source: Entity;
    target: Entity;
    active: boolean;
    capabilities: readonly string[];
  }
>;

export type RelatednessPair = keyof typeof relatednessPairRegistry;
export type ActiveRelatednessPair = {
  [
    K in RelatednessPair
  ]: (typeof relatednessPairRegistry)[K]["active"] extends true ? K : never;
}[RelatednessPair];

const activeRelatednessPairKeyNames = Object.entries(relatednessPairRegistry)
  .filter(([, pair]) => pair.active)
  .map(([key]) => key);
export const activeRelatednessPairKeys =
  // SAFETY: the registry's active flag is the source of truth for this
  // non-empty tuple; each returned key belongs to the active pair union.
  activeRelatednessPairKeyNames as [
    ActiveRelatednessPair,
    ...ActiveRelatednessPair[],
  ];

export const embeddingReadinessValues = [
  "ready",
  "stale",
  "uncomputed",
  "unavailable",
] as const;
export const embeddingReadinessSchema = z.enum(embeddingReadinessValues);
export type EmbeddingReadiness = z.infer<typeof embeddingReadinessSchema>;

const relationshipStepSchema = z.object({
  edge: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
});

export const relatednessSignalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coOccurrence"),
    label: z.string(),
    pair: z.string(),
    weight: z.number(),
    sourcePath: z.array(relationshipStepSchema).readonly(),
    targetPath: z.array(relationshipStepSchema).readonly().optional(),
    predicate: z.string().optional(),
    hubCap: z.number().int().positive(),
    evidenceOnly: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("direct"),
    label: z.string(),
    pair: z.string(),
    weight: z.number(),
    relationship: z.string(),
  }),
  z.object({
    kind: z.literal("scalarOverlap"),
    label: z.string(),
    pair: z.string(),
    column: z.string(),
    popularityCap: z.number().int().positive(),
    scoring: z.enum(["scored", "displayOnly"]),
    weight: z.number().optional(),
  }),
  z.object({
    kind: z.literal("textSimilarity"),
    label: z.string(),
    pair: z.string(),
    column: z.string(),
    thresholds: z
      .array(z.object({ min: z.number(), weight: z.number() }))
      .min(1)
      .readonly(),
  }),
  z.object({
    kind: z.literal("semantic"),
    label: z.string(),
    pair: z.string(),
    weight: z.number(),
    limit: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("temporalOverlap"),
    label: z.string(),
    pair: z.string(),
    weight: z.number(),
    windowResolver: z.string(),
  }),
]);
export type RelatednessSignal = z.infer<typeof relatednessSignalSchema> & {
  sourcePath?: readonly RelationshipPathStep[];
  targetPath?: readonly RelationshipPathStep[];
};

export const relatednessEvidenceSchema = z.object({
  signal: z.string(),
  detail: z.string().nullable(),
  weight: z.number(),
});

export const relatednessItemSchema = z.object({
  entity: entitySchema,
  shortcode: z.string(),
  title: z.string(),
  score: z.number(),
  evidence: z.array(relatednessEvidenceSchema).min(1),
});

export const relatednessOutSchema = z.object({
  status: embeddingReadinessSchema,
  items: z.array(relatednessItemSchema),
});
export type RelatednessOut = z.infer<typeof relatednessOutSchema>;
