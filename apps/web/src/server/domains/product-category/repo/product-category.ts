import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  FieldResolution,
  FieldResolutions,
} from "@cubby/schemas/field-resolution";
import {
  type ProductCategoryId,
  type ProductCategoryShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  type ProductCategoryCreateInput,
  type ProductCategoryFeature,
  type ProductCategoryFilters,
  type ProductCategoryOut,
  type ProductCategorySummary,
  type ProductCategoryUpdateData,
  productCategoryOut,
} from "@cubby/schemas/product-category";
import {
  PRODUCT_CATEGORY_MAX_DEPTH as MAX_PRODUCT_CATEGORY_DEPTH,
  productCategoryFeature,
  productCategorySummary,
} from "@cubby/schemas/product-category-fields";
import type { categoryMappingSchema } from "@cubby/schemas/spending-classification";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  effectiveFieldSql,
  inheritedFieldSql,
  inheritedSourceSql,
} from "~/server/db/computed/effective-field";
import {
  type CategoryStockTracking,
  categoryStockTrackingSql,
} from "~/server/db/computed/product-category-sql";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { buildPartialUpdateValues } from "~/server/db/helpers";
import { notDeleted, unwrapDb, withTransaction } from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { product, productCategory } from "~/server/db/schema";
import { resolveStockTrackingField } from "~/server/domains/inventory/repo/stock-tracking";
import { categoryMappingSql } from "~/server/domains/product-category/repo/category-connections";
import { loadCategoryConnections } from "~/server/domains/product-category/repo/category-connections";
import { assertReviewedSpendingClassification } from "~/server/domains/spending-category/repo/spending-classification-review-authorization";
import { categoryPathLabel } from "~/server/entity-kernel/repo/detail-display-labels";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import {
  createEntityCrud,
  createEntityRowFetcher,
} from "~/server/entity-kernel/repo/repository";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

const PRODUCT_CATEGORY_DELETE_EDGE_POLICY = {
  "ProductCategory.parentId": {
    code: "block-child-categories",
    effect: "block",
    description:
      "Move or delete child categories before deleting their parent.",
  },
  "Product.categoryId": {
    code: "block-products",
    effect: "block",
    description: "Products retain their selected category until reassigned.",
  },
  "PhotoGroupProposal.productCreateCategoryId": {
    code: "clear-proposal-category",
    effect: "detach",
    description:
      "Deleting a category clears it from a proposed photo group's new Product, which is then created unclassified.",
  },
} as const satisfies IncomingEdgePolicy<
  "productCategory",
  OperationDisposition
>;

type CategoryRow = typeof productCategory.$inferSelect;

type CategoryFacts = {
  feature: string | null;
  featureFallback: string | null;
  featureSource: { id: string; title: string } | null;
  stockFallback: CategoryStockTracking | null;
};

type CategoryPathRow = {
  root: string;
  path: Array<{ id: string; name: string }>;
};

// The raw root name: the list's RQB data query and its count read the same
// unaliased table.
const categoryMapping = () =>
  categoryMappingSql(sql.raw('"ProductCategory"."id"'));

const scaffold = listScaffold("productCategory", productCategory, {
  derived: {
    needsClassification: sql`(${categoryMapping()}->>'state' = 'unmapped')`,
  },
});

const parseFeature = (feature: string | null): ProductCategoryFeature | null =>
  productCategoryFeature.nullable().parse(feature);

/**
 * Each category's inherited facts from the declared chains
 * (`resolution.inherit`): its effective feature, the feature and stock
 * decision it would inherit, and the categories that made them.
 */
const inheritedFactsFor = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, CategoryFacts>> => {
  if (ids.length === 0) return new Map();
  const featureSource = inheritedSourceSql("productCategory", "feature", "c");
  const rows = await unwrapDb(db).execute<CategoryFacts & { id: string }>(sql`
    SELECT c."id",
      ${effectiveFieldSql("productCategory", "feature", "c")} AS feature,
      ${inheritedFieldSql("productCategory", "feature", "c")} AS "featureFallback",
      (SELECT json_build_object('id', s."shortcode", ${"title"}::text, s."name") FROM "ProductCategory" s
        WHERE s."id" = (${featureSource}->>'id')::uuid) AS "featureSource",
      ${categoryStockTrackingSql(sql`c."id"`, { inherited: true })} AS "stockFallback"
    FROM "ProductCategory" c
    WHERE c."id" IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  return new Map(rows.rows.map(({ id, ...facts }) => [id, facts]));
};

const pathsFor = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, CategoryPathRow["path"]>> => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db).execute<CategoryPathRow>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT c."id" AS root, c."id", c."parentId", c."shortcode", c."name", 0 AS depth,
             ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."id" IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND c."deletedAt" IS NULL
      UNION ALL
      SELECT a.root, parent."id", parent."parentId", parent."shortcode", parent."name", a.depth + 1,
             a.visited || parent."id"
      FROM ancestors a
      JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL
        AND a.depth < ${MAX_PRODUCT_CATEGORY_DEPTH - 1}
        AND NOT parent."id" = ANY(a.visited)
    )
    SELECT root, json_agg(json_build_object('id', shortcode, 'name', name) ORDER BY depth DESC) AS path
    FROM ancestors
    GROUP BY root
  `);
  return new Map(rows.rows.map((row) => [row.root, row.path]));
};

