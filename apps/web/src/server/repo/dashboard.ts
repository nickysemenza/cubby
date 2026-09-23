import {
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { type SQL, and, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { imageSighting, importRun, plant } from "~/server/db/schema";
import { cookbookListWhere } from "~/server/repo/cookbook";
import { getDb } from "~/server/repo/database-helpers";
import { notDeleted } from "~/server/repo/database-helpers/query";
import { buildDeviceWhere } from "~/server/repo/device";
import { buildExpenseWhereClause } from "~/server/repo/expense/lookup";
import { buildFinancialAccountWhere } from "~/server/repo/financial-account";
import { buildFinancialTransactionWhere } from "~/server/repo/financial-transaction";
import {
  buildPlantingWhere,
  buildGardenEntryWhere,
} from "~/server/repo/garden";
import { buildImageWhere } from "~/server/repo/image";
import { buildIngredientListWhere } from "~/server/repo/ingredient/search";
import { buildInventoryWhere } from "~/server/repo/inventory/crud";
import { buildLedgerPartyWhere } from "~/server/repo/ledger-party";
import { buildLedgerTransferWhere } from "~/server/repo/ledger-transfer";
import { buildLocationWhere } from "~/server/repo/location/crud";
import { buildMealWhere } from "~/server/repo/meal/crud";
import { buildProductCategoryWhere } from "~/server/repo/product-category";
import { buildProductWhere } from "~/server/repo/product/crud";
import { buildProjectWhere } from "~/server/repo/project/lookup";
import { buildPurchaseWhereClause } from "~/server/repo/purchase";
import { buildRecipeWhere } from "~/server/repo/recipe/crud";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";
import { buildTaskWhere } from "~/server/repo/task/lookup";
import { buildVendorWhereClause } from "~/server/repo/vendor";
import { buildVendorAccountWhere } from "~/server/repo/vendor-account";
import { buildWishWhere } from "~/server/repo/wish";

/**
 * The WHERE behind each entity's homepage/footer/`/entities` total.
 *
 * Every entry calls that entity's OWN list where-builder with an empty filter
 * set, and that is stronger than it looks. A `productCountWhere()`
 * returning `notDeleted(product)` would still be the CLAIM "with no filters the
 * list's population is exactly this" — restated in a second place, checkable
 * only by a test. `buildProductWhere(db, {})` makes no claim; it IS the list's
 * population, computed by the list's own code, so nothing is left to drift.
 *
 * Arity is deliberately NOT normalized. Some builders are sync, some async,
 * some need `db` for id-set subqueries. `await` on a non-promise is free, and a
 * ceremonial unused `db` would be dead weight (Oxlint's `no-unused-vars` is
 * an error). The contract that IS uniform: exported, returns the complete
 * clause for the filters given, takes no caller-supplied predicate fragment,
 * and `{}` means unfiltered. TypeScript checks each thunk against the real
 * signature, so a drifted one is a compile error rather than a wrong number.
 *
 * `build-where.unit.test.ts` renders each `buildXWhere` to SQL and guards
 * against a thunk drifting from its list's own filter clause.
 */
type CountWhere = (db: Database) => SQL | undefined | Promise<SQL | undefined>;

const extraCountEntities = [
  "ledgerParty",
  "ledgerTransfer",
  "vendorAccount",
  "productCategory",
  "device",
] as const;
type LocalCountEntity = CountableEntity | (typeof extraCountEntities)[number];

const COUNT_WHERE = {
  product: (db) => buildProductWhere(db, {}),
  recipe: (db) => buildRecipeWhere(db, {}),
  ingredient: (db) => buildIngredientListWhere(db, {}),
  cookbook: () => cookbookListWhere(),
  location: (db) => buildLocationWhere(db, {}),
  inventory: (db) => buildInventoryWhere(db, {}),
  meal: (db) => buildMealWhere(db, {}),
  project: (db) => buildProjectWhere(db, {}),
  task: (db) => buildTaskWhere(db, {}),
  vendor: () => buildVendorWhereClause({}),
  purchase: (db) => buildPurchaseWhereClause(db, {}),
  expense: (db) => buildExpenseWhereClause(db, {}),
  financialAccount: () => buildFinancialAccountWhere({}),
  financialTransaction: (db) => buildFinancialTransactionWhere(db, {}),
  image: (db) => buildImageWhere(db, {}),
  wish: (db) => buildWishWhere(db, {}),
  plant: () => notDeleted(plant),
  planting: () => buildPlantingWhere(),
  gardenEntry: () => buildGardenEntryWhere(),
  importRun: () =>
    and(notDeleted(importRun), ne(importRun.trigger, "ephemeral")),
  imageSighting: () => notDeleted(imageSighting),
  ledgerParty: () => buildLedgerPartyWhere({}),
  ledgerTransfer: (db) => buildLedgerTransferWhere(db, {}),
  vendorAccount: () => buildVendorAccountWhere({}),
  productCategory: () => buildProductCategoryWhere({}),
  device: () => buildDeviceWhere({}),
} satisfies Record<LocalCountEntity, CountWhere>;

type EntityCounts = Record<LocalCountEntity, number>;

const localCountEntities = [
  ...countableEntities,
  ...extraCountEntities,
] as const;
const entityCountsSchema = z.record(z.enum(localCountEntities), z.number());

/**
 * Live row count for every local browser list, as one round-trip of cheap scalar
 * `COUNT(*)` subqueries — NO list fetch and NO USDA enrichment. Driven by the
 * manifest's homepage `countableEntities` plus five other local roster types;
 * one query (not N) because N parallel counts overran the per-request pool
 * (max 5). The homepage still reads only `countableEntities` from this result.
 * Filtered counts stay on the `*.list` procedures.
 */
export const getEntityCounts = async (db: Database): Promise<EntityCounts> => {
  // Resolved SEQUENTIALLY, not `Promise.all`. None of these builders queries
  // for an empty filter set — every id resolver short-circuits on empty input —
  // but if one ever starts, 16 concurrent awaits would re-create the pool
  // exhaustion this function exists to avoid. Serial degrades to slow; parallel
  // degrades to 500s.
  const whereByEntity = new Map<LocalCountEntity, SQL | undefined>();
  for (const entity of localCountEntities) {
    whereByEntity.set(entity, await COUNT_WHERE[entity](db));
  }

  // `buildImageWhere`'s WHERE clause only resolves against a FROM clause
  // that aliases `Image` to `"image"` (the Drizzle relational query API
  // resolves `image`'s FROM through its own registered alias, not the
  // table's raw SQL name — see the comment on `listImage` in
  // `~/server/repo/image`). `${table}` from a plain table reference embeds
  // correctly via `.from()`, but NOT via bare `sql` interpolation the way
  // this function needs — a raw `${aliasedTable(...)}` fragment renders only
  // the alias, not a full "Image" AS "image" clause — so `image`'s FROM
  // fragment is spelled out literally instead of going through
  // `SHORTCODE_TABLE`.
  const IMAGE_ALIASED_FROM = sql`"Image" AS "image"`;
  const countCol = (entity: LocalCountEntity): SQL => {
    const where = whereByEntity.get(entity);
    const from =
      entity === "image" ? IMAGE_ALIASED_FROM : sql`${SHORTCODE_TABLE[entity]}`;
    return where
      ? sql`(SELECT count(*)::int FROM ${from} WHERE ${where})`
      : sql`(SELECT count(*)::int FROM ${from})`;
  };

  const fragments = localCountEntities.map(
    (entity) => sql`${countCol(entity)} AS ${sql.identifier(entity)}`,
  );

  const res = await getDb(db).execute<Record<string, number>>(
    sql`SELECT ${sql.join(fragments, sql`, `)}`,
  );
  const row = res.rows[0];

  return entityCountsSchema.parse(
    Object.fromEntries(
      localCountEntities.map((entity) => [entity, row?.[entity] ?? 0]),
    ),
  );
};
