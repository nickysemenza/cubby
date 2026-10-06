import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import type {
  ExpenseId,
  ProductId,
  ProductCategoryId,
  SpendingCategoryId,
  SpendingCategoryShortcode,
  VendorId,
} from "@cubby/schemas/identifiers";
import type {
  SpendingCategoryMappingMode,
  VendorSpendingProfile,
} from "@cubby/schemas/spending-classification";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";

import { unwrapDb } from "./database-helpers";

const column = (alias: string, key: string) =>
  sql`${sql.identifier(alias.replace(/^"|"$/gu, ""))}.${sql.identifier(key)}`;

export type ExpenseSpendingCategoryResolutionDraft = {
  products?: readonly { id: ProductId; categoryId: ProductCategoryId | null }[];
  categories?: readonly {
    id: SpendingCategoryId;
    shortcode: SpendingCategoryShortcode;
    name: string;
  }[];
  productCategories?: readonly {
    id: ProductCategoryId;
    parentId?: ProductCategoryId | null;
    spendingCategoryMode?: SpendingCategoryMappingMode;
    spendingCategoryId?: SpendingCategoryId | null;
  }[];
  vendors?: readonly {
    id: VendorId;
    spendingProfile?: VendorSpendingProfile;
    defaultSpendingCategoryId?: SpendingCategoryId | null;
  }[];
  expenses?: readonly {
    id: ExpenseId;
    spendingCategoryId: SpendingCategoryId | null;
  }[];
  /** A previewed merge: every stored reference to `id` reads as `keepId`. */
  categoryRedirects?: readonly {
    id: SpendingCategoryId;
    keepId: SpendingCategoryId;
  }[];
};