/**
 * Live products in each category's subtree. One recursive walk seeded by
 * every requested id, bounded by the category depth writes enforce and by
 * the visited-array guard `hierarchyDescendantsSql` also uses, so a stored
 * cycle cannot make a read loop.
 */
const productCountsFor = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db).execute<{ root: string; count: number }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT c."id" AS root, c."id", ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."id" IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND c."deletedAt" IS NULL
      UNION ALL
      SELECT d.root, child."id", d.visited || child."id"
      FROM descendants d
      JOIN "ProductCategory" child ON child."parentId" = d."id"
      WHERE child."deletedAt" IS NULL
        AND array_length(d.visited, 1) < ${MAX_PRODUCT_CATEGORY_DEPTH}
        AND NOT child."id" = ANY(d.visited)
    )
    SELECT d.root, count(p."id")::int AS count
    FROM descendants d
    JOIN "Product" p ON p."categoryId" = d."id" AND p."deletedAt" IS NULL
    GROUP BY d.root
  `);
  return new Map(rows.rows.map((row) => [row.root, row.count]));
};

/** Keep stored decisions separate from the live ancestor fallback. */
/** The nearest mapped ancestor (or this category) supplies the spending
 * category; a direct mapping or a block is this category's own decision. */
const spendingCategoryResolution = (
  mapping: z.infer<typeof categoryMappingSchema> | undefined,
): FieldResolution => {
  const value = mapping?.category?.id ?? null;
  const own = mapping?.state === "direct" || mapping?.state === "blocked";
  return {
    mode:
      mapping?.state === "blocked"
        ? "none"
        : mapping?.state === "direct"
          ? "explicit"
          : "inherit",
    storedValue: own ? value : null,
    value,
    fallbackValue: mapping?.state === "inherited" ? value : null,
    source:
      mapping?.state === "inherited" && mapping.source
        ? mapping.source.name
        : own
          ? "Set on this category"
          : "No mapped ancestor",
    sourceEntity:
      mapping?.state === "inherited" && mapping.source
        ? {
            entityKind: "productCategory",
            entityId: mapping.source.id,
            name: mapping.source.name,
          }
        : null,
    matchesFallback: false,
    canReset: false,
  };
};

const categoryResolutions = (
  row: CategoryRow,
  facts: CategoryFacts | undefined,
): FieldResolutions => {
  const storedValue = parseFeature(row.feature);
  const fallbackValue = parseFeature(facts?.featureFallback ?? null);
  const source = facts?.featureSource ?? null;
  const value = storedValue ?? fallbackValue;
  return {
    feature: {
      mode: storedValue === null ? "inherit" : "explicit",
      storedValue,
      value,
      fallbackValue,
      source:
        storedValue !== null
          ? "Permanent feature binding"
          : (source?.title ?? "No ancestor feature"),
      sourceEntity:
        storedValue === null && source
          ? {
              entityKind: "productCategory",
              entityId: source.id,
              name: source.title,
            }
          : null,
      matchesFallback: value === fallbackValue,
      canReset: false,
    },
    stockTracked: resolveStockTrackingField(
      row.stockTracked,
      facts?.stockFallback ?? null,
      "category decision",
    ),
  };
};

const categoryRead = {
  references: {
    spendingCategoryId: {
      kind: "lookup",
      emoji: "spendingCategoryEmoji",
      missing: "null",
    },
  },
  bindings: (bind) => {
    const mappings = bind.batch(({ db, rows }) =>
      loadCategoryConnections(
        db,
        rows.map((row) => row.id),
      ),
    );
    const paths = bind.batch(({ db, rows }) =>
      pathsFor(
        db,
        rows.map((row) => row.id),
      ),
    );
    const counts = bind.batch(({ db, rows }) =>
      productCountsFor(
        db,
        rows.map((row) => row.id),
      ),
    );
    return [
      bind(productCategoryOut.pick({ feature: true }), (row) => ({
        feature: parseFeature(row.feature),
      })),
      bind
        .batch(async ({ db, rows }) => {
          const resolved = await unwrapDb(db)
            .select({ id: productCategory.id, effectiveFeature })
            .from(productCategory)
            .where(
              inArray(
                productCategory.id,
                rows.map((row) => row.id),
              ),
            );
          return new Map(
            resolved.map((row) => [row.id, parseFeature(row.effectiveFeature)]),
          );
        })
        .fields(
          productCategoryOut.pick({ effectiveFeature: true }),
          (row, loaded) => ({
            effectiveFeature: loaded.get(row.id) ?? null,
          }),
        ),
      mappings.fields(
        productCategoryOut.pick({
          spendingCategoryMapping: true,
          effectiveSpendingCategory: true,
        }),
        (row, loaded) => ({
          spendingCategoryMapping: loaded.get(row.id),
          effectiveSpendingCategory: mappedCategoryIdentity(loaded.get(row.id)),
        }),
      ),
      paths.fields(
        productCategoryOut.pick({ path: true, pathLabel: true }),
        (row, loaded) => {
          const path = loaded.get(row.id) ?? [];
          return {
            path: path.map((part) => ({
              id: parseShortcodeFor("productCategory", part.id),
              name: part.name,
            })),
            pathLabel: categoryPathLabel(path),
          };
        },
      ),
      // Field resolution depends on the same connection facts as core mappings.
      bind
        .batch(async (page) => ({
          facts: await inheritedFactsFor(
            page.db,
            page.rows.map((row) => row.id),
          ),
          mappings: await mappings.load(page),
        }))
        .fields(
          productCategoryOut.pick({ fieldResolutions: true }),
          (row, loaded) => ({
            fieldResolutions: {
              ...categoryResolutions(row, loaded.facts.get(row.id)),
              effectiveSpendingCategory: spendingCategoryResolution(
                loaded.mappings.get(row.id),
              ),
            },
          }),
        ),
      counts.fields(
        productCategoryOut.pick({ productCount: true }),
        (row, loaded) => ({ productCount: loaded.get(row.id) ?? 0 }),
      ),
    ];
  },
} satisfies ListReadOptions<CategoryRow>;
const hydrateRead = (
  db: Database | DrizzleTransaction,
  rows: CategoryRow[],
  projection: ListProjection,
) =>
  listReadPlan<CategoryRow>("productCategory", categoryRead).read(
    db,
    rows,
    projection,
  );
function mappedCategoryIdentity(
  mapping: z.infer<typeof categoryMappingSchema> | undefined,
) {
  if (!mapping?.category) return null;
  const suffix =
    mapping.state === "inherited"
      ? ` (inherited from ${mapping.source?.name})`
      : "";
  return { ...mapping.category, name: `${mapping.category.name}${suffix}` };
}

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: CategoryRow[],
): Promise<ProductCategoryOut[]> =>
  (await hydrateRead(db, rows, { kind: "full" })).map((row) =>
    productCategoryOut.parse(row),
  );

export const buildProductCategoryWhere = (filters: ProductCategoryFilters) =>
  scaffold.where(filters);

export const listProductCategoriesRead = (
  db: Database,
  filters: ProductCategoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      where: buildProductCategoryWhere(filters),
      read: categoryRead,
    },
  );

export const listProductCategories = completeListReader(
  productCategoryOut,
  listProductCategoriesRead,
);

const crud = createEntityCrud({
  table: productCategory,
  entity: "productCategory",
  fetchById: createEntityRowFetcher(productCategory),
  fromDB: async (db, row: CategoryRow) => (await hydrate(db, [row]))[0]!,
  toUpdate: (values: Partial<typeof productCategory.$inferInsert>) => values,
  auditUpdateFields: [...entityFieldModels.productCategory.audit],
});

export const getProductCategoryByShortcode = crud.getByShortcode;

const cleanAliases = (aliases: string[]) => [
  ...new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
];

export const assertValidParent = async (
  db: Database | DrizzleTransaction,
  id: ProductCategoryId | null,
  parentId: ProductCategoryId | null,
) => {
  if (!parentId) return;
  if (id === parentId)
    throw new Error("A product category cannot be its own parent");

  let subtreeDepth = 1;
  if (id) {
    const descendants = await unwrapDb(db).execute<{
      id: ProductCategoryId;
      depth: number;
    }>(sql`
      WITH RECURSIVE descendants AS (
        SELECT c."id", ARRAY[c."id"] AS visited FROM "ProductCategory" c WHERE c."id" = ${id}::uuid
        UNION ALL
        SELECT child."id", d.visited || child."id"
        FROM descendants d JOIN "ProductCategory" child ON child."parentId" = d."id"
        WHERE child."deletedAt" IS NULL AND array_length(d.visited, 1) < ${MAX_PRODUCT_CATEGORY_DEPTH}
          AND NOT child."id" = ANY(d.visited)
      ) SELECT "id", array_length(visited, 1) AS depth FROM descendants
    `);
    if (descendants.rows.some((row) => row.id === parentId)) {
      throw new Error(
        "A product category cannot move below one of its descendants",
      );
    }
    subtreeDepth = Math.max(...descendants.rows.map((row) => row.depth));
  }

  const ancestors = await unwrapDb(db).execute<{ id: ProductCategoryId }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", ARRAY[c."id"] AS visited FROM "ProductCategory" c WHERE c."id" = ${parentId}::uuid
      UNION ALL
      SELECT parent."id", parent."parentId", a.visited || parent."id"
      FROM ancestors a JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND array_length(a.visited, 1) < ${MAX_PRODUCT_CATEGORY_DEPTH}
        AND NOT parent."id" = ANY(a.visited)
    ) SELECT "id" FROM ancestors
  `);
  if (ancestors.rows.length + subtreeDepth > MAX_PRODUCT_CATEGORY_DEPTH) {
    throw new Error(
      `Product categories allow at most ${MAX_PRODUCT_CATEGORY_DEPTH} levels`,
    );
  }
};

