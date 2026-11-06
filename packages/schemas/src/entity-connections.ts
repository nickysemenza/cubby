import { z } from "zod";
import { suggestionFamily } from "./suggestion";
import {
  suggestionReviewReference,
  suggestionSuppression,
} from "./suggestion-reference";
import { entityGraphRootSchema } from "./entity-graph";

import { entitySchema } from "./entity-core";
import { edgeRoleSchema, operationDispositionSchema } from "./entity-integrity";
import { shortcodeEntities } from "./generated/entity-roster.gen";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import { runShortcode } from "./identifiers";

/**
 * One-hop physical and explicitly opted-in repository reference connections.
 * `incoming` rows point at the entity; `outgoing` rows are what the entity
 * points at. Repository connections do not participate in the physical graph.
 */
export const entityConnectionDirection = z.enum(["incoming", "outgoing"]);
export type EntityConnectionDirection = z.infer<
  typeof entityConnectionDirection
>;

export const entityConnectionsInput = z.object({
  /** Any entity's public code; a merged-away code reads its survivor. */
  id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
  /**
   * Attach each incoming group's declared disposition for this operation —
   * the delete/merge impact preview. Advisory: the mutation re-checks.
   */
  operation: z.enum(["delete", "merge"]).optional(),
  limitPerGroup: z.number().int().min(1).max(50).default(10),
});
export type EntityConnectionsInput = z.input<typeof entityConnectionsInput>;

export const entityConnectionItem = z.object({
  id: z.string(),
  kind: entitySchema,
  name: z.string().nullable(),
});
export type EntityConnectionItem = z.infer<typeof entityConnectionItem>;

export const entityConnectionGroup = z.object({
  direction: entityConnectionDirection,
  edgeKey: z.string(),
  label: z.string(),
  role: edgeRoleSchema,
  otherKind: entitySchema,
  count: z.number().int().nonnegative(),
  items: z.array(entityConnectionItem),
  /** Present only for an incoming physical edge when an `operation` was requested. */
  disposition: operationDispositionSchema.nullable(),
});
export type EntityConnectionGroup = z.infer<typeof entityConnectionGroup>;

export const entityConnectionsOut = z.object({
  id: z.string(),
  kind: entitySchema,
  groups: z.array(entityConnectionGroup),
});
export type EntityConnectionsOut = z.infer<typeof entityConnectionsOut>;

/**
 * The kernel merge preview for a selection of one kind: the survivor the
 * server suggests and the fields the selection disagrees on. Advisory, like
 * `entityConnectionsInput`'s merge dispositions; `entity.mutate` merge
 * re-validates. A merged-away code is refused with the survivor's code.
 */
export const entityMergePreviewInput = z.object({
  entity: entitySchema,
  ids: z
    .array(z.string().min(1))
    .min(2)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, "ids must be distinct"),
});
export type EntityMergePreviewInput = z.input<typeof entityMergePreviewInput>;

export const entityMergeCandidate = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** Live incoming physical connections: the edges a merge repoints. */
  connectionCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const entityMergeConflictValue = z.object({
  /** The candidate holding this value. */
  id: z.string(),
  /** The value as the update contract writes it. */
  value: z.unknown(),
  /** Member-facing text for the value. */
  display: z.string(),
});

export const entityMergeConflict = z.object({
  field: z.string(),
  label: z.string(),
  /** One entry per candidate with a value, in `candidates` order. */
  values: z.array(entityMergeConflictValue).min(2),
});

export const entityMergePreviewOut = z.object({
  entity: entitySchema,
  /** Most connections, then oldest, then code: deterministic for a selection. */
  suggestedKeepId: z.string(),
  candidates: z.array(entityMergeCandidate),
  /**
   * Update fields where two or more candidates hold different values. The
   * merge keeps the survivor's value; another value is chosen by updating
   * the survivor before merging.
   */
  conflicts: z.array(entityMergeConflict),
});
export type EntityMergePreviewOut = z.infer<typeof entityMergePreviewOut>;

/** Entities with no live physical connection, for the Problems page. */
export const orphanEntitiesOut = z.object({
  items: z.array(entityConnectionItem),
  count: z.number().int().nonnegative(),
});
export type OrphanEntitiesOut = z.infer<typeof orphanEntitiesOut>;

/** Canonical recorded-transfer evidence and its invalidation use one window. */

