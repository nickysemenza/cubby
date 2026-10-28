import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/domains/expense/repo/expense-inheritance";
import { classificationPolicySql } from "~/server/domains/spending-category/repo/classification-field-policy";
import { createBlockedError } from "~/server/errors/app-error";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";

export type InheritanceScope =
  | {
      kind:
        | "task"
        | "project"
        | "product"
        | "productCategory"
        | "spendingCategory"
        | "purchase";
      ids: readonly string[];
    }
  | { kind: "all"; purpose: "maintenance" };

const idsSql = (ids: readonly string[]) =>
  ids.length
    ? sql`(${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`(SELECT NULL::uuid WHERE false)`;

/** This affected graph is the explicitly approved authoritative-validation exception. */
function scopePredicate(
  scope: InheritanceScope,
  entity: "task" | "expense",
): SQL {
  if (scope.kind === "all") return sql`true`;
  const roots = idsSql(scope.ids);
  if (scope.kind === "task")
    return entity === "task"
      ? sql`t.id IN ${hierarchyDescendantsSql("task", roots)}`
      : sql`false`;
  if (scope.kind === "project") {
    const projects = hierarchyDescendantsSql("project", roots);
    return entity === "task"
      ? sql`${effectiveFieldSql("task", "projectId", "t")} IN ${projects}`
      : sql`${effectiveExpenseProjectSql("e")} IN ${projects}`;
  }
  if (scope.kind === "purchase")
    return entity === "expense" ? sql`e."purchaseId" IN ${roots}` : sql`false`;
  if (scope.kind === "spendingCategory")
    return entity === "expense"
      ? sql`${effectiveExpenseSpendingCategorySql("e")} IN ${hierarchyDescendantsSql("spendingCategory", roots)}`
      : sql`false`;
  const products =
    scope.kind === "product"
      ? roots
      : sql`(SELECT p.id FROM "Product" p
    WHERE p."categoryId" IN ${hierarchyDescendantsSql("productCategory", roots)} AND ${notDeleted("p")})`;
  return entity === "task"
    ? sql`${effectiveFieldSql("task", "subjectProductId", "t")} IN ${products}`
    : sql`e."productId" IN ${products}`;
}

/**
 * Validate the prospective graph before committing any change that can move
 * an inherited value: required trades resolve, and no Product sits on an
 * Expense whose spending category forbids one.
 */
export async function validateLiveInheritedPolicies(
  tx: Database | DrizzleTransaction,
  scope: InheritanceScope,
): Promise<void> {
  await validateLiveEffectiveTrades(tx, scope);
  await validateLiveProductPolicy(tx, { inherited: scope });
}

/**
 * Required trades only, for a Task or Project write: those cannot move an
 * Expense's effective spending category, so they skip the Product scan.
 */
export async function validateLiveEffectiveTrades(
  tx: Database | DrizzleTransaction,
  scope: InheritanceScope,
): Promise<void> {
  const result = await unwrapDb(tx).execute<{
    entity: string;
    shortcode: string;
    name: string;
  }>(sql`
    SELECT 'task' AS entity, t."shortcode", t."name"
    FROM "Task" t
    WHERE ${scopePredicate(scope, "task")} AND ${notDeleted("t")} AND ${effectiveFieldSql("task", "trade", "t")} IS NULL
    UNION ALL
    SELECT 'expense', e."shortcode", e."name"
    FROM "Expense" e
    WHERE ${scopePredicate(scope, "expense")} AND ${notDeleted("e")} AND e."lineKind" = 'principal'
      AND ${effectiveExpenseTradeSql("e")} IS NULL
    LIMIT 51
  `);
  if (result.rows.length === 0) return;
  throw createBlockedError(
    "CONSTRAINT_VIOLATION",
    "This change leaves required trades unresolved. Choose a trade or supply a default for the affected records.",
    result.rows.slice(0, 50).map((row) =>
      publicImpactItemSchema.parse({
        code: "required-trade-unresolved",
        effect: "block",
        label: row.name,
        description: `${row.shortcode} needs a trade after this change.`,
        total: 1,
        byTargetId: { [row.shortcode]: 1 },
      }),
    ),
    { incomplete: result.rows.length > 50 },
  );
}

/** Which Expenses a line-level write touched; omitted checks the whole graph. */
export type ProductPolicyScope =
  | { expenseIds: readonly string[] }
  | { purchaseId: string }
  | { vendorId: string }
  | { inherited: InheritanceScope };

/**
 * The product policy for the Expenses a line-level write touched, for a
 * Vendor's Purchases, or for the whole graph after a change to a category or
 * classification policy.
 */
export const validateProductPolicy = (
  tx: Database | DrizzleTransaction,
  scope: ProductPolicyScope,
) => validateLiveProductPolicy(tx, scope);

/**
 * A spending category with `productExpectation: not_allowed` (a restaurant
 * meal) forbids a Product on its Expenses. The category is the effective one
 * (override, Vendor food context, Product mapping, Purchase or Vendor
 * default), so a change to any of those can create a violation; the fix is a
 * line-level category override or unlinking the Product.
 */
async function validateLiveProductPolicy(
  tx: Database | DrizzleTransaction,
  scope: ProductPolicyScope,
): Promise<void> {
  if (scope && "expenseIds" in scope && scope.expenseIds.length === 0) return;
  const result = await unwrapDb(tx).execute<{
    shortcode: string;
    name: string;
    category: string;
  }>(sql`
    SELECT e."shortcode", e."name", sc."name" AS category
    FROM "Expense" e
    JOIN "SpendingCategory" sc
      ON sc.id = ${effectiveExpenseSpendingCategorySql("e")}
      AND ${notDeleted("sc")}
    WHERE ${notDeleted("e")}
      AND e."lineKind" = 'principal'
      AND e."productId" IS NOT NULL
      AND ${classificationPolicySql(
        "spendingCategory.productExpectation",
        "productId",
        "not_allowed",
        effectiveExpenseSpendingCategorySql("e"),
      )}
      ${
        "inherited" in scope
          ? sql`AND ${scopePredicate(scope.inherited, "expense")}`
          : "purchaseId" in scope
            ? sql`AND e."purchaseId" = ${scope.purchaseId}::uuid`
            : "vendorId" in scope
              ? sql`AND e."purchaseId" IN (SELECT p.id FROM "Purchase" p WHERE p."vendorId" = ${scope.vendorId}::uuid)`
              : sql`AND e.id IN (${sql.join(
                  scope.expenseIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})`
      }
    ORDER BY e."shortcode"
    LIMIT 51
  `);
  if (result.rows.length === 0) return;
  throw createBlockedError(
    "CONSTRAINT_VIOLATION",
    "This change links a Product to spending whose category does not allow one. Give the line its own spending category, or unlink the Product.",
    result.rows.slice(0, 50).map((row) =>
      publicImpactItemSchema.parse({
        code: "product-not-allowed",
        effect: "block",
        label: row.name,
        description: `${row.shortcode} links a Product, but its spending category "${row.category}" does not allow one.`,
        total: 1,
        byTargetId: { [row.shortcode]: 1 },
      }),
    ),
    { incomplete: result.rows.length > 50 },
  );
}
