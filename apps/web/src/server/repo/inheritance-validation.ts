import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createBlockedError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers";

import { effectiveExpenseSpendingCategorySql } from "./expense-category-resolution";
import { effectiveExpenseTradeSql } from "./expense-inheritance";
import { effectiveTaskTradeSql } from "./task-project-inheritance";

/**
 * Validate the prospective graph before committing any change that can move
 * an inherited value: required trades resolve, and no Product sits on an
 * Expense whose spending category forbids one.
 */
export async function validateLiveInheritedPolicies(
  tx: Database | DrizzleTransaction,
): Promise<void> {
  await validateLiveEffectiveTrades(tx);
  await validateLiveProductPolicy(tx);
}

/**
 * Required trades only, for a Task or Project write: those cannot move an
 * Expense's effective spending category, so they skip the Product scan.
 */
export async function validateLiveEffectiveTrades(
  tx: Database | DrizzleTransaction,
): Promise<void> {
  const result = await unwrapDb(tx).execute<{
    entity: string;
    shortcode: string;
    name: string;
  }>(sql`
    SELECT 'task' AS entity, t."shortcode", t."name"
    FROM "Task" t
    WHERE t."deletedAt" IS NULL AND ${effectiveTaskTradeSql("t")} IS NULL
    UNION ALL
    SELECT 'expense', e."shortcode", e."name"
    FROM "Expense" e
    WHERE e."deletedAt" IS NULL AND e."lineKind" = 'principal'
      AND ${effectiveExpenseTradeSql("e")} IS NULL
  `);
  if (result.rows.length === 0) return;
  throw createBlockedError(
    "CONSTRAINT_VIOLATION",
    "This change leaves required trades unresolved. Choose a trade or supply a default for the affected records.",
    result.rows.map((row) =>
      publicImpactItemSchema.parse({
        code: "required-trade-unresolved",
        effect: "block",
        label: row.name,
        description: `${row.shortcode} needs a trade after this change.`,
        total: 1,
        byTargetId: { [row.shortcode]: 1 },
      }),
    ),
  );
}

/** Which Expenses a line-level write touched; omitted checks the whole graph. */
type ProductPolicyScope =
  | { expenseIds: readonly string[] }
  | { purchaseId: string }
  | { vendorId: string };

/**
 * The product policy for the Expenses a line-level write touched, for a
 * Vendor's Purchases, or for the whole graph after a change to a category or
 * classification policy.
 */
export const validateProductPolicy = (
  tx: Database | DrizzleTransaction,
  scope?: ProductPolicyScope,
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
  scope?: ProductPolicyScope,
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
      AND sc."deletedAt" IS NULL
    WHERE EXISTS (
        SELECT 1 FROM "SpendingCategory" forbidding
        WHERE forbidding."productExpectation" = 'not_allowed'
          AND forbidding."deletedAt" IS NULL
      )
      AND e."deletedAt" IS NULL
      AND e."lineKind" = 'principal'
      AND e."productId" IS NOT NULL
      AND sc."productExpectation" = 'not_allowed'
      ${
        !scope
          ? sql``
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
    LIMIT 50
  `);
  if (result.rows.length === 0) return;
  throw createBlockedError(
    "CONSTRAINT_VIOLATION",
    "This change links a Product to spending whose category does not allow one. Give the line its own spending category, or unlink the Product.",
    result.rows.map((row) =>
      publicImpactItemSchema.parse({
        code: "product-not-allowed",
        effect: "block",
        label: row.name,
        description: `${row.shortcode} links a Product, but its spending category "${row.category}" does not allow one.`,
        total: 1,
        byTargetId: { [row.shortcode]: 1 },
      }),
    ),
  );
}
