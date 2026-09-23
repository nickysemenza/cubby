import { z } from "zod";

import { entitySchema } from "./entity-core";
import { edgeRoleSchema, operationDispositionSchema } from "./entity-integrity";

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
  id: z.string().trim().min(1),
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
