import type { EdgeRole, EdgeLiveness } from "@cubby/schemas/entity-integrity";
import type { AnyColumn } from "drizzle-orm";

import { DECLARED_EDGE_OVERRIDES } from "./generated/declared-edges.gen";
export interface EntityEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * What the edge represents in the domain — never what an operation does
   * about it. See {@link EdgeRole} for the closed vocabulary.
   */
  role: EdgeRole;
  /** Plural noun phrase naming the referencing rows, e.g. "recipes". */
  label: string;
  /** One or two sentences explaining what the edge means and why. */
  description: string;
  /**
   * Whether a live source row is allowed to point at a soft-deleted target.
   * Nearly every edge is `must-target-live`.
   */
  liveness: EdgeLiveness;
  /**
   * True when the relationship is real (modeled in `relations()`, walked by
   * app code) but carries no DB-level FK constraint. Predicates that need to
   * walk the relationship still can; they just can't rely on the database to
   * enforce or cascade it.
   */
  unconstrained?: true;
  /** Free-text justification, for an edge whose key alone doesn't explain itself. */
  note?: string;
  /**
   * The rows of `column`'s table that belong to this edge, when the table
   * carries several edges in one column. Every `EntityLink` edge is scoped to
   * its link kind (`kind = 'productComponent'`): `toEntityId` alone would
   * match a product's purchase, tool, wish, and component links at once.
   * Every consumer that builds SQL from `column` must AND this in.
   */
  scope?: EdgeScope;
}

export interface EdgeScope {
  column: AnyColumn;
  value: string;
}

export const ENTITY_EDGE_OVERRIDES = DECLARED_EDGE_OVERRIDES;
