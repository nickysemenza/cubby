import {
  expenseProductCategoryRemainderSchema,
  type CostType,
  type ExpenseProductCategoryRemainder,
} from "@cubby/schemas/expense-fields";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type {
  ExpenseId,
  ProjectId,
  ProductCategoryId,
  PurchaseId,
  SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import {
  spendingCategoryAllocationSchema,
  type SpendingCategoryAllocation,
} from "@cubby/schemas/spending-classification";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { dollarsToMinorSql } from "~/server/db/computed/money";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  effectiveExpenseSpendingCategoriesSql,
  purchaseDefaultSpendingCategorySql,
  spendingCategoryCatalogSql,
  type ExpenseSpendingCategoryResolutionDraft,
} from "~/server/domains/expense/repo/expense-category-resolution";

import { principalExpenseInheritanceSql } from "./expense-inheritance";

/** SQL arrays retain legacy correlated callers; relational selections expose
 * cardinality to the planner instead of hiding a whole ledger in an InitPlan. */
export type ExpenseIdRelation = { select: SQL };
export type ExpenseIdSelection = readonly ExpenseId[] | SQL | ExpenseIdRelation;

export const expenseSelectionConditionSql = (
  id: SQL,
  selection: ExpenseIdSelection,
): SQL =>
  "select" in selection
    ? sql`${id} IN (${selection.select})`
    : sql`${id} = ANY(${uuidArrayParam(selection)})`;

export const expenseSelectionIdsSql = (selection: ExpenseIdSelection): SQL =>
  "select" in selection
    ? selection.select
    : sql`SELECT unnest(${uuidArrayParam(selection)}) AS id`;

const allocationBasis = spendingCategoryAllocationSchema.shape.basis.enum;
export type ExpenseProjectAllocationBasis = SpendingCategoryAllocation["basis"];

export type ExpenseProjectAllocationRow = {
  expenseId: ExpenseId;
  purchaseId: PurchaseId | null;
  projectId: ProjectId | null;
  projectShortcode: string | null;
  projectName: string | null;
  sourceCents: bigint | null;
  attributedCents: bigint | null;
  basis: ExpenseProjectAllocationBasis;
  incomplete: boolean;
};

export type ExpenseJointAllocationRow = ExpenseProjectAllocationRow & {
  principalExpenseId: ExpenseId | null;
  spendingCategoryId: SpendingCategoryId | null;
  spendingCategoryShortcode: string | null;
  spendingCategoryName: string | null;
  categoryIncomplete: boolean;
  productCategoryId: ProductCategoryId | null;
  productCategoryShortcode: string | null;
  productCategoryName: string | null;
  productCategoryRemainder: ExpenseProductCategoryRemainder | null;
  /** The share's trade and cost type: its principal's, unless the adjustment
   * names its own trade. A share with no principal keeps a null trade and the
   * adjustment's own cost type. Trade is null on a project-only read. */
  trade: Trade | null;
  costType: CostType;
};

type RawAllocationRow<T> = Omit<T, "sourceCents" | "attributedCents"> & {
  sourceCents: string | number | null;
  attributedCents: string | number | null;
};

/**
 * Round shared adjustments once per principal line, before grouping dimensions.
 * All live siblings supply the denominator; ledger filters only select final
 * rows. The stable principal ID breaks remainder ties independently of mutable
 * Project/category assignments. ID-scoped reads first select complete purchases.
 *
 * Reads that group shares by dimension pass `principals: false`. A purchase
 * whose principals all share one set of dimensions then weighs them as one
 * line with a null `principalExpenseId`: largest remainder gives that group
 * the whole adjustment either way, so grouped totals are unchanged.
 */
