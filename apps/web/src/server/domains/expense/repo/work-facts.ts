import { sql } from "drizzle-orm";

import { expense } from "~/server/db/schema";
export const expenseWorkFacts = () => ({
  amount: sql`${expense.cost}`,
  date: sql`${expense.date}`,
});