/**
 * A hierarchy change is transactional: it must leave every assigned Product
 * admissible in its existing category and retain every effective trade. Product
 * classification and inheritance own the cross-domain checks; late imports
 * avoid their category-resolution cycles.
 */
const assertAffectedProductsRemainAdmissible = async (
  tx: DrizzleTransaction,
  categoryId: ProductCategoryId,
) => {
  const products = await unwrapDb(tx)
    .select({ id: product.id, categoryId: product.categoryId })
    .from(product)
    .where(
      and(
        notDeleted(product),
        sql`${product.categoryId} IN ${hierarchyDescendantsSql("productCategory", [categoryId])}`,
      ),
    );
  const { assertProductCategoryChange } =
    await import("~/server/domains/product/repo/classification");
  for (const item of products) {
    if (!item.categoryId) continue;
    const resolved = await assertProductCategoryChange(
      tx,
      parseEntityId("product", item.id),
      parseEntityId("productCategory", item.categoryId),
    );
    if (resolved !== item.categoryId) {
      throw new Error(
        "This category change would invalidate an assigned Product",
      );
    }
  }
  const { validateLiveInheritedPolicies } =
    await import("~/server/generic/inheritance/repo/inheritance-validation");
  await validateLiveInheritedPolicies(tx, {
    kind: "productCategory",
    ids: [categoryId],
  });
};