export const connectionRelation = z.enum([
  "product-purchase",
  "product-expense",
  "product-identity",
  "email-purchase",
  "transaction-purchase",
  "transaction-refund",
  "expense-project",
  "project-tool",
  "task-subject-product",
  "product-ingredient",
  "product-grows-plant",
  "cookbook-product",
  "device-product",
  "inventory-location",
]);
export type ConnectionRelation = z.infer<typeof connectionRelation>;

const connectionEndpoints = {
  "product-purchase": ["product", "purchase"],
  "product-expense": ["product", "expense"],
  "product-identity": ["product", "product"],
  "email-purchase": ["email", "purchase"],
  "transaction-purchase": ["financialTransaction", "purchase"],
  "transaction-refund": ["financialTransaction", "purchase"],
  "expense-project": ["expense", "project"],
  "project-tool": ["project", "product"],
  "task-subject-product": ["task", "product"],
  "product-ingredient": ["product", "ingredient"],
  "product-grows-plant": ["product", "plant"],
  "cookbook-product": ["cookbook", "product"],
  "device-product": ["device", "product"],
  "inventory-location": ["inventory", "location"],
} satisfies Record<ConnectionRelation, readonly [string, string]>;

/** Every record kind some connection relation can start or end at. */
export const connectionEndpointKinds = [
  ...new Set(Object.values(connectionEndpoints).flat()),
];

export const connectionEvidence = z.object({
  reasons: z.array(z.string()).max(30),
  contradictions: z.array(z.string()).max(30),
  unknowns: z.array(z.string()).max(30),
});

/** Direction is canonical regardless of which endpoint requests discovery. */
export const connectionEdge = z
  .object({
    relation: connectionRelation,
    source: entityGraphRootSchema,
    target: entityGraphRootSchema,
  })
  .refine(({ relation, source, target }) => {
    const [from, to] = connectionEndpoints[relation];
    return (
      source.entityKind === from &&
      target.entityKind === to &&
      !(
        source.entityKind === target.entityKind &&
        source.entityId === target.entityId
      )
    );
  }, "Connection relation requires its canonical distinct endpoints");
export type ConnectionEdge = z.infer<typeof connectionEdge>;
export const connectionEdgeKey = (edge: ConnectionEdge): string =>
  `${edge.relation}:${edge.source.entityKind}:${edge.source.entityId}:${edge.target.entityKind}:${edge.target.entityId}`;

/** Live published endpoints are canonical codes; retain opaque legacy keys without guessing. */
export function connectionEdgeFromKey(key: string): ConnectionEdge | undefined {
  const parts = key.split(":");
  if (parts.length !== 5) return undefined;
  const [relation, sourceKind, sourceId, targetKind, targetId] = parts;
  const parsed = connectionEdge.safeParse({
    relation,
    source: { entityKind: sourceKind, entityId: sourceId },
    target: { entityKind: targetKind, entityId: targetId },
  });
  return parsed.success && connectionEdgeKey(parsed.data) === key
    ? parsed.data
    : undefined;
}

export const connectionCandidate = connectionEdge.safeExtend({
  label: z.string().min(1),
  evidence: connectionEvidence,
});
export type ConnectionCandidate = z.infer<typeof connectionCandidate>;

export const connectionProposal = connectionCandidate.safeExtend({
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  review: suggestionReviewReference.extend({
    suppression: suggestionSuppression.nullable(),
    /** The stored Suggestion family; entity-pair families flag list rows. */
    family: suggestionFamily.optional(),
  }),
  fingerprint: z.string().min(1),
  integration: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("connection-review") }),
    z.object({ kind: z.literal("field-review"), field: z.string().min(1) }),
    z.object({ kind: z.literal("product-pair-review") }),
    z.object({ kind: z.literal("email-link-review") }),
  ]),
});
export type ConnectionProposal = z.infer<typeof connectionProposal>;

/** Immutable payload in recommendation Suggestion evidence; no separate ledger. */
export const connectionSuggestionEvidence = z.object({
  version: z.literal(1),
  candidate: connectionCandidate,
  basis: z.json(),
});
export const connectionDiscoveryOut = z.object({
  source: entityGraphRootSchema,
  proposals: z.array(connectionProposal),
  discoveryRunId: runShortcode.nullable().optional(),
});
