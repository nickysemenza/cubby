import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { DECLARED_EDGE_OWNERS } from "./generated/declared-edges.gen";
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

export const ENTITY_EDGE_OWNERS = DECLARED_EDGE_OWNERS;
