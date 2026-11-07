import { expenseEconomicRoleSchema } from "@cubby/schemas/expense-fields";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { expenseAcquisitionSql } from "~/server/db/computed/expense-aggregate-sql";
import { actualExpenseSql, notDeleted } from "~/server/db/helpers/predicates";
import { entityLink } from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

const confirmedLink = alias(entityLink, "acquisition_link");

/**
 * Acquisition evidence belongs to a Product and Purchase together. An item
 * bought beside a trade-in cannot turn that trade-in into an acquisition.
 * All signed vendor lines of an eligible pair, including refunds, can then
 * contribute to its spending. A confirmed member decision is authoritative.
 */
export const purchaseProductAcquisitionPairsSql = sql`
  SELECT DISTINCT acquisition_expense."purchaseId", acquisition_expense."productId"
  FROM "Expense" acquisition_expense
  WHERE ${notDeleted("acquisition_expense")}
    AND ${sql.raw(actualExpenseSql("acquisition_expense"))}
    AND acquisition_expense."economicRole" = ${sqlEnumConstant(expenseEconomicRoleSchema, expenseEconomicRoleSchema.enum.vendor)}
    AND acquisition_expense."productId" IS NOT NULL
    AND acquisition_expense."purchaseId" IS NOT NULL
    AND ${sql.raw(expenseAcquisitionSql("acquisition_expense"))}
  UNION
  SELECT acquisition_link."fromEntityId" AS "purchaseId", acquisition_link."toEntityId" AS "productId"
  FROM "EntityLink" acquisition_link
  WHERE ${liveLinks("purchaseProduct", confirmedLink)}
    AND acquisition_link."acquisitionConfirmed"
`;