export const createProductCategory = defineMutationWriter({
  entity: "productCategory",
  read: async (
    receipt: MutationReceipt<"productCategory">,
    db: Database,
    _data: ProductCategoryCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await crud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: ProductCategoryCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) => {
      const parentId = data.parentId
        ? await resolveOrThrow(tx, "productCategory", data.parentId)
        : null;
      await assertValidParent(tx, null, parentId);
      const spendingCategoryId = data.spendingCategoryId
        ? await resolveOrThrow(tx, "spendingCategory", data.spendingCategoryId)
        : null;
      if (
        (data.spendingCategoryMode === "mapped") !==
        (spendingCategoryId !== null)
      )
        throw new Error(
          "Mapped requires a spending category; inherit and blocked require none",
        );
      const row = await insertWithShortcode(tx, "productCategory", {
        name: data.name.trim(),
        aliases: cleanAliases(data.aliases),
        description: data.description,
        parentId,
        sortOrder: data.sortOrder,
        feature: data.feature,
        stockTracked: data.stockTracked,
        spendingCategoryMode: data.spendingCategoryMode,
        spendingCategoryId,
      });
      await logAuditEntry(tx, actor, {
        entityKind: "productCategory",
        entityId: row.id,
        action: "create",
      });
      return parseEntityId("productCategory", row.id);
    });
    return readOutput({ entityId: id });
  },
});

