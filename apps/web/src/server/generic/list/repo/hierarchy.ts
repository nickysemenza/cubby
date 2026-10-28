import type { Entity } from "@cubby/schemas/entity";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import { isNull } from "drizzle-orm";
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
 * and all their live descendants along the declared `model.hierarchy`. It is
 * not capped at `maxDepth` (writes do not enforce it), so a level section's
 * "Filter to this" returns every row the section counts; the visited-array
 * guard keeps a stored parent cycle from looping. `selected` is a list of ids or a
 * parenthesized id subquery (a shortcode lookup the list compiler builds).
 * `descendantsOnly` drops the selected records themselves; a cycle back to a
 * selected record still stops at the visited guard, so it never reappears.
 */
export const hierarchyDescendantsSql = <E extends HierarchyEntity>(
  entity: E,
  selected: readonly EntityId<E>[] | SQL,
  { descendantsOnly = false }: { descendantsOnly?: boolean } = {},
): SQL<EntityId<E>> => {
  const { table, column, softDelete } = hierarchyOf(entity);
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
    softDelete
      ? sql` AND ${isNull(sql`${sql.raw(alias)}."deletedAt"`)}`
      : sql``;
  return sql<EntityId<E>>`(
      WITH RECURSIVE descendants AS (
        SELECT h."id", 0 AS depth, ARRAY[h."id"] AS visited
        FROM ${name} h
        WHERE h."id" IN ${roots}${live("h")}
        UNION ALL
        SELECT child."id", d.depth + 1, d.visited || child."id"
        FROM descendants d JOIN ${name} child ON child.${parent} = d."id"
        WHERE NOT child."id" = ANY(d.visited)${live("child")}
      ) SELECT "id" FROM descendants${descendantsOnly ? sql` WHERE depth > 0` : sql``}
    )`;
};

/**
 * Correlated scalar over the walk up `model.hierarchy` from the `entity`
 * record `id`: `up` holds the record (step 1) and each live ancestor up to
 * the root. Levels are absolute, so the walk is not capped at `maxDepth`
 * (writes do not enforce it; a capped walk would take a mid-tree ancestor
 * for the root). Only the visited guard bounds it, stopping a stored cycle;
 * an absent or soft-deleted record walks nothing.
 */
const ancestorWalkSql = (entity: Entity, id: SQL, select: SQL): SQL => {
  const { table, column, softDelete } = hierarchyOf(entity);
  const name = sql.identifier(table);
  const parent = sql.identifier(column);
  const live = (alias: string) =>
    softDelete
      ? sql` AND ${isNull(sql`${sql.raw(alias)}."deletedAt"`)}`
      : sql``;
  return sql`(
      WITH RECURSIVE up AS (
        SELECT h."id", h.${parent} AS parent, 1 AS step, ARRAY[h."id"] AS visited
        FROM ${name} h
        WHERE h."id" = ${id}${live("h")}
        UNION ALL
        SELECT p."id", p.${parent}, up.step + 1, up.visited || p."id"
        FROM up JOIN ${name} p ON p."id" = up.parent
        WHERE NOT p."id" = ANY(up.visited)${live("p")}
      ) SELECT ${select} FROM up
    )`;
};

/**
 * The id of the `entity` record `id`'s ancestor at `level` (1 = top), or the
 * record itself when it sits above that level; NULL for no record.
 */
export const hierarchyAncestorSql = (
  entity: Entity,
  id: SQL,
  level: number,
): SQL =>
  ancestorWalkSql(
    entity,
    id,
    sql`(array_agg(up."id" ORDER BY up.step DESC))[LEAST(${level}::int, count(*)::int)]`,
  );

/** The `entity` record `id`'s level (1 = top), or 0 for no record. */
export const hierarchyLevelSql = (entity: Entity, id: SQL): SQL<number> =>
  sql<number>`${ancestorWalkSql(entity, id, sql`count(*)::int`)}`;
