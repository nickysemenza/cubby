import {
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { and, isNull, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  image,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// The table + count predicate for every countable entity. `satisfies
// Record<CountableEntity, …>` ties this to the entity manifest: adding a
// countable entity is a type error here until it's wired up. Each WHERE mirrors
// the corresponding `*List` repo's base filter for an empty filter set so the
// totals match the list pages exactly:
//   - ingredient also excludes recipe-pointer rows (`recipeId IS NULL`).
//   - image is hard-deleted in practice (repo/image.ts does a row DELETE), so
//     `deletedAt` is never set and `notDeleted(image)` returns the same rows
//     `imageList` counts — kept for the soft-delete convention.
const COUNT_SOURCES = {
  product: { table: product, where: notDeleted(product) },
  recipe: { table: recipe, where: notDeleted(recipe) },
  ingredient: {
    table: ingredient,
    where: and(isNull(ingredient.recipeId), notDeleted(ingredient)),
  },
  cookbook: { table: cookbook, where: notDeleted(cookbook) },
  location: { table: location, where: notDeleted(location) },
  inventory: { table: inventoryEntry, where: notDeleted(inventoryEntry) },
  meal: { table: meal, where: notDeleted(meal) },
  project: { table: project, where: notDeleted(project) },
  task: { table: task, where: notDeleted(task) },
  vendor: { table: vendor, where: notDeleted(vendor) },
  purchase: { table: purchase, where: notDeleted(purchase) },
  expense: { table: expense, where: notDeleted(expense) },
  financialAccount: {
    table: financialAccount,
    where: notDeleted(financialAccount),
  },
  financialTransaction: {
    table: financialTransaction,
    where: notDeleted(financialTransaction),
  },
  image: { table: image, where: notDeleted(image) },
} satisfies Record<CountableEntity, { table: PgTable; where: SQL | undefined }>;

type EntityCounts = Record<CountableEntity, number>;

/**
 * Live row count for every countable entity, as one round-trip of cheap scalar
 * `COUNT(*)` subqueries — NO list fetch and NO USDA enrichment. Driven by the
 * manifest's `countableEntities`; one query (not N) because N parallel counts
 * overran the per-request pool (max 5). Powers the homepage stat strip + footer
 * + the `/entities` page. Filtered counts stay on the `*.list` procedures.
 */
export const getEntityCounts = async (db: Database): Promise<EntityCounts> => {
  const countCol = (table: PgTable, where: SQL | undefined): SQL =>
    where
      ? sql`(SELECT count(*)::int FROM ${table} WHERE ${where})`
      : sql`(SELECT count(*)::int FROM ${table})`;

  const fragments = countableEntities.map(
    (entity) =>
      sql`${countCol(COUNT_SOURCES[entity].table, COUNT_SOURCES[entity].where)} AS ${sql.identifier(entity)}`,
  );

  const res = await getDb(db).execute<Record<string, number>>(
    sql`SELECT ${sql.join(fragments, sql`, `)}`,
  );
  const row = res.rows[0];

  return Object.fromEntries(
    countableEntities.map((entity) => [entity, row?.[entity] ?? 0]),
  ) as EntityCounts;
};