export const expenseJointAllocationSql = (
  expenseIds?: ExpenseIdSelection,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  {
    categories = true,
    productCategories = categories,
    trades = categories,
    projects = true,
    principals = true,
  }: {
    categories?: boolean;
    productCategories?: boolean;
    trades?: boolean;
    projects?: boolean;
    principals?: boolean;
  } = {},
): SQL => {
  const inherited = principalExpenseInheritanceSql("e", "live_purchase");
  return sql`
  WITH ${
    expenseIds
      ? sql`selected_expense AS (
    SELECT target."id", target."purchaseId" FROM "Expense" target
    WHERE ${notDeleted("target")} AND ${expenseSelectionConditionSql(sql`target."id"`, expenseIds)}
  ),`
      : sql``
  } principal_input AS (
    SELECT e.id, e."purchaseId", e."projectId", e."productId", e."spendingCategoryId",
      e."lineKind", e.trade, e."costType", e.cost
    FROM ${
      expenseIds
        ? sql`(
      SELECT sibling.* FROM "Expense" sibling
      WHERE ${notDeleted("sibling")}
        AND sibling."purchaseId" IN (SELECT "purchaseId" FROM selected_expense)
      UNION ALL
      SELECT standalone.* FROM "Expense" standalone
      WHERE ${notDeleted("standalone")} AND standalone."purchaseId" IS NULL
        AND standalone."id" IN (SELECT "id" FROM selected_expense)
    )`
        : sql`"Expense"`
    } e
    WHERE ${notDeleted("e")} AND e."lineKind" = ${expenseLineKindSchema.enum.principal}
  ), ${
    categories
      ? sql`principal_categories AS (
    ${effectiveExpenseSpendingCategoriesSql(sql`principal_input`, draft)}
  ),`
      : sql``
  } principal_fact AS (
    SELECT e."id" AS "expenseId", e."purchaseId",
      ${projects ? inherited.projectId : sql`NULL::uuid`} AS "projectId",
      ${
        // Resolve policy with set-based joins across the selected principals.
        // Reads without a category projection or scope omit its resolution.
        categories
          ? sql`principal_categories."spendingCategoryId"`
          : sql`NULL::uuid`
      } AS "spendingCategoryId",
      ${productCategories ? sql`live_product_category.id` : sql`NULL::uuid`} AS "productCategoryId",
      ${
        productCategories
          ? sql`CASE
        WHEN e."productId" IS NULL THEN ${expenseProductCategoryRemainderSchema.enum.productless}
        WHEN live_product.id IS NULL THEN ${expenseProductCategoryRemainderSchema.enum.deleted_product}
        WHEN live_product."categoryId" IS NULL THEN ${expenseProductCategoryRemainderSchema.enum.uncategorized_product}
        WHEN live_product_category.id IS NULL THEN ${expenseProductCategoryRemainderSchema.enum.deleted_category}
        ELSE NULL END`
          : sql`NULL::text`
      } AS "productCategoryRemainder",
      ${trades ? inherited.trade : sql`NULL::text`} AS trade,
      e."costType"::text AS "costType",
      ${dollarsToMinorSql(sql`e."cost"`)} AS cost_cents,
      live_purchase."id" IS NOT NULL AS live_purchase,
      EXISTS (SELECT 1 FROM "Expense" unknown_role
        WHERE unknown_role."purchaseId" = e."purchaseId"
          AND ${notDeleted("unknown_role")}
          AND unknown_role."lineKind" = ${expenseLineKindSchema.enum.unclassified}) AS has_unclassified
    FROM principal_input e
    ${categories ? sql`LEFT JOIN principal_categories ON principal_categories."expenseId"=e.id` : sql``}
    ${
      productCategories
        ? sql`LEFT JOIN "Product" live_product
      ON live_product.id = e."productId" AND ${notDeleted("live_product")}
    LEFT JOIN "ProductCategory" live_product_category
      ON live_product_category.id = live_product."categoryId" AND ${notDeleted("live_product_category")}`
        : sql``
    }
    LEFT JOIN "Purchase" live_purchase
      ON live_purchase."id" = e."purchaseId" AND ${notDeleted("live_purchase")}
    ${projects || trades ? inherited.joins : sql``}
  ), purchase_direction AS (
    SELECT "purchaseId", coalesce(bool_or(cost_cents > 0), false) AS has_positive,
      coalesce(bool_or(cost_cents < 0), false) AS has_negative,
      bool_or(cost_cents IS NULL) AS has_unpriced_principal,
      coalesce(bool_or(has_unclassified), false) AS has_unclassified
    FROM principal_fact WHERE live_purchase GROUP BY "purchaseId"
  ), principal_weight AS (
    SELECT f."purchaseId", f."expenseId" AS "principalExpenseId",
      f."projectId", f."spendingCategoryId", f."productCategoryId", f."productCategoryRemainder", f.trade, f."costType",
      CASE WHEN d.has_negative AND NOT d.has_positive THEN ${allocationBasis.refund} ELSE ${allocationBasis.positive} END::text AS basis,
      greatest(abs(f.cost_cents), 1)::bigint AS weight
    FROM principal_fact f JOIN purchase_direction d USING ("purchaseId")
    WHERE (d.has_positive AND f.cost_cents > 0)
      OR (NOT d.has_positive AND d.has_negative AND f.cost_cents < 0)
      -- Every principal priced at $0 (an award ticket, a free item that still
      -- shipped): the known zero weights split adjustments evenly. Any unpriced
      -- principal keeps the unknown default instead of inventing a denominator.
      OR (NOT d.has_positive AND NOT d.has_negative
        AND NOT coalesce(d.has_unpriced_principal, false) AND f.cost_cents = 0)
  ), ${
    principals
      ? sql``
      : sql`principal_group AS (
    SELECT "purchaseId", "projectId", "spendingCategoryId", "productCategoryId", "productCategoryRemainder", trade, "costType", basis,
      -- numeric like the window denominator: summed cents can exceed bigint.
      sum(weight) AS weight, count(*) OVER (PARTITION BY "purchaseId") AS groups
    FROM principal_weight
    GROUP BY "purchaseId", "projectId", "spendingCategoryId", "productCategoryId", "productCategoryRemainder", trade, "costType", basis
  ),`
  } fallback_weight AS (
    SELECT p."id" AS "purchaseId", NULL::uuid AS "principalExpenseId",
      ${projects ? sql`default_project."id"` : sql`NULL::uuid`} AS "projectId",
      -- With no item line to follow, adjustments read the order's own category
      -- under the same rules item lines use, as they read its default project.
      ${categories ? purchaseDefaultSpendingCategorySql("p", draft) : sql`NULL::uuid`} AS "spendingCategoryId",
      NULL::uuid AS "productCategoryId", ${expenseProductCategoryRemainderSchema.enum.no_principal}::text AS "productCategoryRemainder",
      NULL::text AS trade, NULL::text AS "costType",
      ${allocationBasis.default}::text AS basis, 1::bigint AS weight
    FROM "Purchase" p ${
      projects
        ? sql`LEFT JOIN "Project" default_project
      ON default_project."id" = p."defaultProjectId" AND ${notDeleted("default_project")}`
        : sql``
    }
    WHERE ${notDeleted("p")}
      ${expenseIds ? sql`AND p."id" IN (SELECT "purchaseId" FROM selected_expense)` : sql``}
      AND NOT EXISTS (SELECT 1 FROM principal_weight w WHERE w."purchaseId" = p."id")
  ), weights AS (
    ${
      principals
        ? sql`SELECT * FROM principal_weight`
        : sql`SELECT * FROM principal_weight
      WHERE "purchaseId" IN (SELECT "purchaseId" FROM principal_group WHERE groups > 1)
    UNION ALL
    SELECT "purchaseId", NULL::uuid AS "principalExpenseId", "projectId",
      "spendingCategoryId", "productCategoryId", "productCategoryRemainder", trade, "costType", basis, weight
    FROM principal_group WHERE groups = 1`
    }
    UNION ALL SELECT * FROM fallback_weight
  ), adjustment_seed AS (
    SELECT e."id" AS "expenseId", e."purchaseId", w."principalExpenseId",
      ${projects ? sql`CASE WHEN p."id" IS NULL THEN standalone_project."id" ELSE w."projectId" END` : sql`NULL::uuid`} AS "projectId",
      CASE
        WHEN e."cost" < 0 AND e."lineKind" <> ${expenseLineKindSchema.enum.discount} AND coalesce(d.has_positive, false) THEN NULL
        ELSE w."spendingCategoryId"
      END AS "spendingCategoryId",
      -- Incomplete item evidence leaves ancillary Product identity unknown;
      -- existing weights still conserve the same cents across the other axes.
      CASE WHEN e."cost" < 0 AND e."lineKind" <> ${expenseLineKindSchema.enum.discount} AND coalesce(d.has_positive, false)
        THEN NULL
        WHEN d.has_unpriced_principal OR d.has_unclassified THEN NULL
        ELSE w."productCategoryId" END AS "productCategoryId",
      CASE WHEN e."cost" < 0 AND e."lineKind" <> ${expenseLineKindSchema.enum.discount} AND coalesce(d.has_positive, false)
        THEN ${expenseProductCategoryRemainderSchema.enum.unknown_refund}
        WHEN d.has_unpriced_principal OR d.has_unclassified THEN ${expenseProductCategoryRemainderSchema.enum.unknown_allocation}
        ELSE coalesce(w."productCategoryRemainder",
          CASE WHEN w."productCategoryId" IS NULL THEN ${expenseProductCategoryRemainderSchema.enum.no_principal} END)
        END AS "productCategoryRemainder",
      -- A trade typed onto the adjustment claims the whole charge at the
      -- adjustment's own cost type; otherwise each share follows its principal.
      -- A share with no principal to follow keeps no trade but the
      -- adjustment's own cost type.
      CASE WHEN e."trade" IS NOT NULL THEN e."trade"::text ELSE w.trade END AS trade,
      CASE WHEN e."trade" IS NOT NULL OR w."costType" IS NULL THEN e."costType"::text
        ELSE w."costType" END AS "costType",
      coalesce(w.basis, ${allocationBasis.default}) AS basis, coalesce(w.weight, 1::bigint) AS weight,
      ${dollarsToMinorSql(sql`e."cost"`)} AS source_cents,
      sum(coalesce(w.weight, 1::bigint)) OVER (PARTITION BY e."id") AS total_weight,
      coalesce(d.has_unpriced_principal, false) AS has_unpriced_principal,
      coalesce(d.has_unclassified, false) AS has_unclassified
    FROM "Expense" e LEFT JOIN "Purchase" p
      ON p."id" = e."purchaseId" AND ${notDeleted("p")}
    LEFT JOIN weights w ON w."purchaseId" = p."id"
    LEFT JOIN purchase_direction d ON d."purchaseId" = p."id"
    ${
      projects
        ? sql`LEFT JOIN "Project" standalone_project
      ON standalone_project."id" = e."projectId" AND ${notDeleted("standalone_project")}`
        : sql``
    }
    WHERE ${notDeleted("e")} AND e."lineKind" NOT IN (${expenseLineKindSchema.enum.principal}, ${expenseLineKindSchema.enum.unclassified})
      ${expenseIds ? sql`AND e."id" IN (SELECT "id" FROM selected_expense)` : sql``}
  ), adjustment_floor AS (
    SELECT *, CASE WHEN source_cents IS NULL THEN NULL ELSE
      floor(abs(source_cents)::numeric * weight::numeric / total_weight)::bigint END AS base_cents,
      CASE WHEN source_cents IS NULL THEN NULL ELSE
        mod(abs(source_cents)::numeric * weight::numeric, total_weight) END AS fractional_rank
    FROM adjustment_seed
  ), adjustment_ranked AS (
    SELECT *, sum(base_cents) OVER (PARTITION BY "expenseId") AS assigned_cents,
      row_number() OVER (PARTITION BY "expenseId"
        ORDER BY fractional_rank DESC NULLS LAST, "principalExpenseId" ASC NULLS LAST) AS remainder_rank
    FROM adjustment_floor
  ), allocated AS (
    SELECT f."expenseId", f."purchaseId", f."expenseId" AS "principalExpenseId",
      f."projectId", f."spendingCategoryId", f."productCategoryId", f."productCategoryRemainder", f.trade, f."costType", f.cost_cents AS source_cents,
      f.cost_cents AS attributed_cents, ${allocationBasis.principal}::text AS basis,
      f.cost_cents IS NULL OR coalesce(d.has_unclassified, false) AS incomplete,
      f."spendingCategoryId" IS NULL OR coalesce(d.has_unclassified, false) AS category_incomplete
    FROM principal_fact f LEFT JOIN purchase_direction d USING ("purchaseId")
    UNION ALL
    SELECT e."id" AS "expenseId", e."purchaseId", NULL::uuid AS "principalExpenseId",
      NULL::uuid AS "projectId", NULL::uuid AS "spendingCategoryId",
      NULL::uuid AS "productCategoryId", ${expenseProductCategoryRemainderSchema.enum.unclassified}::text AS "productCategoryRemainder",
      NULL::text AS trade, e."costType"::text AS "costType",
      ${dollarsToMinorSql(sql`e."cost"`)} AS source_cents,
      ${dollarsToMinorSql(sql`e."cost"`)} AS attributed_cents,
      ${expenseLineKindSchema.enum.unclassified}::text AS basis, true AS incomplete, true AS category_incomplete
    FROM "Expense" e
    WHERE ${notDeleted("e")} AND e."lineKind" = ${expenseLineKindSchema.enum.unclassified}
      ${expenseIds ? sql`AND e."id" IN (SELECT "id" FROM selected_expense)` : sql``}
    UNION ALL
    SELECT r."expenseId", r."purchaseId", r."principalExpenseId", r."projectId", r."spendingCategoryId",
      r."productCategoryId", r."productCategoryRemainder", r.trade, r."costType", r.source_cents, CASE WHEN r.source_cents IS NULL THEN NULL ELSE
        sign(r.source_cents) * (r.base_cents + CASE
          WHEN r.remainder_rank <= abs(r.source_cents) - r.assigned_cents THEN 1 ELSE 0 END)
      END::bigint AS attributed_cents, r.basis,
      r.source_cents IS NULL OR r.basis = ${allocationBasis.default} OR r.has_unpriced_principal OR r.has_unclassified AS incomplete,
      r."spendingCategoryId" IS NULL OR r.has_unpriced_principal OR r.has_unclassified
        -- Unresolved roles are read from principals, so an order with none
        -- checks them directly before its own category counts as complete.
        OR (r.basis = ${allocationBasis.default} AND EXISTS (SELECT 1 FROM "Expense" unknown_role
          WHERE unknown_role."purchaseId" = r."purchaseId" AND ${notDeleted("unknown_role")}
            AND unknown_role."lineKind" = ${expenseLineKindSchema.enum.unclassified}))
        AS category_incomplete
    FROM adjustment_ranked r
  )
  SELECT a."expenseId", a."purchaseId", a."principalExpenseId", a."projectId",
    ${projects ? sql`p."shortcode"` : sql`NULL::text`} AS "projectShortcode", ${projects ? sql`p."name"` : sql`NULL::text`} AS "projectName",
    a."productCategoryId", pc.shortcode AS "productCategoryShortcode", pc.name AS "productCategoryName",
    a."productCategoryRemainder",
    a."spendingCategoryId", c."shortcode" AS "spendingCategoryShortcode", c."name" AS "spendingCategoryName",
    a.source_cents::text AS "sourceCents", a.attributed_cents::text AS "attributedCents",
    a.basis, a.incomplete, a.category_incomplete AS "categoryIncomplete",
    a.trade, a."costType"
  FROM allocated a
  ${projects ? sql`LEFT JOIN "Project" p ON p."id" = a."projectId" AND ${notDeleted("p")}` : sql``}
  LEFT JOIN "ProductCategory" pc ON pc.id = a."productCategoryId" AND ${notDeleted("pc")}
  LEFT JOIN ${spendingCategoryCatalogSql(draft)} c ON c."id" = a."spendingCategoryId" AND ${notDeleted("c")}
  ${expenseIds ? sql`WHERE a."expenseId" IN (SELECT "id" FROM selected_expense)` : sql``}
`;
};

