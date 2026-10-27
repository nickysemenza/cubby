import { sql } from "drizzle-orm";

import { outer, related } from "~/server/db/helpers/related";
import { purchase, expense } from "~/server/db/schema";
export const purchaseWorkFacts = () => ({
  amount: related(
    expense,
    (line) => sql`${line.purchaseId} = ${outer(purchase.id)}`,
  ).value((line) => sql`sum(${line.cost}::numeric)::double precision`),
  date: sql`${purchase.date}`,
});
