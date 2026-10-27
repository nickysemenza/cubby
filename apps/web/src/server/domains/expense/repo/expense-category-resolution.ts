import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { fieldEmptyReason } from "@cubby/schemas/field-envelope";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import {
  fieldResolutionSchema,
  fieldResolutionSourceSchema,
} from "@cubby/schemas/field-resolution";
import type {
  ExpenseId,
  ProductId,
  ProductCategoryId,
  SpendingCategoryId,
  SpendingCategoryShortcode,
  VendorId,
} from "@cubby/schemas/identifiers";
import { productCategoryFeature } from "@cubby/schemas/product-category-fields";
import {
  spendingCategoryMappingMode,
  type SpendingCategoryMappingMode,
  type VendorSpendingProfile,
} from "@cubby/schemas/spending-classification";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { sqlEnumConstant } from "~/server/db/helpers/query";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";

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

/** The category mapping walk expense classification reads, with a review's
 * draft values projected in, so it cannot use the declared chain over stored
 * rows (`resolution.inherit`, #2616). An omitted root builds a catalog that a
 * bulk allocation can share across its rows. */
function productCategorySpendingAncestorsSql(
  categoryId: SQL | undefined,
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
  return sql`      SELECT c.id AS "rootId",c.id,${categoryParent} AS "parentId",c.feature,c.name,c.shortcode,${categoryMode} AS "spendingCategoryMode",${categoryTarget} AS "spendingCategoryId",0 AS depth,ARRAY[c.id] AS visited
      FROM "ProductCategory" c WHERE c."deletedAt" IS NULL ${categoryId ? sql`AND c.id=${categoryId}` : sql``}
      UNION ALL
      SELECT a."rootId",c.id,${categoryParent} AS "parentId",c.feature,c.name,c.shortcode,${categoryMode} AS "spendingCategoryMode",${categoryTarget} AS "spendingCategoryId",a.depth+1,a.visited||c.id
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

const storedExpenseSpendingCategorySql = (
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  redirectedCategory(
    projectedValue(alias, "spendingCategoryId", draft?.expenses),
    draft,
  );

/**
 * Joins a Purchase's own category as an input: live, merge-redirected, and
 * never a statement-sourced category.
 */
const purchaseCategoryInputSql = (
  purchase: string,
  category: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  sql`${column(category, "id")}=${redirectedCategory(column(purchase, "spendingCategoryId"), draft)} AND ${column(purchase, "spendingCategoryOrigin")} <> 'source' AND ${column(category, "deletedAt")} IS NULL`;

/** The input category of the joined Purchase `purchase`, or null. */
export const purchaseDefaultSpendingCategorySql = (
  purchase: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  sql`(SELECT fallback_category.id FROM ${spendingCategoryCatalogSql(draft)} fallback_category WHERE ${purchaseCategoryInputSql(purchase, "fallback_category", draft)})`;

/** Stored Purchase defaults are inputs; derived Purchase summaries never are. */
function expenseSpendingCategoryChoiceSql(
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  ignoreOverride = false,
  source?: SQL,
): SQL {
  const productId = column(alias, "productId");
  const purchaseId = column(alias, "purchaseId");
  const principal = sql`${column(alias, "lineKind")} = 'principal'`;
  const storedId = ignoreOverride
    ? sql`NULL::uuid`
    : sql`CASE WHEN ${principal} THEN ${storedExpenseSpendingCategorySql(alias, draft)} ELSE NULL::uuid END`;
  const categoryCatalog = spendingCategoryCatalogSql(draft);
  const vendorProfile = projectedValue("v", "spendingProfile", draft?.vendors);
  const vendorTarget = redirectedCategory(
    projectedValue("v", "defaultSpendingCategoryId", draft?.vendors),
    draft,
  );
  const unclassified = sql`${column(alias, "lineKind")} = ${sqlEnumConstant(expenseLineKindSchema, expenseLineKindSchema.enum.unclassified)}`;
  const productCategory = projectedValue("g", "categoryId", draft?.products);
  const food = source
    ? sql`COALESCE(category_feature.feature = ${sqlEnumConstant(productCategoryFeature, productCategoryFeature.enum.food)}, FALSE)`
    : sql`COALESCE((SELECT a.feature = 'food' FROM ancestors a WHERE a.feature IS NOT NULL ORDER BY a.depth LIMIT 1),FALSE)`;
  const categoryId = sql`(SELECT ${projectedValue("g", "categoryId", draft?.products)} FROM "Product" g WHERE g.id=${productId} AND g."deletedAt" IS NULL)`;
  return sql`WITH RECURSIVE ancestors AS (
      ${productCategorySpendingAncestorsSql(
        source ? undefined : categoryId,
        draft,
      )}
    ), mapping AS (
      ${
        source
          ? sql`SELECT DISTINCT ON (a."rootId") a.* FROM ancestors a WHERE a."spendingCategoryMode"<>${sqlEnumConstant(spendingCategoryMappingMode, spendingCategoryMappingMode.enum.inherit)} ORDER BY a."rootId", a.depth`
          : sql`SELECT a.* FROM ancestors a WHERE a."spendingCategoryMode"<>'inherit' ORDER BY a.depth LIMIT 1`
      }
    ), ${
      source
        ? sql`category_feature AS (
      SELECT DISTINCT ON (a."rootId") a."rootId", a.feature FROM ancestors a
      WHERE a.feature IS NOT NULL ORDER BY a."rootId", a.depth
    ),`
        : sql``
    } facts AS (
      SELECT ${source ? sql`${column(alias, "id")} AS "expenseId",` : sql``}
        ${principal} AS principal, ${unclassified} AS unclassified, ${productId} AS product_id,
        override_category.id AS override_id,override_category.shortcode AS override_code,
        p.id AS purchase_id,p.shortcode AS purchase_code,COALESCE(p."displayLabel",p."orderId") AS purchase_name,
        purchase_category.id AS purchase_category_id,purchase_category.shortcode AS purchase_category_code,p."spendingCategoryOrigin" AS purchase_category_origin,
        m."spendingCategoryMode" AS mapping_mode,m.shortcode AS mapping_code,m.name AS mapping_name,
        mapped_category.id AS mapped_id,
        v.id AS vendor_id,v.shortcode AS vendor_code,v.name AS vendor_name,${vendorProfile} AS profile,
        vendor_category.id AS vendor_category_id,vendor_category.shortcode AS vendor_category_code,
        ${food} AS food
      FROM ${source ? sql`${source} ${sql.identifier(alias)}` : sql`(VALUES (1)) seed(n)`}
      LEFT JOIN "Product" g ON g.id=${productId} AND g."deletedAt" IS NULL
      LEFT JOIN "Purchase" p ON p.id=${purchaseId} AND p."deletedAt" IS NULL
      LEFT JOIN "Vendor" v ON v.id=p."vendorId" AND v."deletedAt" IS NULL
      LEFT JOIN mapping m ON ${source ? sql`m."rootId"=${productCategory}` : sql`TRUE`}
      ${source ? sql`LEFT JOIN category_feature ON category_feature."rootId"=${productCategory}` : sql``}
      LEFT JOIN ${categoryCatalog} override_category ON override_category.id=${storedId} AND override_category."deletedAt" IS NULL
      LEFT JOIN ${categoryCatalog} purchase_category ON ${purchaseCategoryInputSql("p", "purchase_category", draft)}
      LEFT JOIN ${categoryCatalog} mapped_category ON mapped_category.id=m."spendingCategoryId" AND mapped_category."deletedAt" IS NULL
      LEFT JOIN ${categoryCatalog} vendor_category ON vendor_category.id=${vendorTarget} AND vendor_category."deletedAt" IS NULL
    ), eligibility AS (
      SELECT f.*,
        f.principal AND COALESCE(mapping_mode<>'blocked',TRUE) AND food AND COALESCE(profile IN ('restaurant','coffee_shop'),FALSE) AS context_eligible,
        f.principal AND (COALESCE(mapping_mode=${sqlEnumConstant(spendingCategoryMappingMode, spendingCategoryMappingMode.enum.blocked)},FALSE) OR NOT food OR COALESCE(profile IN ('mixed_retail','food_retail'),FALSE)) AS mapping_eligible,
        f.principal AND COALESCE(mapping_mode<>'blocked',TRUE) AND f.product_id IS NULL AND COALESCE(profile IN ('food_retail','restaurant','coffee_shop'),FALSE) AS merchant_eligible
      FROM facts f
    ), candidates AS (
      SELECT f.*,
        CASE WHEN context_eligible THEN vendor_category_id END AS context_id,
        CASE WHEN mapping_mode='mapped' AND mapping_eligible THEN mapped_id END AS product_mapping_id,
        CASE WHEN merchant_eligible THEN vendor_category_id END AS merchant_id
      FROM eligibility f
    ), chosen AS (
      SELECT f.*,
        CASE WHEN f.unclassified THEN NULL::uuid ELSE COALESCE(override_id,context_id,product_mapping_id,
          CASE WHEN f.principal THEN purchase_category_id END,merchant_id) END AS category_id,
        CASE WHEN f.unclassified THEN NULL::uuid ELSE COALESCE(context_id,product_mapping_id,
          CASE WHEN f.principal THEN purchase_category_id END,merchant_id) END AS fallback_id
      FROM candidates f
    )`;
}

/** Both the canonical resolution and its override-free evidence name the
 * source selected by the choice relation, including a block with no value. */
const expenseCategorySourceSql =
  (): SQL => sql`CASE WHEN f.override_id IS NOT NULL THEN jsonb_build_object('entityKind','spendingCategory','entityId',c.shortcode,'name',c.name)
  WHEN f.context_id IS NOT NULL THEN jsonb_build_object('entityKind','vendor','entityId',f.vendor_code,'name',f.vendor_name)
  WHEN f.product_mapping_id IS NOT NULL THEN jsonb_build_object('entityKind','productCategory','entityId',f.mapping_code,'name',f.mapping_name)
  WHEN f.purchase_category_id IS NOT NULL AND f.principal THEN jsonb_build_object('entityKind','purchase','entityId',f.purchase_code,'name',f.purchase_name)
  WHEN f.merchant_id IS NOT NULL THEN jsonb_build_object('entityKind','vendor','entityId',f.vendor_code,'name',f.vendor_name)
  WHEN f.mapping_mode='blocked' THEN jsonb_build_object('entityKind','productCategory','entityId',f.mapping_code,'name',f.mapping_name) ELSE NULL END`;

export function expenseSpendingCategoryResolutionSql(
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  ignoreOverride = false,
): SQL {
  const principal = sql`${column(alias, "lineKind")} = ${sqlEnumConstant(expenseLineKindSchema, expenseLineKindSchema.enum.principal)}`;
  const categoryCatalog = spendingCategoryCatalogSql(draft);
  return sql`(${expenseSpendingCategoryChoiceSql(alias, draft, ignoreOverride)}
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
      'emptyReason',CASE WHEN c.id IS NULL AND f.mapping_mode=${sqlEnumConstant(spendingCategoryMappingMode, spendingCategoryMappingMode.enum.blocked)} THEN ${sqlEnumConstant(fieldEmptyReason, fieldEmptyReason.enum.blocked)} ELSE ${sqlEnumConstant(fieldEmptyReason, fieldEmptyReason.enum.unset)} END,
      'sourceEntity',${expenseCategorySourceSql()},
      'matchesFallback',c.id IS NOT DISTINCT FROM fallback.id,'canReset',f.override_id IS NOT NULL)
    FROM chosen f LEFT JOIN ${categoryCatalog} c ON c.id=f.category_id
      LEFT JOIN ${categoryCatalog} fallback ON fallback.id=f.fallback_id
  )`;
}

const categoryEvidenceKind = z.enum([
  "context",
  "mapping",
  "purchase",
  "merchant",
]);

const categoryEvidenceSchema = z.object({
  steps: z.array(
    z.object({
      kind: categoryEvidenceKind,
      ref: fieldResolutionSchema.shape.sourceEntity.unwrap(),
      value: z.json(),
      assigned: z.boolean(),
      applicable: z.boolean(),
    }),
  ),
  fallbackSource: fieldResolutionSchema.shape.sourceEntity,
});

/** Explanation-only projection: all alternatives use the choice relation's
 * eligibility, while scalar and bulk reads never build this JSON or ladder.
 * The supplied Database retains the explanation operation's read snapshot. */
export async function loadExpenseSpendingCategoryEvidence(
  db: Database,
  shortcode: string,
) {
  const result = await unwrapDb(db).execute(sql`
    SELECT (${expenseSpendingCategoryChoiceSql("e", undefined, true)}
      SELECT jsonb_build_object(
        'fallbackSource',${expenseCategorySourceSql()},
        'steps',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
          ${"kind"}::text,step.kind,'ref',jsonb_build_object('entityKind',step.entity,'entityId',step.code,${"name"}::text,step.name),
          'value',step.value,${"assigned"}::text,step.assigned,'applicable',step.applicable
        ) ORDER BY step.position,step.depth),'[]'::jsonb) FROM (
          SELECT 0 AS position,0 AS depth,${sqlEnumConstant(categoryEvidenceKind, categoryEvidenceKind.enum.context)} AS kind,${sqlEnumConstant(fieldResolutionSourceSchema.shape.entityKind, fieldResolutionSourceSchema.shape.entityKind.enum.vendor)} AS entity,f.vendor_code AS code,f.vendor_name AS name,
            to_jsonb(f.vendor_category_code) AS value,f.vendor_category_id IS NOT NULL AS assigned,f.context_eligible AS applicable
          WHERE f.vendor_id IS NOT NULL
          UNION ALL
          SELECT 1,a.depth,${sqlEnumConstant(categoryEvidenceKind, categoryEvidenceKind.enum.mapping)},${sqlEnumConstant(fieldResolutionSourceSchema.shape.entityKind, fieldResolutionSourceSchema.shape.entityKind.enum.productCategory)},a.shortcode,a.name,
            jsonb_build_object('mode',a."spendingCategoryMode",'category',ac.shortcode),a."spendingCategoryMode"<>${sqlEnumConstant(spendingCategoryMappingMode, spendingCategoryMappingMode.enum.inherit)},f.mapping_eligible
          FROM ancestors a LEFT JOIN "SpendingCategory" ac ON ac.id=a."spendingCategoryId" AND ac."deletedAt" IS NULL
          UNION ALL
          SELECT 2,0,${sqlEnumConstant(categoryEvidenceKind, categoryEvidenceKind.enum.purchase)},${sqlEnumConstant(fieldResolutionSourceSchema.shape.entityKind, fieldResolutionSourceSchema.shape.entityKind.enum.purchase)},f.purchase_code,f.purchase_name,
            to_jsonb(f.purchase_category_code),f.purchase_category_id IS NOT NULL,f.principal
          WHERE f.purchase_id IS NOT NULL
          UNION ALL
          SELECT 3,0,${sqlEnumConstant(categoryEvidenceKind, categoryEvidenceKind.enum.merchant)},${sqlEnumConstant(fieldResolutionSourceSchema.shape.entityKind, fieldResolutionSourceSchema.shape.entityKind.enum.vendor)},f.vendor_code,f.vendor_name,
            to_jsonb(f.vendor_category_code),f.vendor_category_id IS NOT NULL,f.merchant_eligible
          WHERE f.vendor_id IS NOT NULL
        ) step)
      ) FROM chosen f LEFT JOIN "SpendingCategory" c ON c.id=f.category_id
    ) AS evidence
    FROM "Expense" e WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL`);
  return result.rows[0]
    ? categoryEvidenceSchema.parse(result.rows[0].evidence)
    : null;
}

export const effectiveExpenseSpendingCategorySql = (
  alias: string,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL =>
  sql`(${expenseSpendingCategoryChoiceSql(alias, draft)} SELECT category_id FROM chosen)`;

/** One category per input Expense, using the same choice policy as scalar and
 * explanation reads. The relation supplies Expense identity and policy inputs. */
export const effectiveExpenseSpendingCategoriesSql = (
  source: SQL,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL => sql`${expenseSpendingCategoryChoiceSql("e", draft, false, source)}
  SELECT "expenseId", category_id AS "spendingCategoryId" FROM chosen`;
export const fallbackExpenseSpendingCategorySql = (alias: string): SQL =>
  sql`(${expenseSpendingCategoryChoiceSql(alias, undefined, true)} SELECT category_id FROM chosen)`;
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
