import { expenseEconomicRoleSchema } from "@cubby/schemas/expense-fields";
import { sql } from "drizzle-orm";

import { actualExpenseSql, notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { productSellerPurchasesSql } from "~/server/domains/product/repo/product-counterparties";

/**
 * One row per live Expense, before any list membership expands it. Values
 * retain their sign and unknown costs remain NULL. The basis is direct
 * Expense.cost, like Product expense total; allocated Purchase tax/shipping
 * is a different basis and must not silently enter these metrics.
 */
export const productSpendingEvidenceSql = sql`
  SELECT owner, identity, value, seller, counterparty,
    actual AND "vendorOwned" AND seller IS NOT NULL AS "sellerSpending",
    actual AND "vendorOwned" AND seller IS NULL AS unattributed,
    NOT actual AS planned,
    actual AND NOT "vendorOwned" AS reimbursement
  FROM (
  SELECT spending_expense."productId" AS owner,
    spending_expense."id" AS identity, spending_expense."cost" AS value,
    ${sql.raw(actualExpenseSql("spending_expense"))} AS actual,
    spending_expense."economicRole" = ${sqlEnumConstant(expenseEconomicRoleSchema, expenseEconomicRoleSchema.enum.vendor)} AS "vendorOwned",
    spending_seller."id" AS seller,
    spending_vendor."id" AS counterparty
  FROM "Expense" spending_expense
  LEFT JOIN (${productSellerPurchasesSql}) spending_acquisition
    ON spending_acquisition.owner = spending_expense."productId"
    AND spending_acquisition."purchaseId" = spending_expense."purchaseId"
  LEFT JOIN "Vendor" spending_seller
    ON spending_seller."id" = spending_acquisition.seller
    AND ${notDeleted("spending_seller")}
  LEFT JOIN "Purchase" spending_purchase
    ON spending_purchase."id" = spending_expense."purchaseId"
    AND ${notDeleted("spending_purchase")}
  LEFT JOIN "Vendor" spending_vendor
    ON spending_vendor."id" = spending_purchase."vendorId"
    AND ${notDeleted("spending_vendor")}
  WHERE ${notDeleted("spending_expense")}
    AND spending_expense."productId" IS NOT NULL
  ) product_spending
`;
