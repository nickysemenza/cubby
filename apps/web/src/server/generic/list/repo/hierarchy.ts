import type { Entity } from "@cubby/schemas/entity";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import { type SQL, sql } from "drizzle-orm";

type ListFields = typeof generatedEntityListFields;
/** Entities declaring `model.hierarchy`. */
export type HierarchyEntity = {
  [E in ShortcodeEntity]: ListFields[E]["hierarchy"] extends null ? never : E;
}[ShortcodeEntity];

const hierarchyOf = (entity: Entity) => {
  const hierarchy = generatedEntityListFields[entity].hierarchy;
  const table = entityManifest[entity].dbTable;
  if (hierarchy === null || table === null)
    throw new Error(`${entity} declares no model.hierarchy`);
  return {
    ...hierarchy,
    table,
    softDelete: entityManifest[entity].softDelete,
  };
};

/**
 * Parenthesized, uncorrelated id subquery holding the selected live records
 * and their live descendants along the declared `model.hierarchy`, at most
 * `maxDepth` levels below each selected record. The visited-array guard keeps
 * a stored parent cycle from looping. `selected` is a list of ids or a
 * parenthesized id subquery (a shortcode lookup the list compiler builds).
 * `descendantsOnly` drops the selected records themselves; a cycle back to a
 * selected record still stops at the visited guard, so it never reappears.
 */
export const hierarchyDescendantsSql = <E extends HierarchyEntity>(
  entity: E,
  selected: readonly EntityId<E>[] | SQL,
  { descendantsOnly = false }: { descendantsOnly?: boolean } = {},
): SQL<EntityId<E>> => {
  const { table, column, maxDepth, softDelete } = hierarchyOf(entity);
  if (Array.isArray(selected) && selected.length === 0)
    return sql<EntityId<E>>`(SELECT NULL::uuid WHERE false)`;
  const roots = Array.isArray(selected)
    ? sql`(${sql.join(
        selected.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : selected;
  const name = sql.identifier(table);
  const parent = sql.identifier(column);
  const live = (alias: string) =>
    softDelete ? sql` AND ${sql.raw(alias)}."deletedAt" IS NULL` : sql``;
  return sql<EntityId<E>>`(
      WITH RECURSIVE descendants AS (
        SELECT h."id", 0 AS depth, ARRAY[h."id"] AS visited
        FROM ${name} h
        WHERE h."id" IN ${roots}${live("h")}
        UNION ALL
        SELECT child."id", d.depth + 1, d.visited || child."id"
        FROM descendants d JOIN ${name} child ON child.${parent} = d."id"
        WHERE d.depth < ${sql.raw(String(maxDepth))}
          AND NOT child."id" = ANY(d.visited)${live("child")}
      ) SELECT "id" FROM descendants${descendantsOnly ? sql` WHERE depth > 0` : sql``}
    )`;
};
