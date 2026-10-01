import type { ActorContext } from "@cubby/schemas/context";
import type { EntityId, ShortcodeFor } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  spendingCategoryOut,
  type SpendingCategoryCreateInput,
  type SpendingCategoryUpdateData,
  type SpendingCategoryFilters,
} from "@cubby/schemas/spending-category";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { spendingCategory } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import { logAuditEntry } from "./audit-log";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "./database-helpers";
import { listScaffold } from "./list";
import { hydrateListRead, type ListProjection } from "./list-projection";
import { completeListReader } from "./list-read-adapters";
import {
  createEntityCrud,
  defineRepository,
  asActor,
  onDb,
  listOn,
  listReadOn,
} from "./repository";
import { lookupEntityReferences, resolveOrThrow } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";

const scaffold = listScaffold("spendingCategory", spendingCategory);
type Row = typeof spendingCategory.$inferSelect;
const hydrate = (
  db: Database | DrizzleTransaction,
  rows: Row[],
  projection: ListProjection,
) =>
  hydrateListRead(db, "spendingCategory", rows, projection, {
    load: () =>
      lookupEntityReferences(
        db,
        "spendingCategory",
        rows.map((row) => row.parentId),
      ),
    mapRow: (row, { loaded: parents }) => ({
      ...row,
      id: parseShortcodeFor("spendingCategory", row.shortcode),
      parentId: row.parentId ? (parents.get(row.parentId)?.id ?? null) : null,
    }),
  });
const listRead = (
  db: Database,
  filters: SpendingCategoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    { hydrate: (rows, selected) => hydrate(db, rows, selected) },
  );
const list = completeListReader(spendingCategoryOut, listRead);
export const listSpendingCategories = list;
const crud = createEntityCrud({
  table: spendingCategory,
  entity: "spendingCategory",
  fetchById: async (db, id) =>
    (
      await unwrapDb(db)
        .select()
        .from(spendingCategory)
        .where(and(eq(spendingCategory.id, id), notDeleted(spendingCategory)))
        .limit(1)
    )[0],
  fromDB: async (db, row) =>
    spendingCategoryOut.parse((await hydrate(db, [row], { kind: "full" }))[0]),
  toUpdate: (
    data: Omit<SpendingCategoryUpdateData, "parentId"> & {
      parentId?: EntityId<"spendingCategory"> | null;
    },
  ) => buildPartialUpdateValues(data),
  auditUpdateFields: [
    "name",
    "aliases",
    "parentId",
    "evidenceExpectation",
    "productExpectation",
  ],
});
async function resolveParent(
  db: Database | DrizzleTransaction,
  code: ShortcodeFor<"spendingCategory"> | null | undefined,
  child?: EntityId<"spendingCategory">,
) {
  if (code === undefined || code === null) return code;
  const id = await resolveOrThrow(db, "spendingCategory", code);
  if (child) {
    const rows = await unwrapDb(db).execute(sql`WITH RECURSIVE parents AS (
      SELECT id, "parentId", ARRAY[id] AS path FROM "SpendingCategory" WHERE id = ${id} AND "deletedAt" IS NULL
      UNION ALL SELECT c.id, c."parentId", p.path || c.id FROM "SpendingCategory" c JOIN parents p ON c.id = p."parentId" WHERE c."deletedAt" IS NULL AND NOT c.id = ANY(p.path)
    ) SELECT id FROM parents WHERE id = ${child}`);
    if (rows.rows.length)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A spending category cannot be its own ancestor.",
      );
  }
  return id;
}
const create = async (
  db: Database,
  data: SpendingCategoryCreateInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const row = await insertWithShortcode(tx, "spendingCategory", {
      ...data,
      parentId: (await resolveParent(tx, data.parentId)) ?? null,
    });
    await logAuditEntry(tx, actor, {
      entityKind: "spendingCategory",
      entityId: row.id,
      action: "create",
    });
    return { output: await crud.getByID(tx, row.id), entityId: row.id };
  });
const update = async (
  db: Database,
  code: ShortcodeFor<"spendingCategory">,
  data: SpendingCategoryUpdateData,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const id = await resolveOrThrow(tx, "spendingCategory", code);
    return {
      output: await crud.update(
        tx,
        id,
        { ...data, parentId: await resolveParent(tx, data.parentId, id) },
        actor,
      ),
      entityId: id,
    };
  });
export const spendingCategoryRepository = defineRepository("spendingCategory", {
  lifecycle: {
    delete: {
      "SpendingCategory.parentId": {
        code: "block-children",
        effect: "block",
        description: "Reparent child categories before deleting their parent.",
      },
      "ProductCategory.spendingCategoryId": {
        code: "block-product-mappings",
        effect: "block",
        description:
          "Update Product Category spending mappings before deleting their target.",
      },
      "Vendor.defaultSpendingCategoryId": {
        code: "block-vendor-defaults",
        effect: "block",
        description:
          "Update merchant spending defaults before deleting their target.",
      },
      "Purchase.spendingCategoryId": {
        code: "block-purchases",
        effect: "block",
        description:
          "Reclassify purchases before deleting their spending category.",
      },
      "Expense.spendingCategoryId": {
        code: "block-expenses",
        effect: "block",
        description:
          "Reclassify expenses before deleting their spending category.",
      },
      "FinancialTransaction.spendingCategoryId": {
        code: "block-transactions",
        effect: "block",
        description:
          "Reclassify transactions before deleting their spending category.",
      },
    },
  },
  get: onDb(crud.getByShortcode),
  list: listOn(list),
  listRead: listReadOn(listRead),
  create: asActor(create),
  update: asActor(update),
});
