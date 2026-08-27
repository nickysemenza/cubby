import {
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { and, isNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  cookbook,
  image,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  recipe,
  task,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { buildExpenseWhereClause } from "~/server/repo/expense/lookup";
import { buildFinancialAccountWhere } from "~/server/repo/financial-account";
import { buildFinancialTransactionWhere } from "~/server/repo/financial-transaction";
import { stockOnly } from "~/server/repo/inventory/placement";
import { buildPurchaseWhereClause } from "~/server/repo/purchase";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";
import { buildVendorWhereClause } from "~/server/repo/vendor";
import { buildWishWhere } from "~/server/repo/wish";

/**
 * The WHERE behind each entity's homepage/footer/`/entities` total.
 *
 * Every migrated entry calls that entity's OWN list where-builder with an empty
 * filter set, and that is stronger than it looks. A `productCountWhere()`
 * returning `notDeleted(product)` would still be the CLAIM "with no filters the
 * list's population is exactly this" — restated in a second place, checkable
 * only by a test. `buildProductWhere(db, {})` makes no claim; it IS the list's
 * population, computed by the list's own code, so nothing is left to drift.
 *
 * Arity is deliberately NOT normalized. Some builders are sync, some async,
 * some need `db` for id-set subqueries. `await` on a non-promise is free, and a
 * ceremonial unused `db` would be dead weight (biome's `noUnusedVariables` is
 * an error). The contract that IS uniform: exported, returns the complete
 * clause for the filters given, takes no caller-supplied predicate fragment,
 * and `{}` means unfiltered. TypeScript checks each thunk against the real
 * signature, so a drifted one is a compile error rather than a wrong number.
 *
 * The remaining literal thunks are the un-migrated tail. They are written out
 * here rather than hidden in a record that looks finished, so what is left to
 * do stays visible; `filter-application.integration.test.ts` proves each one
 * still matches its list in the meantime.
 */
type CountWhere = (db: Database) => SQL | undefined | Promise<SQL | undefined>;

const COUNT_WHERE = {
  product: () => notDeleted(product),
  recipe: () => notDeleted(recipe),
  ingredient: () => and(isNull(ingredient.recipeId), notDeleted(ingredient)),
  cookbook: () => notDeleted(cookbook),
  location: () => notDeleted(location),
  inventory: () => and(notDeleted(inventoryEntry), stockOnly()),
  meal: () => notDeleted(meal),
  project: () => notDeleted(project),
  task: () => notDeleted(task),
  vendor: () => buildVendorWhereClause({}),
  purchase: (db) => buildPurchaseWhereClause(db, {}),
  expense: (db) => buildExpenseWhereClause(db, {}),
  financialAccount: () => buildFinancialAccountWhere({}),
  financialTransaction: (db) => buildFinancialTransactionWhere(db, {}),
  image: () => notDeleted(image),
  wish: (db) => buildWishWhere(db, {}),
} satisfies Record<CountableEntity, CountWhere>;

type EntityCounts = Record<CountableEntity, number>;

/**
 * Live row count for every countable entity, as one round-trip of cheap scalar
 * `COUNT(*)` subqueries — NO list fetch and NO USDA enrichment. Driven by the
 * manifest's `countableEntities`; one query (not N) because N parallel counts
 * overran the per-request pool (max 5). Powers the homepage stat strip + footer
 * + the `/entities` page. Filtered counts stay on the `*.list` procedures.
 */
export const getEntityCounts = async (db: Database): Promise<EntityCounts> => {
  // Resolved SEQUENTIALLY, not `Promise.all`. None of these builders queries
  // for an empty filter set — every id resolver short-circuits on empty input —
  // but if one ever starts, 16 concurrent awaits would re-create the pool
  // exhaustion this function exists to avoid. Serial degrades to slow; parallel
  // degrades to 500s.
  const whereByEntity = {} as Record<CountableEntity, SQL | undefined>;
  for (const entity of countableEntities) {
    whereByEntity[entity] = await COUNT_WHERE[entity](db);
  }

  const countCol = (entity: CountableEntity): SQL => {
    const where = whereByEntity[entity];
    const table = SHORTCODE_TABLE[entity];
    return where
      ? sql`(SELECT count(*)::int FROM ${table} WHERE ${where})`
      : sql`(SELECT count(*)::int FROM ${table})`;
  };

  const fragments = countableEntities.map(
    (entity) => sql`${countCol(entity)} AS ${sql.identifier(entity)}`,
  );

  const res = await getDb(db).execute<Record<string, number>>(
    sql`SELECT ${sql.join(fragments, sql`, `)}`,
  );
  const row = res.rows[0];

  return Object.fromEntries(
    countableEntities.map((entity) => [entity, row?.[entity] ?? 0]),
  ) as EntityCounts;
};
