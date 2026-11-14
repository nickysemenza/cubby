import type { EdgeRole, EdgeLiveness } from "@cubby/schemas/entity-integrity";
import type { EntityManifest } from "@cubby/schemas/entity-manifest";
import type { AnyColumn } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { ENTITY_EDGES } from "./generated/entity-edges.gen";
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

export type EntityEdgeOwner =
  | { owner: AnyPgColumn }
  | {
      /** Joined on `via.table.id = <row>.<via.column>`. */
      via: {
        column: AnyPgColumn;
        table: { id: AnyPgColumn };
        owner: AnyPgColumn;
      };
    }
  /**
   * The owner's kind is not fixed by the table: `EntityAttachment` names any
   * entity, so its kind is read from `Entity`.
   */
  | { ownerIdentity: AnyPgColumn }
  /**
   * `EntityLink`: the owner is `fromEntityId`, whose kind the row's link kind
   * declares (`ENTITY_LINK_KINDS[kind].from`). The `.from` end of each kind is
   * the owner column; the `.to` end is the edge.
   */
  | { linkFrom: AnyPgColumn }
  | { excluded: string };

type EdgeKey = {
  [E in keyof typeof ENTITY_EDGES]: keyof (typeof ENTITY_EDGES)[E] & string;
}[keyof typeof ENTITY_EDGES];
type EdgeTable<K extends string> = K extends `EntityLink[${string}`
  ? "EntityLink"
  : K extends `${infer Table}.${string}`
    ? Table
    : never;
export type NonEntityEdgeTable = Exclude<
  EdgeTable<EdgeKey>,
  NonNullable<EntityManifest[keyof EntityManifest]["dbTable"]>
>;