export type ExpenseAllocationProjectScope = {
  projectIds?: readonly ProjectId[];
  presence?: "has" | "none";
  spendingCategoryIds?: readonly SpendingCategoryId[];
  categoryPresence?: "has" | "none";
  productCategoryIds?: readonly ProductCategoryId[];
  productCategoryPresence?: "has" | "none";
  productCategoryRemainders?: readonly ExpenseProductCategoryRemainder[];
  trades?: readonly Trade[];
  tradePresence?: "has" | "none";
  costTypes?: readonly CostType[];
  costTypePresence?: "has" | "none";
};

export const expenseAllocationScopeConditionSql = (
  alias: string,
  scope: ExpenseAllocationProjectScope,
): SQL | undefined => {
  const allocation = sql.raw(alias);
  const projectMatch = scope.projectIds
    ? scope.projectIds.length === 0
      ? sql`false`
      : sql`${allocation}."projectId" = ANY(${uuidArrayParam(scope.projectIds)})`
    : undefined;
  const presenceMatch =
    scope.presence === "has"
      ? sql`${allocation}."projectId" IS NOT NULL`
      : scope.presence === "none"
        ? sql`${allocation}."projectId" IS NULL`
        : undefined;
  const projectCondition =
    projectMatch && presenceMatch
      ? sql`(${projectMatch} OR ${presenceMatch})`
      : (projectMatch ?? presenceMatch);
  const categoryMatch = scope.spendingCategoryIds
    ? scope.spendingCategoryIds.length === 0
      ? sql`false`
      : sql`${allocation}."spendingCategoryId" = ANY(${uuidArrayParam(scope.spendingCategoryIds)})`
    : undefined;
  const categoryPresence =
    scope.categoryPresence === "has"
      ? sql`${allocation}."spendingCategoryId" IS NOT NULL`
      : scope.categoryPresence === "none"
        ? sql`${allocation}."spendingCategoryId" IS NULL`
        : undefined;
  const categoryCondition =
    categoryMatch && categoryPresence
      ? sql`(${categoryMatch} OR ${categoryPresence})`
      : (categoryMatch ?? categoryPresence);
  const shareMatch = (column: string, values?: readonly string[]) =>
    values === undefined
      ? undefined
      : values.length === 0
        ? sql`false`
        : sql`${allocation}.${sql.raw(`"${column}"`)} IN (${sql.join(
            values.map((value) => sql`${value}`),
            sql`, `,
          )})`;
  // Picked values OR with the column's presence, as the list's filters do.
  const valuesOrPresence = (
    column: string,
    values: readonly string[] | undefined,
    presence: "has" | "none" | undefined,
  ) => {
    const match = shareMatch(column, values);
    const present =
      presence === undefined
        ? undefined
        : sql`${allocation}.${sql.raw(`"${column}"`)} IS ${sql.raw(presence === "has" ? "NOT NULL" : "NULL")}`;
    return match && present
      ? sql`(${match} OR ${present})`
      : (match ?? present);
  };
  const conditions = [
    projectCondition,
    categoryCondition,
    valuesOrPresence(
      "productCategoryId",
      scope.productCategoryIds,
      scope.productCategoryPresence,
    ),
    shareMatch("productCategoryRemainder", scope.productCategoryRemainders),
    valuesOrPresence("trade", scope.trades, scope.tradePresence),
    valuesOrPresence("costType", scope.costTypes, scope.costTypePresence),
  ].filter((condition) => condition !== undefined);
  return conditions.length === 0
    ? undefined
    : sql`(${sql.join(conditions, sql` AND `)})`;
};

