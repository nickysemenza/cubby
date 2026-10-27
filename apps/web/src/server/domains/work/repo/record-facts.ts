import type { Entity } from "@cubby/schemas/entity";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySql } from "~/server/db/helpers/query";
import {
  expense,
  email,
  financialTransaction,
  purchase,
  run,
} from "~/server/db/schema";

type RecordFacts = { amount: SQL; date: SQL };
const recordFacts = {
  run: {
    table: sql`${run}`,
    amount: sql`NULL::double precision`,
    date: householdDaySql(sql`"Run"."startedAt"`),
  },
  purchase: {
    table: sql`${purchase}`,
    amount: sql`(SELECT sum(e.cost::numeric)::double precision FROM "Expense" e
      WHERE e."purchaseId" = "Purchase".id AND ${notDeleted(alias(expense, "e"))})`,
    date: sql`"Purchase"."date"`,
  },
  expense: {
    table: sql`${expense}`,
    amount: sql`"Expense".cost::double precision`,
    date: sql`"Expense"."date"`,
  },
  financialTransaction: {
    table: sql`${financialTransaction}`,
    amount: sql`"FinancialTransaction".amount::double precision`,
    date: sql`coalesce("FinancialTransaction"."postedDate", "FinancialTransaction"."transactionDate")`,
  },
  email: {
    table: sql`${email}`,
    amount: sql`NULL::double precision`,
    date: householdDaySql(sql`"Email"."receivedAt"`),
  },
} satisfies Partial<Record<Entity, RecordFacts & { table: SQL }>>;

/** Variable-record sources retain the named record's own facts. */
export const workRecordFacts = (kind: SQL, id: SQL) => {
  const pick = (fact: keyof RecordFacts) =>
    sql`CASE ${kind} ${sql.join(
      Object.entries(recordFacts).map(
        ([entity, facts]) =>
          sql`WHEN ${entity} THEN (SELECT (${facts[fact]}) FROM ${facts.table} WHERE ${facts.table}.id = ${id})`,
      ),
      sql` `,
    )} END`;
  return { amount: pick("amount"), date: pick("date") };
};

/** Static record sources already select from the fact's owning table. */
export const workRecordFactsFor = (entity: Entity): RecordFacts => {
  const facts = Object.entries(recordFacts).find(
    ([key]) => key === entity,
  )?.[1];
  return {
    amount: facts?.amount ?? sql`NULL::double precision`,
    date: facts?.date ?? sql`NULL::date`,
  };
};
