import type { EntityManifest } from "@cubby/schemas/entity-manifest";
/**
 * Which entity owns each non-entity row that carries an `ENTITY_EDGES` column,
 * so the physical edge graph (`repo/entity-edge-source.ts`) can name both
 * endpoints of an edge whose column sits on a join or child row.
 *
 * `ENTITY_EDGES` records only the referencing column. For an entity table that
 * column's row is the source; for anything else this map supplies the owner:
 *
 * - `owner`: a column on the same row naming the owning entity. The owner
 *   column itself produces no edge (it links the row to its own owner).
 * - `via`: the owner sits one hop away (a line's section names the recipe).
 * - `excluded`: workflow, history, or review rows whose columns are evidence
 *   about entities rather than relationships between them.
 *
 * The map is typed to exactly the non-entity tables `ENTITY_EDGES` names, so a
 * new join table must decide its owner explicitly and a stale entry fails to
 * compile.
 */
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { DECLARED_EDGE_OWNERS } from "./generated/declared-edges.gen";
import type { ENTITY_EDGES } from "./generated/entity-edges.gen";
import {
  financialTransactionAllocation,
  purchasePaymentEvidence,
} from "./schema";

// `edges()` holds each key to its column's literal `Table.column` name, so the
// key's first segment is the table that carries the edge column.
type EdgeKey = {
  [E in keyof typeof ENTITY_EDGES]: keyof (typeof ENTITY_EDGES)[E] & string;
}[keyof typeof ENTITY_EDGES];
type EdgeTable<K extends string> = K extends `EntityLink[${string}`
  ? "EntityLink"
  : K extends `${infer Table}.${string}`
    ? Table
    : never;
type EntityTable = NonNullable<EntityManifest[keyof EntityManifest]["dbTable"]>;
type NonEntityEdgeTable = Exclude<EdgeTable<EdgeKey>, EntityTable>;

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

const WORKFLOW =
  "Workflow evidence about entities, not a relationship between them.";

export const ENTITY_EDGE_OWNERS = {
  ...DECLARED_EDGE_OWNERS,

  FinancialTransactionAllocation: {
    owner: financialTransactionAllocation.transactionId,
  },

  PurchasePaymentEvidence: { owner: purchasePaymentEvidence.purchaseId },

  // A run's target list is how a run relates to what it imported.

  // An Image job's attempts, events and submission memberships belong to the job.

  // A reviewed association names the Email whose evidence it settles.

  ImportSourceOrder: { excluded: WORKFLOW },
} satisfies Record<NonEntityEdgeTable, EntityEdgeOwner>;
