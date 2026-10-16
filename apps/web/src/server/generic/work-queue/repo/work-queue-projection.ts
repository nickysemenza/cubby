import type { DataCheck } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { WorkQueueRow } from "@cubby/schemas/work-queue";
import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { householdDaySql } from "~/server/db/helpers/query";
import {
  email,
  expense,
  financialTransaction,
  purchase,
} from "~/server/db/retained-tables";

type Candidate = Pick<
  WorkQueueRow,
  "source" | "kind" | "reason" | "nextAction"
>;

/** Narrows the branches one read builds. Every narrowing lands inside a
 * branch's own WHERE, so counts and pages see only admitted rows and a record
 * read never plans the whole queue. */
export type WorkQueueScope = {
  /** Any-of; problem branches outside these drop out. */
  sources?: readonly WorkQueueRow["source"][];
  kinds?: readonly WorkQueueRow["kind"][];
  /** Only gap-carrying branches survive, narrowed to these checks. */
  check?: readonly DataCheck[];
  record?: { entity: ShortcodeEntity; id: string };
  /** Typed facts needed for population filtering/sorting; others load on the page. */
  facts?: readonly (keyof RecordFacts)[];
};

type RecordFacts = { amount: SQL; date: SQL; vendor: SQL };

/**
 * A record's own typed facts, one declaration per entity, used by its direct
 * branches and by findings that name it. A Purchase's amount is
 * SUM(Expense.cost) (README tenet), null when no line is priced.
 */
const recordFacts = {
  purchase: {
    table: sql`${purchase}`,
    amount: sql`(SELECT sum(e.cost::numeric)::double precision FROM "Expense" e
      WHERE e."purchaseId" = "Purchase".id AND e."deletedAt" IS NULL)`,
    date: sql`"Purchase"."date"`,
    vendor: sql`"Purchase"."vendorId"`,
  },
  expense: {
    table: sql`${expense}`,
    amount: sql`"Expense".cost`,
    date: sql`"Expense"."date"`,
    vendor: sql`(SELECT p."vendorId" FROM "Purchase" p WHERE p.id = "Expense"."purchaseId" AND p."deletedAt" IS NULL)`,
  },
  financialTransaction: {
    table: sql`${financialTransaction}`,
    amount: sql`"FinancialTransaction".amount`,
    date: sql`coalesce("FinancialTransaction"."postedDate", "FinancialTransaction"."transactionDate")`,
    vendor: sql`NULL`,
  },
  email: {
    table: sql`${email}`,
    amount: sql`NULL`,
    date: householdDaySql(sql`"Email"."receivedAt"`),
    vendor: sql`(SELECT mail."vendorId" FROM "OrderMail" mail WHERE mail.id = "Email"."orderMailId")`,
  },
} satisfies Partial<Record<Entity, RecordFacts & { table: SQL }>>;

const NO_FACTS: RecordFacts = {
  amount: sql`NULL`,
  date: sql`NULL`,
  vendor: sql`NULL`,
};

const factsOf = (entity: Entity): RecordFacts =>
  Object.entries(recordFacts).find(([key]) => key === entity)?.[1] ?? NO_FACTS;

const FACT_TYPES = {
  amount: sql.raw("double precision"),
  date: sql.raw("date"),
  vendor: sql.raw("uuid"),
} satisfies Record<keyof RecordFacts, SQL>;

const factColumns = (
  facts: RecordFacts,
  selected?: WorkQueueScope["facts"],
): SQL => {
  const pick = (fact: keyof RecordFacts) =>
    selected === undefined || selected.includes(fact) ? facts[fact] : sql`NULL`;
  return sql`(${pick("amount")})::${FACT_TYPES.amount} AS amount, (${pick("date")})::${FACT_TYPES.date} AS date, (${pick("vendor")})::${FACT_TYPES.vendor} AS vendor_id`;
};

/** Facts for a finding's UUID or a selected page row's public identity. */
export const workRecordFactColumns = (
  kind: SQL,
  id: SQL,
  selected?: WorkQueueScope["facts"],
  identity: "id" | "shortcode" = "id",
): SQL => {
  const pick = (fact: keyof RecordFacts) =>
    sql`CASE ${kind} ${sql.join(
      Object.entries(recordFacts).map(
        ([entity, facts]) =>
          sql`WHEN ${entity} THEN (SELECT (${facts[fact]})::${FACT_TYPES[fact]} FROM ${facts.table} WHERE ${facts.table}.${sql.identifier(identity)} = ${id})`,
      ),
      sql` `,
    )} END`;
  return factColumns(
    { amount: pick("amount"), date: pick("date"), vendor: pick("vendor") },
    selected,
  );
};

export const NO_FACT_COLUMNS = factColumns(NO_FACTS);

/** Whether a branch without its own record id or gaps survives this scope. */
export const scopeAdmitsUnrecorded = (scope: WorkQueueScope) =>
  !scope.record && !scope.check;

/** One record branch, or none when the scope excludes it. */
export const workQueueCandidate = (
  scope: WorkQueueScope,
  {
    entity,
    table,
    id,
    name,
    owners,
    where,
    details,
    key,
    shared = false,
    carriesGaps = false,
  }: {
    entity: Entity;
    table: PgTable | SQL;
    id: SQL;
    name: SQL;
    owners: SQL;
    where: SQL | undefined;
    details: { [K in keyof Candidate]: Candidate[K] | SQL };
    key: string;
    shared?: boolean | SQL;
    /** The branch's WHERE already narrows to the scope's checks. */
    carriesGaps?: boolean;
  },
): SQL[] => {
  if (scope.check && !carriesGaps) return [];
  if (scope.record && scope.record.entity !== entity) return [];
  const record = scope.record
    ? sql` AND ${id}::text = ${scope.record.id}`
    : sql``;
  return [
    sql`SELECT ${entity}::text AS entity, ${id}::text AS id,
  ${name}::text AS name, ${key}::text || ':' || ${id}::text AS key,
  ${details.source}::text AS source, ${details.kind}::text AS kind,
  ${details.reason}::text AS reason, ${details.nextAction}::text AS "nextAction",
  ${owners}::uuid[] AS owners, ${shared}::boolean AS shared, NULL::text AS "problemKey",
  ${factColumns(factsOf(entity), scope.facts)}
  FROM ${table} WHERE (${where ?? sql`true`})${record}`,
  ];
};

export const workDiagnosticCandidate = (
  problemKey: string,
  key: string,
  name: string,
  owners: SQL,
  details: Candidate,
  shared: boolean | SQL = false,
): SQL => sql`SELECT NULL::text AS entity, NULL::text AS id,
  ${name}::text AS name, ${key}::text AS key,
  ${details.source}::text AS source, ${details.kind}::text AS kind,
  ${details.reason}::text AS reason, ${details.nextAction}::text AS "nextAction",
  ${owners}::uuid[] AS owners, ${shared}::boolean AS shared, ${problemKey}::text AS "problemKey",
  ${NO_FACT_COLUMNS}`;