export const updateProductCategory = defineMutationWriter({
  entity: "productCategory",
  read: async (
    receipt: MutationReceipt<"productCategory">,
    db: Database,
    _shortcode: ProductCategoryShortcode,
    _data: ProductCategoryUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await crud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: ProductCategoryShortcode,
    data: ProductCategoryUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "productCategory", shortcode);
    if (
      data.spendingCategoryMode !== undefined ||
      data.spendingCategoryId !== undefined
    ) {
      const [current] = await unwrapDb(db)
        .select({
          mode: productCategory.spendingCategoryMode,
          target: productCategory.spendingCategoryId,
        })
        .from(productCategory)
        .where(and(eq(productCategory.id, id), notDeleted(productCategory)))
        .limit(1);
      if (!current) throw new Error("Product category not found");
      const target =
        data.spendingCategoryId === undefined
          ? current.target
          : data.spendingCategoryId === null
            ? null
            : await resolveOrThrow(
                db,
                "spendingCategory",
                data.spendingCategoryId,
              );
      if (
        (data.spendingCategoryMode ?? current.mode) !== current.mode ||
        target !== current.target
      ) {
        const affected = await unwrapDb(db)
          .execute(sql`SELECT 1 FROM "Expense" e JOIN "Product" p ON p.id=e."productId"
        WHERE e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."categoryId" IN ${hierarchyDescendantsSql("productCategory", [id])} LIMIT 1`);
        if (affected.rows.length) assertReviewedSpendingClassification(db);
      }
    }
    await withTransaction(db, async (tx) => {
      const parentId =
        data.parentId === undefined
          ? undefined
          : data.parentId === null
            ? null
            : await resolveOrThrow(tx, "productCategory", data.parentId);
      if (parentId !== undefined) await assertValidParent(tx, id, parentId);
      const [before] = await unwrapDb(tx)
        .select()
        .from(productCategory)
        .where(and(eq(productCategory.id, id), notDeleted(productCategory)))
        .limit(1);
      if (!before) throw new Error("Product category not found");
      // A bound category may move anywhere in the tree — its own binding still
      // wins over any ancestor's — but the binding itself is permanent.
      if (
        before.feature !== null &&
        data.feature !== undefined &&
        data.feature !== before.feature
      ) {
        throw new Error(
          "A category behavior binding cannot be cleared or replaced",
        );
      }
      const spendingCategoryId =
        data.spendingCategoryId === undefined
          ? undefined
          : data.spendingCategoryId === null
            ? null
            : await resolveOrThrow(
                tx,
                "spendingCategory",
                data.spendingCategoryId,
              );
      const spendingCategoryMode =
        data.spendingCategoryMode ?? before.spendingCategoryMode;
      if (
        (spendingCategoryMode === "mapped") !==
        ((spendingCategoryId === undefined
          ? before.spendingCategoryId
          : spendingCategoryId) !==
          null)
      )
        throw new Error(
          "Mapped requires a spending category; inherit and blocked require none",
        );
      const patch = {
        spendingCategoryMode: data.spendingCategoryMode,
        spendingCategoryId,
        name: data.name?.trim(),
        aliases: data.aliases ? cleanAliases(data.aliases) : undefined,
        description: data.description,
        parentId,
        sortOrder: data.sortOrder,
        feature: data.feature,
        stockTracked: data.stockTracked,
      };
      const values = buildPartialUpdateValues(patch);
      if (Object.keys(values).length === 0) return;
      await crud.update(tx, id, values, actor, async () => undefined);
      if (
        parentId !== undefined ||
        data.feature !== undefined ||
        data.spendingCategoryId !== undefined ||
        data.spendingCategoryMode !== undefined
      ) {
        await assertAffectedProductsRemainAdmissible(tx, id);
      }
    });
    return readOutput({ entityId: id });
  },
});

/** A category bound to a behavior feature is structural; it cannot go. */
const refuseBoundCategories = async (
  tx: DrizzleTransaction,
  ids: ProductCategoryId[],
) => {
  const bound = await tx
    .select({ feature: productCategory.feature })
    .from(productCategory)
    .where(inArray(productCategory.id, ids));
  if (bound.some((row) => row.feature !== null))
    throw new Error("A category with a behavior binding cannot be deleted");
};

