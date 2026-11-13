import { sql } from "drizzle-orm";

import { minorToDollarsSql } from "~/server/db/computed/money";
import { outer, related } from "~/server/db/helpers/related";
import { purchase, expense } from "~/server/db/schema";
export const purchaseWorkFacts = () => ({
  amount: related(
    expense,
    (line) => sql`${line.purchaseId} = ${outer(purchase.id)}`,
  ).value((line) => minorToDollarsSql(sql`sum(${line.cost})`, "float8")),
  date: sql`${purchase.date}`,
});
