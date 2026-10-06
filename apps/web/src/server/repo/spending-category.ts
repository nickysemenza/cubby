import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { EntityId, ShortcodeFor } from "@cubby/schemas/identifiers";
import {
  ENTITY_NOT_FOUND_REASON,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  spendingCategoryOut,
  type SpendingCategoryCreateInput,
  type SpendingCategoryUpdateData,
  type SpendingCategoryFilters,
} from "@cubby/schemas/spending-category";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { productCategory } from "~/server/db/schema";
import { spendingCategory } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import { logAuditEntry } from "./audit-log";
import { loadCategoryConnections } from "./category-connections";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "./database-helpers";
import { effectiveExpenseSpendingCategorySql } from "./expense-category-resolution";
import { validateProductPolicy } from "./inheritance-validation";
import { listScaffold } from "./list";
import { hydrateListRead, type ListProjection } from "./list-projection";
import { completeListReader } from "./list-read-adapters";
import { finalizeMerge, resolveMergeTargets } from "./merge/core";
import { applyMergePolicy } from "./removal/dispositions";
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
import { assertReviewedSpendingClassification } from "./spending-classification-review-authorization";

const scaffold = listScaffold("spendingCategory", spendingCategory);
export const buildSpendingCategoryWhere = scaffold.where;
type Row = typeof spendingCategory.$inferSelect;
const hydrate = (
  db: Database | DrizzleTransaction,
  rows: Row[],
  projection: ListProjection,
) =>
  hydrateListRead(db, "spendingCategory", rows, projection, {
    load: () =>
      Promise.all([
        loadCategoryConnections(db),
        unwrapDb(db)
          .select({
            id: productCategory.id,
            code: productCategory.shortcode,
            emoji: productCategory.emoji,
          })
          .from(productCategory)
          .where(notDeleted(productCategory)),
        lookupEntityReferences(
          db,
          "spendingCategory",
          rows.map((row) => row.parentId),
        ),
      ]),
    mapRow: (row, { loaded: [mappings, categories, parents] }) => ({
      ...row,
      id: parseShortcodeFor("spendingCategory", row.shortcode),
      parentId: row.parentId ? (parents.get(row.parentId)?.id ?? null) : null,
      productCategories: categories.flatMap((category) => {
        const mapping = mappings.get(category.id);
        return mapping?.category?.id === row.shortcode
          ? [
              {
                id: parseShortcodeFor("productCategory", category.code),
                name: `${mapping.path}${mapping.state === "inherited" ? " (inherited)" : ""}`,
                emoji: category.emoji,
                inherited: mapping.state === "inherited",
              },
            ]
          : [];
      }),
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
/** The category and every live ancestor above it. */
async function selfAndAncestors(
  db: Database | DrizzleTransaction,
  id: EntityId<"spendingCategory">,
): Promise<Set<string>> {
  const rows = await unwrapDb(db).execute(sql`WITH RECURSIVE parents AS (
      SELECT id, "parentId", ARRAY[id] AS path FROM "SpendingCategory" WHERE id = ${id} AND "deletedAt" IS NULL
      UNION ALL SELECT c.id, c."parentId", p.path || c.id FROM "SpendingCategory" c JOIN parents p ON c.id = p."parentId" WHERE c."deletedAt" IS NULL AND NOT c.id = ANY(p.path)
    ) SELECT id FROM parents`);
  return new Set(
    z
      .array(z.object({ id: z.string() }))
      .parse(rows.rows)
      .map((row) => row.id),
  );
}
const ownAncestor = () =>
  createAppError(
    "CONSTRAINT_VIOLATION",
    "A spending category cannot be its own ancestor.",
  );
async function resolveParent(
  db: Database | DrizzleTransaction,
  code: ShortcodeFor<"spendingCategory"> | null | undefined,
  child?: EntityId<"spendingCategory">,
) {
  if (code === undefined || code === null) return code;
  const id = await resolveOrThrow(db, "spendingCategory", code);
  if (child && (await selfAndAncestors(db, id)).has(child)) throw ownAncestor();
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
    const output = await crud.update(
      tx,
      id,
      { ...data, parentId: await resolveParent(tx, data.parentId, id) },
      actor,
    );
    // Moving a category to `not_allowed` is refused while any Expense in it
    // still links a Product; the error lists them.
    if (data.productExpectation === "not_allowed")
      await validateProductPolicy(tx);
    return { output, entityId: id };
  });
/**
 * Merge is keeper-wins: every reference moves to the keeper and children
 * reparent under it. The keeper's own name and expectations stay unchanged.
 */
const SPENDING_CATEGORY_MERGE_EDGE_POLICY = {
  "SpendingCategory.parentId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Child categories move under the surviving category.",
  },
  "ProductCategory.spendingCategoryId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Product Category mappings move to the surviving category.",
  },
  "Vendor.defaultSpendingCategoryId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Merchant spending defaults move to the surviving category.",
  },
  "Purchase.spendingCategoryId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Purchase defaults move to the surviving category.",
  },
  "Expense.spendingCategoryId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Explicit Expense categories move to the surviving category.",
  },
  "FinancialTransaction.spendingCategoryId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Transaction categories move to the surviving category.",
  },
} as const satisfies IncomingEdgePolicy<
  "spendingCategory",
  OperationDisposition