/** Applied to every stored category reference the resolution reads. */
function redirectedCategory(
  value: SQL,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL {
  if (!draft?.categoryRedirects?.length) return value;
  return sql`CASE ${value} ${sql.join(
    draft.categoryRedirects.map(
      (row) => sql`WHEN ${row.id}::uuid THEN ${row.keepId}::uuid`,
    ),
    sql` `,
  )} ELSE ${value} END`;
}

/** Same nearest-ancestor mapping policy for expense classification and category navigation. */
export function productCategorySpendingAncestorsSql(
  categoryId: SQL,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL {
  const categoryParent = projectedValue(
    "c",
    "parentId",
    draft?.productCategories,
  );
  const categoryMode = projectedValue(
    "c",
    "spendingCategoryMode",
    draft?.productCategories,
  );
  const categoryTarget = redirectedCategory(
    projectedValue("c", "spendingCategoryId", draft?.productCategories),
    draft,
  );
  return sql`      SELECT c.id,${categoryParent} AS "parentId",c.feature,c.name,c.shortcode,${categoryMode} AS "spendingCategoryMode",${categoryTarget} AS "spendingCategoryId",0 AS depth,ARRAY[c.id] AS visited
      FROM "ProductCategory" c WHERE c.id=${categoryId} AND c."deletedAt" IS NULL
      UNION ALL
      SELECT c.id,${categoryParent} AS "parentId",c.feature,c.name,c.shortcode,${categoryMode} AS "spendingCategoryMode",${categoryTarget} AS "spendingCategoryId",a.depth+1,a.visited||c.id
      FROM ancestors a JOIN "ProductCategory" c ON c.id=a."parentId" AND c."deletedAt" IS NULL
      WHERE NOT c.id=ANY(a.visited) AND a.depth<3`;
}

/** New taxonomy targets exist only in this read-only review projection. */
export const spendingCategoryCatalogSql = (
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  draft?.categories?.length
    ? sql`(SELECT id,shortcode,name,"deletedAt" FROM "SpendingCategory" UNION ALL SELECT id,shortcode,name,NULL::timestamptz FROM jsonb_to_recordset(${JSON.stringify(draft.categories)}::jsonb) AS draft_category(id uuid,shortcode text,name text))`
    : sql`"SpendingCategory"`;

function projectedValue<T extends { id: string }>(
  alias: string,
  key: keyof T & string,
  rows: readonly T[] = [],
): SQL {
  let value = column(alias, key);
  for (const row of rows) {
    if (row[key] !== undefined)
      value = sql`CASE WHEN ${column(alias, "id")} = ${row.id}::uuid THEN ${row[key]} ELSE ${value} END`;
  }
  return value;
}

export const storedExpenseSpendingCategorySql = (
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  redirectedCategory(
    projectedValue(alias, "spendingCategoryId", draft?.expenses),
    draft,
  );

/** Stored Purchase defaults are inputs; derived Purchase summaries never are. */
export function expenseSpendingCategoryResolutionSql(
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  ignoreOverride = false,
): SQL {
  const productId = column(alias, "productId");
  const purchaseId = column(alias, "purchaseId");
  const storedId = ignoreOverride
    ? sql`NULL::uuid`
    : storedExpenseSpendingCategorySql(alias, draft);
  const categoryCatalog = spendingCategoryCatalogSql(draft);
  const principal = sql`${column(alias, "lineKind")} = 'principal'`;
  const vendorProfile = projectedValue("v", "spendingProfile", draft?.vendors);
  const vendorTarget = redirectedCategory(
    projectedValue("v", "defaultSpendingCategoryId", draft?.vendors),
    draft,
  );
  const purchaseTarget = redirectedCategory(sql`p."spendingCategoryId"`, draft);
  const food = sql`COALESCE((SELECT a.feature = 'food' FROM ancestors a WHERE a.feature IS NOT NULL ORDER BY a.depth LIMIT 1),FALSE)`;
  return sql`(
    WITH RECURSIVE ancestors AS (
      ${productCategorySpendingAncestorsSql(sql`(SELECT ${projectedValue("g", "categoryId", draft?.products)} FROM "Product" g WHERE g.id=${productId} AND g."deletedAt" IS NULL)`, draft)}
    ), mapping AS (
      SELECT a.* FROM ancestors a WHERE a."spendingCategoryMode"<>'inherit' ORDER BY a.depth LIMIT 1
    ), facts AS (
      SELECT override_category.id AS override_id,override_category.shortcode AS override_code,
        p.id AS purchase_id,p.shortcode AS purchase_code,COALESCE(p."displayLabel",p."orderId") AS purchase_name,
        purchase_category.id AS purchase_category_id,p."spendingCategoryOrigin" AS purchase_category_origin,
        m."spendingCategoryMode" AS mapping_mode,m.shortcode AS mapping_code,m.name AS mapping_name,
        mapped_category.id AS mapped_id,
        v.id AS vendor_id,v.shortcode AS vendor_code,v.name AS vendor_name,${vendorProfile} AS profile,
        vendor_category.id AS vendor_category_id,
        ${food} AS food
      FROM (VALUES (1)) seed(n)
      LEFT JOIN "Product" g ON g.id=${productId} AND g."deletedAt" IS NULL
      LEFT JOIN "Purchase" p ON p.id=${purchaseId} AND p."deletedAt" IS NULL
      LEFT JOIN "Vendor" v ON v.id=p."vendorId" AND v."deletedAt" IS NULL
      LEFT JOIN mapping m ON TRUE
      LEFT JOIN ${categoryCatalog} override_category ON override_category.id=${storedId} AND override_category."deletedAt" IS NULL
      LEFT JOIN ${categoryCatalog} purchase_category ON purchase_category.id=${purchaseTarget} AND p."spendingCategoryOrigin" <> 'source' AND purchase_category."deletedAt" IS NULL
      LEFT JOIN ${categoryCatalog} mapped_category ON mapped_category.id=m."spendingCategoryId" AND mapped_category."deletedAt" IS NULL
      LEFT JOIN ${categoryCatalog} vendor_category ON vendor_category.id=${vendorTarget} AND vendor_category."deletedAt" IS NULL
    ), candidates AS (
      SELECT f.*,
        CASE WHEN ${principal} AND COALESCE(mapping_mode<>'blocked',TRUE) AND food AND profile IN ('restaurant','coffee_shop') THEN vendor_category_id END AS context_id,
        CASE WHEN ${principal} AND mapping_mode='mapped' AND (NOT food OR profile IN ('mixed_retail','food_retail')) THEN mapped_id END AS product_mapping_id,
        CASE WHEN ${principal} AND COALESCE(mapping_mode<>'blocked',TRUE) AND ${productId} IS NULL AND profile IN ('food_retail','restaurant','coffee_shop') THEN vendor_category_id END AS merchant_id
      FROM facts f
    ), chosen AS (
      SELECT f.*,COALESCE(override_id,context_id,product_mapping_id,
        CASE WHEN ${principal} THEN purchase_category_id END,merchant_id) AS category_id,
        COALESCE(context_id,product_mapping_id,CASE WHEN ${principal} THEN purchase_category_id END,merchant_id) AS fallback_id
      FROM candidates f
    )
    SELECT jsonb_build_object(
      'categoryId',c.id,'fallbackCategoryId',fallback.id,
      'mode',CASE WHEN f.override_id IS NOT NULL THEN 'explicit' WHEN c.id IS NOT NULL THEN 'inherit' ELSE 'none' END,
      'storedValue',f.override_code,'value',c.shortcode,'fallbackValue',fallback.shortcode,
      'source',CASE WHEN f.override_id IS NOT NULL THEN 'expense override'
        WHEN f.context_id IS NOT NULL THEN 'vendor food context'
        WHEN f.product_mapping_id IS NOT NULL THEN 'product category mapping'
        WHEN f.purchase_category_id IS NOT NULL AND ${principal} THEN CASE WHEN f.purchase_category_origin='legacy' THEN 'legacy purchase default; provenance needs review' ELSE 'purchase default' END
        WHEN f.merchant_id IS NOT NULL THEN 'vendor default'
        WHEN f.mapping_mode='blocked' THEN 'product category blocked' ELSE 'none' END,
      'sourceEntity',CASE WHEN f.override_id IS NOT NULL THEN jsonb_build_object('entityKind','spendingCategory','entityId',c.shortcode,'name',c.name)
        WHEN f.context_id IS NOT NULL THEN jsonb_build_object('entityKind','vendor','entityId',f.vendor_code,'name',f.vendor_name)
        WHEN f.product_mapping_id IS NOT NULL THEN jsonb_build_object('entityKind','productCategory','entityId',f.mapping_code,'name',f.mapping_name)
        WHEN f.purchase_category_id IS NOT NULL AND ${principal} THEN jsonb_build_object('entityKind','purchase','entityId',f.purchase_code,'name',f.purchase_name)
        WHEN f.merchant_id IS NOT NULL THEN jsonb_build_object('entityKind','vendor','entityId',f.vendor_code,'name',f.vendor_name)
        WHEN f.mapping_mode='blocked' THEN jsonb_build_object('entityKind','productCategory','entityId',f.mapping_code,'name',f.mapping_name) ELSE NULL END,
      'matchesFallback',c.id IS NOT DISTINCT FROM fallback.id,'canReset',f.override_id IS NOT NULL)
    FROM chosen f LEFT JOIN ${categoryCatalog} c ON c.id=f.category_id
      LEFT JOIN ${categoryCatalog} fallback ON fallback.id=f.fallback_id
  )`;
}

export const effectiveExpenseSpendingCategorySql = (
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  sql`(${expenseSpendingCategoryResolutionSql(alias, draft)}->>'categoryId')::uuid`;
export const fallbackExpenseSpendingCategorySql = (alias: string): SQL =>
  sql`(${expenseSpendingCategoryResolutionSql(alias, undefined, true)}->>'categoryId')::uuid`;
export const parseExpenseCategoryResolution = (
  value: unknown,
): FieldResolution => fieldResolutionSchema.parse(value);

/** Fresh review fingerprints include live configured policy, not a cached guess. */
export async function spendingClassificationRevision(
  db: Database,
): Promise<string> {
  const result = await unwrapDb(db).execute(sql`
    SELECT jsonb_build_object(
      'categories',(SELECT jsonb_agg(jsonb_build_array(id,name,"parentId") ORDER BY id) FROM "SpendingCategory" WHERE "deletedAt" IS NULL),
      'mappings',(SELECT jsonb_agg(jsonb_build_array(id,"parentId",feature,"spendingCategoryMode","spendingCategoryId") ORDER BY id) FROM "ProductCategory" WHERE "deletedAt" IS NULL),
      'vendors',(SELECT jsonb_agg(jsonb_build_array(id,"spendingProfile","defaultSpendingCategoryId") ORDER BY id) FROM "Vendor" WHERE "deletedAt" IS NULL)) AS policy
  `);
  const policy = z.object({ policy: z.json() }).parse(result.rows[0]).policy;
  return sha256Hex(JSON.stringify(policy));
}