// A category's effective feature (`resolution.inherit`), read wherever the
// list SELECTs categories.
const effectiveFeature = effectiveFieldSql<string | null>(
  "productCategory",
  "feature",
);

/** The inherited behavior binding for one category; null means no binding. */
export async function getCategoryFeature(
  db: Database | DrizzleTransaction,
  categoryId: ProductCategoryId | null,
): Promise<ProductCategoryFeature | null> {
  if (!categoryId) return null;
  const rows = await unwrapDb(db).execute<{ feature: string | null }>(
    sql`SELECT ${effectiveFieldSql("productCategory", "feature", { id: sql`${categoryId}::uuid` })} AS feature`,
  );
  return parseFeature(rows.rows[0]?.feature ?? null);
}

/** SQL predicate: true only when the closest feature binding equals `feature`. */
/**
 * Keeps an already-selected compatible descendant. If none was selected (or it
 * belongs to another feature tree), selects the category bound to that feature.
 */
export async function resolveProductCategory(
  db: Database | DrizzleTransaction,
  requestedId: ProductCategoryId | null,
  requiredFeature: ProductCategoryFeature | null,
): Promise<ProductCategoryId | null> {
  if (
    requestedId &&
    (requiredFeature === null ||
      (await getCategoryFeature(db, requestedId)) === requiredFeature)
  ) {
    return requestedId;
  }
  if (requiredFeature === null) return null;
  const [root] = await unwrapDb(db)
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.feature, requiredFeature),
        notDeleted(productCategory),
      ),
    )
    .orderBy(asc(productCategory.sortOrder), asc(productCategory.name))
    .limit(1);
  return root ? parseEntityId("productCategory", root.id) : null;
}

export async function listProductCategoryTreeOptions(db: Database) {
  const rows = await unwrapDb(db)
    .select({ ...getTableColumns(productCategory), effectiveFeature })
    .from(productCategory)
    .where(notDeleted(productCategory))
    .orderBy(asc(productCategory.sortOrder), asc(productCategory.name));
  const paths = await pathsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const path = paths.get(row.id) ?? [];
    return {
      id: parseShortcodeFor("productCategory", row.shortcode),
      name: row.name,
      path: path.map(({ id, name }) => ({
        id: parseShortcodeFor("productCategory", id),
        name,
      })),
      aliases: row.aliases,
      description: row.description,
      ancestorIds: path
        .slice(0, -1)
        .map(({ id }) => parseShortcodeFor("productCategory", id)),
      feature: parseFeature(row.effectiveFeature),
    };
  });
}

/** Features already bound to a live category; each binds at most one. */
export async function listBoundCategoryFeatures(
  db: Database,
): Promise<ProductCategoryFeature[]> {
  const rows = await unwrapDb(db)
    .select({ feature: productCategory.feature })
    .from(productCategory)
    .where(
      and(isNotNull(productCategory.feature), notDeleted(productCategory)),
    );
  return rows.flatMap(({ feature }) => parseFeature(feature) ?? []);
}

/** One batched summary map for callers that already have category ids in rows. */
export async function loadCategorySummaries(
  db: Database | DrizzleTransaction,
  ids?: readonly ProductCategoryId[],
): Promise<Map<ProductCategoryId, ProductCategorySummary>> {
  if (ids?.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({ ...getTableColumns(productCategory), effectiveFeature })
    .from(productCategory)
    .where(
      and(
        notDeleted(productCategory),
        ids ? inArray(productCategory.id, [...ids]) : undefined,
      ),
    );
  const paths = await pathsFor(
    db,
    rows.map((row) => row.id),
  );
  return new Map(
    rows.map((row) => {
      const path = paths.get(row.id) ?? [];
      const summary = productCategorySummary.parse({
        id: parseShortcodeFor("productCategory", row.shortcode),
        name: row.name,
        path: path.map(({ id, name }) => ({
          id: parseShortcodeFor("productCategory", id),
          name,
        })),
        feature: parseFeature(row.effectiveFeature),
      });
      return [parseEntityId("productCategory", row.id), summary] as const;
    }),
  );
}

export const productCategoryRepository = defineRepository("productCategory", {
  lifecycle: { delete: PRODUCT_CATEGORY_DELETE_EDGE_POLICY },
  get: onDb(getProductCategoryByShortcode),
  list: listOn(listProductCategories),
  listRead: listReadOn(listProductCategoriesRead),
  create: asActor(createProductCategory),
  update: asActor(updateProductCategory),
  deleteHooks: { beforeDelete: refuseBoundCategories },
});
