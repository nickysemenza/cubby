import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
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
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  photoGroupProposal,
  product,
  productCategory,
} from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { removeEntity } from "~/server/repo/removal";
import {
  lookupEntityReferences,
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { categoryDescendantsSql } from "./product-category-sql";

export const PRODUCT_CATEGORY_DELETE_EDGE_POLICY = {
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

type CategoryPathRow = {
  root: string;
  path: Array<{ id: string; name: string; feature: string | null }>;
};

const scaffold = listScaffold("productCategory", productCategory);

const parseFeature = (feature: string | null): ProductCategoryFeature | null =>
  productCategoryFeature.nullable().parse(feature);

/**
 * Maps a category with parent links to the compact, root-first Product shape.
 * The bounded walk also keeps an accidentally-corrupt stored cycle from making
 * a product read non-terminating.
 */
type CategorySummaryNode = {
  shortcode: string;
  name: string;
  feature: ProductCategoryFeature | null;
  parent?: CategorySummaryNode | null;
};

export const mapCategorySummary = (
  node: CategorySummaryNode,
): ProductCategorySummary => {
  const path: Array<{ id: ProductCategoryShortcode; name: string }> = [];
  let feature: ProductCategoryFeature | null = null;
  let current: CategorySummaryNode | null | undefined = node;
  let depth = 0;
  while (current && depth < MAX_PRODUCT_CATEGORY_DEPTH) {
    path.unshift({
      id: parseShortcodeFor("productCategory", current.shortcode),
      name: current.name,
    });
    feature ??= current.feature;
    current = current.parent;
    depth += 1;
  }
  return productCategorySummary.parse({
    id: parseShortcodeFor("productCategory", node.shortcode),
    name: node.name,
    path,
    feature,
  });
};

/**
 * The binding a category resolves to: its own, else the nearest ancestor's.
 * `path` is root-first, so search from the leaf end — a nested binding
 * (Tools › Tool consumables) must win over the root's.
 */
const closestPathFeature = (
  path: CategoryPathRow["path"],
): ProductCategoryFeature | null =>
  parseFeature(
    [...path].reverse().find(({ feature }) => feature !== null)?.feature ??
      null,
  );

const pathsFor = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, CategoryPathRow["path"]>> => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db).execute<CategoryPathRow>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT c."id" AS root, c."id", c."parentId", c."shortcode", c."name", c."feature", 0 AS depth,
             ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."id" IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND c."deletedAt" IS NULL
      UNION ALL
      SELECT a.root, parent."id", parent."parentId", parent."shortcode", parent."name", parent."feature", a.depth + 1,
             a.visited || parent."id"
      FROM ancestors a
      JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL
        AND a.depth < ${MAX_PRODUCT_CATEGORY_DEPTH - 1}
        AND NOT parent."id" = ANY(a.visited)
    )
    SELECT root, json_agg(json_build_object('id', shortcode, 'name', name, 'feature', feature) ORDER BY depth DESC) AS path
    FROM ancestors
    GROUP BY root
  `);
  return new Map(rows.rows.map((row) => [row.root, row.path]));
};

/**
 * Live products in each category's subtree. One recursive walk seeded by
 * every requested id, with the same depth bound and visited-array guard as
 * `categoryDescendantsSql`, so a stored cycle cannot make a read loop.
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

/**
 * A category with no feature of its own takes the closest ancestor's
 * (`categoryFeatureSql`). Reported as an inherited resolution so the generic
 * table and detail badges show it, while `feature` keeps meaning the stored
 * binding for edits and MCP.
 */
const inheritedFeatureResolution = (
  row: CategoryRow,
  path: CategoryPathRow["path"],
): FieldResolutions | undefined => {
  if (row.feature !== null) return undefined;
  const source = path
    .slice(0, -1)
    .reverse()
    .find((ancestor) => ancestor.feature !== null);
  if (!source) return undefined;
  const feature = parseFeature(source.feature);
  return {
    feature: {
      mode: "inherit",
      storedValue: null,
      value: feature,
      fallbackValue: feature,
      source: source.name,
      sourceEntity: {
        entityType: "productCategory",
        entityId: source.id,
        name: source.name,
      },
      matchesFallback: true,
      canReset: false,
    },
  };
};

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: CategoryRow[],
): Promise<ProductCategoryOut[]> => {
  const ids = rows.map((row) => row.id);
  const [paths, productCounts, dataQualities, parents] = await Promise.all([
    pathsFor(db, ids),
    productCountsFor(db, ids),
    loadDataQualities(db, "productCategory", ids),
    lookupEntityReferences(
      db,
      "productCategory",
      rows.map((row) => row.parentId),
    ),
  ]);
  return rows.map((row) => {
    const path = paths.get(row.id) ?? [];
    const parent = row.parentId ? parents.get(row.parentId) : undefined;
    return productCategoryOut.parse({
      ...row,
      fieldResolutions: inheritedFeatureResolution(row, path),
      id: parseShortcodeFor("productCategory", row.shortcode),
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      feature: parseFeature(row.feature),
      path: path.map((part) => ({
        id: parseShortcodeFor("productCategory", part.id),
        name: part.name,
      })),
      productCount: productCounts.get(row.id) ?? 0,
      dataQuality: dataQualities.get(row.id),
    });
  });
};

export const buildProductCategoryWhere = (filters: ProductCategoryFilters) =>
  scaffold.where(filters);

export const listProductCategories = (
  db: Database,
  filters: ProductCategoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination },
    { hydrate: (rows) => hydrate(db, rows) },
  );

const reader = createEntityReader<
  CategoryRow,
  ProductCategoryOut,
  "productCategory",
  Database | DrizzleTransaction
>({
  entity: "productCategory",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(productCategory)
      .where(and(eq(productCategory.id, id), notDeleted(productCategory)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getProductCategoryByShortcode = reader.getByShortcode;

const cleanAliases = (aliases: string[]) => [
  ...new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
];

const assertValidParent = async (
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
        sql`${product.categoryId} IN ${categoryDescendantsSql([categoryId])}`,
      ),
    );
  const { assertProductCategoryChange } =
    await import("./product/classification");
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
  const { validateLiveEffectiveTrades } =
    await import("./inheritance-validation");
  await validateLiveEffectiveTrades(tx);
};

export async function createProductCategory(
  db: Database,
  data: ProductCategoryCreateInput,
  actor: ActorContext,
): Promise<{ output: ProductCategoryOut; entityId: ProductCategoryId }> {
  const id = await withTransaction(db, async (tx) => {
    const parentId = data.parentId
      ? await resolveOrThrow(tx, "productCategory", data.parentId)
      : null;
    await assertValidParent(tx, null, parentId);
    const row = await insertWithShortcode(tx, "productCategory", {
      name: data.name.trim(),
      aliases: cleanAliases(data.aliases),
      description: data.description,
      parentId,
      sortOrder: data.sortOrder,
      feature: data.feature,
    });
    await logAuditEntry(tx, actor, {
      entityType: "productCategory",
      entityId: row.id,
      action: "create",
    });
    return parseEntityId("productCategory", row.id);
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updateProductCategory(
  db: Database,
  shortcode: ProductCategoryShortcode,
  data: ProductCategoryUpdateData,
  actor: ActorContext,
): Promise<{ output: ProductCategoryOut; entityId: ProductCategoryId }> {
  const id = await resolveOrThrow(db, "productCategory", shortcode);
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
    const patch = {
      name: data.name?.trim(),
      aliases: data.aliases ? cleanAliases(data.aliases) : undefined,
      description: data.description,
      parentId,
      sortOrder: data.sortOrder,
      feature: data.feature,
    };
    const values = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(values).length === 0) return;
    await unwrapDb(tx)
      .update(productCategory)
      .set(values)
      .where(eq(productCategory.id, id));
    if (parentId !== undefined || data.feature !== undefined) {
      await assertAffectedProductsRemainAdmissible(tx, id);
    }
    await logAuditEntry(tx, actor, {
      entityType: "productCategory",
      entityId: id,
      action: "update",
    });
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function deleteProductCategories(
  db: Database,
  shortcodes: ProductCategoryShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(await resolveAllOrThrow(db, "productCategory", shortcodes));
  return withTransaction(db, async (tx) => {
    const bound = await unwrapDb(tx)
      .select({ feature: productCategory.feature })
      .from(productCategory)
      .where(
        and(inArray(productCategory.id, ids), notDeleted(productCategory)),
      );
    if (bound.some((row) => row.feature !== null)) {
      throw new Error("A category with a behavior binding cannot be deleted");
    }
    await tx
      .update(photoGroupProposal)
      .set({ productCreateCategoryId: null })
      .where(inArray(photoGroupProposal.productCreateCategoryId, ids));
    await removeEntity(tx, {
      entity: "productCategory",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted: ids.length };
  });
}

/** The inherited behavior binding for one category; null means no binding. */
export async function getCategoryFeature(
  db: Database | DrizzleTransaction,
  categoryId: ProductCategoryId | null,
): Promise<ProductCategoryFeature | null> {
  if (!categoryId) return null;
  const rows = await unwrapDb(db).execute<{
    feature: ProductCategoryFeature | null;
  }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", c."feature", 0 AS depth, ARRAY[c."id"] AS visited
      FROM "ProductCategory" c WHERE c."id" = ${categoryId}::uuid AND c."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentId", parent."feature", a.depth + 1, a.visited || parent."id"
      FROM ancestors a JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_PRODUCT_CATEGORY_DEPTH - 1}
        AND NOT parent."id" = ANY(a.visited)
    ) SELECT "feature" FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1
  `);
  return rows.rows[0]?.feature ?? null;
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
    .select()
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
      feature: closestPathFeature(path),
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
): Promise<Map<ProductCategoryId, ProductCategorySummary>> {
  const rows = await unwrapDb(db)
    .select()
    .from(productCategory)
    .where(notDeleted(productCategory));
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
        feature: closestPathFeature(path),
      });
      return [parseEntityId("productCategory", row.id), summary] as const;
    }),
  );
}

export const productCategoryRepository = entityRepository({
  lifecycle: { delete: PRODUCT_CATEGORY_DELETE_EDGE_POLICY },
  get: getProductCategoryByShortcode,
  list: listProductCategories,
  create: createProductCategory,
  update: updateProductCategory,
  delete: deleteProductCategories,
});
