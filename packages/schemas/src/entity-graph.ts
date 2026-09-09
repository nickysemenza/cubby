import { z } from "zod";
import { parseShortcode } from "@cubby/shared";

import { entityRefSchema, entitySchema } from "./entity";
import { imageUrlSummary } from "./image-summary";

/**
 * A bounded, manifest-backed expansion of local entity relationships. UUIDs
 * never leave this contract: every reference is an entity plus shortcode.
 */
export const entityGraphRootSchema = entityRefSchema.superRefine(
  (root, context) => {
    const parsed = parseShortcode(root.entityId);
    if (!parsed || parsed.type !== root.entityType) {
      context.addIssue({
        code: "custom",
        message: "expected a shortcode for the declared entity",
      });
    }
  },
);

export const entityGraphInputSchema = z.object({
  roots: z.array(entityGraphRootSchema).min(1).max(25),
  /** Relationship keys declared by the source entity's manifest. */
  relationshipKeys: z.array(z.string().min(1)).max(50).optional(),
  /** Restrict expansions to these target entity kinds. */
  entityTypes: z.array(entitySchema).max(20).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(25),
});
export type EntityGraphInput = z.input<typeof entityGraphInputSchema>;

export const entityGraphNodeSchema = entityRefSchema.extend({
  label: z.string(),
  metadata: z.record(z.string(), z.string()),
  image: imageUrlSummary.optional(),
});
export type EntityGraphNode = z.infer<typeof entityGraphNodeSchema>;

export const entityGraphEdgeSchema = z.object({
  /** Stable physical-path identity, shared by forward and inverse expansions. */
  id: z.string(),
  source: entityRefSchema,
  target: entityRefSchema,
  relationshipKey: z.string(),
  label: z.string(),
  /** The named manifest source that produced this edge. */
  sourceKey: z.string(),
  provenance: z.array(z.string()),
});
export type EntityGraphEdge = z.infer<typeof entityGraphEdgeSchema>;

export const entityGraphBranchSchema = z.object({
  root: entityRefSchema,
  relationshipKey: z.string(),
  label: z.string(),
  target: entitySchema,
  totalCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  /** The page's members, retained in branch order for list rendering. */
  items: z.array(entityRefSchema),
  /** Canonical graph edges represented by this page, in item order. */
  edgeIds: z.array(z.string()),
});
export type EntityGraphBranch = z.infer<typeof entityGraphBranchSchema>;

export const entityGraphOutputSchema = z.object({
  nodes: z.array(entityGraphNodeSchema),
  edges: z.array(entityGraphEdgeSchema),
  branches: z.array(entityGraphBranchSchema),
  truncated: z.boolean(),
});
export type EntityGraphOutput = z.infer<typeof entityGraphOutputSchema>;

export const entityGraphPathsInputSchema = z.object({
  start: entityGraphRootSchema,
  destination: entityGraphRootSchema,
});
export type EntityGraphPathsInput = z.infer<typeof entityGraphPathsInputSchema>;

export const entityGraphPathSchema = z.object({
  /** Ordered from start through destination, inclusive. */
  nodeRefs: z.array(entityRefSchema).min(1).max(9),
  /** Ordered edges between adjacent node refs. */
  edgeIds: z.array(z.string()).max(8),
});
export type EntityGraphPath = z.infer<typeof entityGraphPathSchema>;

export const entityGraphPathsOutputSchema = z.object({
  /** Only nodes used by one of the returned paths. */
  nodes: z.array(entityGraphNodeSchema),
  /** Only edges used by one of the returned paths. */
  edges: z.array(entityGraphEdgeSchema),
  /** Up to three shortest candidates; authoritative when certainty is true. */
  paths: z.array(entityGraphPathSchema).max(3),
  completion: z.enum(["exhausted", "depth-limit", "budget-limit"]),
  /** False when a limit prevented proof that the returned paths are shortest. */
  shortestPathCertain: z.boolean(),
});
export type EntityGraphPathsOutput = z.infer<
  typeof entityGraphPathsOutputSchema
>;
