import { z } from "zod";
import { assessmentFamily } from "./assessment";
import {
  assessmentReviewReference,
  assessmentSuppression,
} from "./assessment-reference";
import { entityGraphRootSchema } from "./entity-graph";

import { entitySchema } from "./entity-core";
import { edgeRoleSchema, operationDispositionSchema } from "./entity-integrity";
import { shortcodeEntities } from "./entity-manifest";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import { runShortcode } from "./identifiers";

/**
 * One-hop physical connections of an entity, read from the generated
 * `EntityEdge` source (ADR 0006). `incoming` rows point at the entity;
 * `outgoing` rows are what the entity points at.
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
  /** Present only when an `operation` was requested and this edge is incoming. */
  disposition: operationDispositionSchema.nullable(),
});
export type EntityConnectionGroup = z.infer<typeof entityConnectionGroup>;

export const entityConnectionsOut = z.object({
  id: z.string(),
  kind: entitySchema,
  redirectedFrom: z.string().nullable(),
  groups: z.array(entityConnectionGroup),
});
export type EntityConnectionsOut = z.infer<typeof entityConnectionsOut>;

/** Entities with no live physical connection, for the Problems page. */
export const orphanEntitiesOut = z.object({
  items: z.array(entityConnectionItem),
  count: z.number().int().nonnegative(),
});
export type OrphanEntitiesOut = z.infer<typeof orphanEntitiesOut>;

export const connectionRelation = z.enum([
  "product-purchase",
  "product-expense",
  "product-identity",
  "email-purchase",
  "transaction-purchase",
  "transaction-transfer",
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
  "transaction-transfer": ["financialTransaction", "financialTransaction"],
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
export const connectionCandidate = z
  .object({
    relation: connectionRelation,
    source: entityGraphRootSchema,
    target: entityGraphRootSchema,
    label: z.string().min(1),
    evidence: connectionEvidence,
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
export type ConnectionCandidate = z.infer<typeof connectionCandidate>;

export const connectionProposal = connectionCandidate.safeExtend({
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  review: assessmentReviewReference.extend({
    suppression: assessmentSuppression.nullable(),
    /** The stored Assessment family; entity-pair families flag list rows. */
    family: assessmentFamily.optional(),
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

/** Immutable payload in recommendation Assessment evidence; no separate ledger. */
export const connectionAssessmentEvidence = z.object({
  version: z.literal(1),
  candidate: connectionCandidate,
  basis: z.json(),
});
export const connectionDiscoveryOut = z.object({
  source: entityGraphRootSchema,
  proposals: z.array(connectionProposal),
  discoveryRunId: runShortcode.nullable().optional(),
});