>;

const spendingCategoryCode = ENTITY_SCHEMA_BINDINGS.spendingCategory.id;
const mergeInput = z.object({
  keepId: spendingCategoryCode,
  mergeIds: z.array(spendingCategoryCode).min(1),
});
const mergeSummary = z.object({
  deletedIds: z.array(spendingCategoryCode),
  merged: z.number().int().nonnegative(),
  repointed: z.record(z.string(), z.number().int().nonnegative()),
});

/** Whether any live Expense's effective category is one of the losers. */
async function reclassifiesExpenses(
  tx: DrizzleTransaction,
  loserIds: readonly EntityId<"spendingCategory">[],
): Promise<boolean> {
  const rows = await unwrapDb(tx).execute(sql`
    SELECT 1 FROM "Expense" e
    WHERE e."deletedAt" IS NULL
      AND ${effectiveExpenseSpendingCategorySql("e")} IN (${sql.join(
        loserIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    LIMIT 1`);
  return rows.rows.length > 0;
}

/**
 * Locks the merge's categories and refuses one that is no longer live. Run it
 * as a merge transaction's first statement: FK writes that reference a locked
 * category wait for the merge. A writer that resolved a loser earlier can still
 * commit a reference after the merge; the referential-liveness detector reports
 * it and `repointMergedReferences` moves it to the survivor.
 */
export async function lockLiveSpendingCategories(
  db: Database | DrizzleTransaction,
  ids: readonly EntityId<"spendingCategory">[],
): Promise<void> {
  const unique = uniq(ids);
  const live = await unwrapDb(db)
    .select({ id: spendingCategory.id })
    .from(spendingCategory)
    .where(
      and(inArray(spendingCategory.id, unique), notDeleted(spendingCategory)),
    )
    .orderBy(spendingCategory.id)
    .for("update");
  if (live.length !== unique.length)
    throw createAppError(
      ENTITY_NOT_FOUND_REASON.spendingCategory,
      "A spending category in this merge was deleted; reload and choose live categories.",
    );
}

async function mergeSpendingCategories(
  db: Database,
  input: z.infer<typeof mergeInput>,
  actor: ActorContext,
) {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "spendingCategory",
    ...input,
  });
  return withTransaction(db, async (tx) => {
    await lockLiveSpendingCategories(tx, [keepId, ...loserIds]);
    // A loser above the keeper would reparent the keeper's own chain under it.
    const lineage = await selfAndAncestors(tx, keepId);
    if (loserIds.some((id) => lineage.has(id))) throw ownAncestor();
    // Moving Expense history needs the reviewed preview/apply path
    // (`spendingCategoryMerge`), which runs this same merge.
    if (await reclassifiesExpenses(tx, loserIds))
      assertReviewedSpendingClassification(tx);
    const repointed = await applyMergePolicy(tx, {
      entity: "spendingCategory",
      policy: SPENDING_CATEGORY_MERGE_EDGE_POLICY,
      keepId,
      loserIds,
      liveOnly: false,
    });
    const { removed } = await finalizeMerge(tx, {
      entity: "spendingCategory",
      table: spendingCategory,
      keepId,
      loserIds,
      removal: "soft",
      actor,
      survivorChanges: { mergedFrom: { from: null, to: loserIds } },
    });
    // Lines that moved into a `not_allowed` keeper cannot keep a Product.
    await validateProductPolicy(tx);
    return mergeSummary.parse({
      deletedIds: uniq(input.mergeIds),
      merged: removed,
      repointed,
    });
  });
}

export const spendingCategoryRepository = defineRepository("spendingCategory", {
  lifecycle: {
    merge: SPENDING_CATEGORY_MERGE_EDGE_POLICY,
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
  merge: {
    input: mergeInput,
    output: z.object({ spendingCategory: spendingCategoryOut, mergeSummary }),
    item: (output) => output.spendingCategory,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const summary = await mergeSpendingCategories(
        ctx.db,
        input,
        ctx.actorContext,
      );
      const keeper = await crud.getByShortcode(ctx.db, input.keepId);
      if (!keeper)
        throw new Error("Merged Spending Category keeper disappeared");
      return {
        output: { spendingCategory: keeper, mergeSummary: summary },
        entityId: null,
        detachedImageKeys: [],
      };
    },
  },
});