export async function loadExpenseProjectAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
): Promise<ExpenseProjectAllocationRow[]> {
  const { expenseDerivedReadSql } = await import("./expense-derived-read");
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseProjectAllocationRow>
  >(expenseDerivedReadSql("projects", { expenseIds }));
  return result.rows.map((row) => ({
    ...row,
    sourceCents: row.sourceCents === null ? null : BigInt(row.sourceCents),
    attributedCents:
      row.attributedCents === null ? null : BigInt(row.attributedCents),
  }));
}

export type ExpenseJointAllocationRawRow =
  RawAllocationRow<ExpenseJointAllocationRow>;

/** Rows of `expenseJointAllocationSql`, as selected or as `to_jsonb` of one. */
export const parseExpenseJointAllocationRows = (
  rows: readonly ExpenseJointAllocationRawRow[],
): ExpenseJointAllocationRow[] =>
  rows.map((row) => ({
    ...row,
    sourceCents: row.sourceCents === null ? null : BigInt(row.sourceCents),
    attributedCents:
      row.attributedCents === null ? null : BigInt(row.attributedCents),
  }));

export async function loadExpenseJointAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
  draft?: ExpenseSpendingCategoryResolutionDraft,
): Promise<ExpenseJointAllocationRow[]> {
  const { expenseDerivedReadSql } = await import("./expense-derived-read");
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseJointAllocationRow>
  >(expenseDerivedReadSql("shares", { expenseIds, draft }));
  return parseExpenseJointAllocationRows(result.rows);
}
