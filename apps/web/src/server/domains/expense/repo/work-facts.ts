import { sql } from "drizzle-orm";

import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import { expense } from "~/server/db/schema";
export const expenseWorkFacts = () => ({
  amount: expenseCostDollarsSql(),
  date: sql`${expense.date}`,
});
