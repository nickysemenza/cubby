import type { Entity } from "@cubby/schemas/entity";
import { and, getTableColumns, is, notInArray } from "drizzle-orm";
import { PgTable, PgColumn } from "drizzle-orm/pg-core";

import type { DrizzleTransaction } from "~/server/db";
import {
  edgeScopeWhere,
  INCOMING_EDGES,
  ordinaryIncomingEdgeKeys,
} from "~/server/db/entity-incoming-edges";
import { countByTarget } from "~/server/entity-kernel/repo/impact";
import { createAppError } from "~/server/errors/app-error";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-utils";

/** Unknown ordinary references never inherit a domain edge's detach/repoint semantics. */
export const assertNoOrdinaryReferences = async (
  tx: DrizzleTransaction,
  entity: Entity,
  ids: readonly string[],
): Promise<void> => {
  if (ids.length === 0) return;
  const ordinary = new Set(ordinaryIncomingEdgeKeys(entity));
  const own = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === entity,
  )?.[1];
  for (const [key, edge] of Object.entries(INCOMING_EDGES[entity])) {
    if (!ordinary.has(key)) continue;
    const table = edge.column.table;
    if (!is(table, PgTable) || !is(edge.column, PgColumn))
      throw new Error(`Incoming edge ${key} is not PostgreSQL storage.`);
    const columns = getTableColumns(table);
    const counts = await countByTarget(tx, table, edge.column, [...ids], {
      includeDeleted: !("deletedAt" in columns),
      extraWhere: and(
        edgeScopeWhere(edge),
        table === own && columns.id
          ? notInArray(columns.id, [...ids])
          : undefined,
      ),
    });
    if (Object.values(counts).some((count) => count > 0)) {
      throw createAppError(
        "ENTITY_DELETE_BLOCKED",
        `Cannot remove or merge ${entity}: ${key} still has live ordinary references.`,
      );
    }
  }
};
