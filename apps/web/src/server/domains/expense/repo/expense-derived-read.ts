import type { ExpenseId } from "@cubby/schemas/identifiers";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { sql, type SQL, type SQLWrapper, type Subquery } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { expenseAggregateFields } from "~/server/db/computed/expense-aggregate-sql";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";

import type { ExpenseSpendingCategoryResolutionDraft } from "./expense-category-resolution";
import {
  expenseAllocationScopeConditionSql,
  expenseJointAllocationSql,
  expenseSelectionConditionSql,
  expenseSelectionIdsSql,
  type ExpenseIdSelection,
  type ExpenseIdRelation,
  type ExpenseAllocationProjectScope,
  type ExpenseJointAllocationRow,
} from "./expense-project-allocation";
import type { ExpenseSpendingAllocationRow } from "./expense-spending-allocation";

/** Each read declares its allocation dimensions before execution. Scope is
 * applied to rounded output shares, never to the complete sibling denominator. */
const derivedReads = {
  shares: { categories: true, projects: true },
  projects: { categories: false, projects: true },
  categories: { categories: true, projects: true },
  costs: { categories: false, projects: true },
  membership: { categories: false, projects: false },
  names: { categories: false, projects: true },
  categoryNames: { categories: true, projects: true },
  presence: { categories: false, projects: true },
  categoryEvidence: { categories: true, projects: true },
} satisfies Record<string, { categories: boolean; projects: boolean }>;

type DerivedRead = keyof typeof derivedReads;
type DerivedReadOptions = {
  scope?: ExpenseAllocationProjectScope;
  draft?: ExpenseSpendingCategoryResolutionDraft;
  expenseIds?: ExpenseIdSelection;
  source?: SQL;
};

export function expenseDerivedReadSql(
  read: DerivedRead,
  { scope, expenseIds, draft, source: preparedSource }: DerivedReadOptions = {},
): SQL {
  if (read === "costs" && !scope)
    return sql`SELECT source."id" AS "expenseId", source."cost" AS cost,
      round(source."cost"::numeric * 100)::bigint AS "costCents", source."projectId"
      FROM "Expense" source WHERE source."deletedAt" IS NULL
      ${expenseIds ? sql`AND ${expenseSelectionConditionSql(sql`source."id"`, expenseIds)}` : sql``}`;
  if (read === "categoryEvidence")
    return sql`SELECT "expenseId",
        bool_or("spendingCategoryId" IS NULL OR incomplete) AS missing,
        jsonb_agg(jsonb_build_array("spendingCategoryId", amount, incomplete) ORDER BY "spendingCategoryId") AS evidence
        FROM (${expenseDerivedReadSql("categories", { scope, expenseIds, draft, source: preparedSource })}) category_share
        GROUP BY "expenseId"`;
  const categories =
    derivedReads[read].categories ||
    scope?.spendingCategoryIds !== undefined ||
    scope?.categoryPresence !== undefined;
  const trades = categories || scope?.trades !== undefined;
  const projects =
    derivedReads[read].projects ||
    scope?.projectIds !== undefined ||
    scope?.presence !== undefined ||
    scope?.membershipProjectIds !== undefined;
  const condition = scope
    ? expenseAllocationScopeConditionSql("allocation", scope)
    : undefined;
  const source =
    preparedSource ??
    expenseJointAllocationSql(expenseIds, draft, {
      categories,
      trades,
      projects,
    });
  const membership = scope?.membershipProjectIds;
  const allocations =
    membership === undefined
      ? sql`SELECT allocation.* FROM (${source}) allocation WHERE ${condition ?? sql`true`}`
      : sql`WITH derived_allocation AS MATERIALIZED (${source})
      SELECT allocation.* FROM derived_allocation allocation
      WHERE ${condition ?? sql`true`} AND allocation."expenseId" IN (
        SELECT "expenseId" FROM derived_allocation
        WHERE "projectId" = ANY(${uuidArrayParam(membership)})
      )`;
  switch (read) {
    case "membership":
      return sql`SELECT "expenseId" FROM (${allocations}) member_share`;
    case "shares":
      return allocations;
    case "projects":
      return sql`SELECT a."expenseId", a."purchaseId", a."projectId", a."projectShortcode", a."projectName",
        max(a."sourceCents"::bigint)::text AS "sourceCents",
        sum(a."attributedCents"::bigint)::text AS "attributedCents",
        a.basis, bool_or(a.incomplete) AS incomplete
        FROM (${allocations}) a
        GROUP BY a."expenseId", a."purchaseId", a."projectId", a."projectShortcode", a."projectName", a.basis`;
    case "categories":
      return sql`SELECT a."expenseId", a."spendingCategoryId", a."spendingCategoryShortcode", a."spendingCategoryName",
        (sum(a."attributedCents"::bigint) / 100.0)::float8 AS amount,
        a.basis, bool_or(a."categoryIncomplete") AS incomplete,
        array_remove(array_agg(DISTINCT a.trade), NULL) AS trades,
        array_remove(array_agg(DISTINCT a."costType"), NULL) AS "costTypes"
        FROM (${allocations}) a
        GROUP BY a."expenseId", a."spendingCategoryId", a."spendingCategoryShortcode", a."spendingCategoryName", a.basis
        ORDER BY a."expenseId", a."spendingCategoryId" NULLS LAST`;
    case "costs":
      if (!condition)
        return sql`SELECT DISTINCT source."id" AS "expenseId", source.cost,
        round(source.cost::numeric * 100)::bigint AS "costCents", source."projectId"
        FROM (${allocations}) derived_share JOIN "Expense" source ON source.id = derived_share."expenseId"`;
      return sql`SELECT "expenseId", (sum("attributedCents"::bigint) / 100.0)::float8 AS cost,
        sum("attributedCents"::bigint) AS "costCents", min("projectId"::text)::uuid AS "projectId"
        FROM (${allocations}) derived_share GROUP BY "expenseId"`;
    case "names":
    case "categoryNames":
      return sql`SELECT "expenseId",
        string_agg(DISTINCT "projectName", ', ' ORDER BY "projectName") AS "projectNames",
        string_agg(DISTINCT "spendingCategoryName", ', ' ORDER BY "spendingCategoryName") AS "spendingCategoryNames"
        FROM (${allocations}) derived_share GROUP BY "expenseId"`;
    case "presence":
      return sql`SELECT "expenseId", bool_or("projectId" IS NOT NULL) AS "anyProject",
        bool_or("projectId" IS NULL) AS "noProject"
        FROM (${allocations}) derived_share GROUP BY "expenseId"`;
  }
}

/** Plain-root list predicates need any matching share, including zero cents.
 * IN handles repeated shares without grouping their costs or multiplying rows. */
export const expenseDerivedMembershipSql = (
  expenseId: SQL,
  scope: ExpenseAllocationProjectScope,
  expenseIds?: ExpenseIdSelection,
): SQL =>
  sql`${expenseId} IN (${expenseDerivedReadSql("membership", { scope, expenseIds })})`;

type DerivedValues = Pick<typeof expense.$inferSelect, "cost"> & {
  projectNames: ExpenseJointAllocationRow["projectName"];
  spendingCategoryNames: ExpenseJointAllocationRow["spendingCategoryName"];
  missing: ExpenseJointAllocationRow["categoryIncomplete"] | null;
  evidence: Array<
    [
      ExpenseJointAllocationRow["spendingCategoryId"],
      ExpenseSpendingAllocationRow["amount"],
      ExpenseSpendingAllocationRow["incomplete"],
    ]
  > | null;
};

/** A plain-root sort/projection cannot join. PostgreSQL evaluates this grouped
 * dictionary as one InitPlan, then extracts values without allocating per row. */
export function expenseDerivedValueSql<K extends keyof DerivedValues>(
  field: K,
  expenseId: SQL,
  scope?: ExpenseAllocationProjectScope,
  expenseIds?: ExpenseIdSelection,
): SQL<DerivedValues[K]> {
  const read =
    field === "cost"
      ? "costs"
      : field === "missing" || field === "evidence"
        ? "categoryEvidence"
        : field === "spendingCategoryNames"
          ? "categoryNames"
          : "names";
  const values = sql`(SELECT jsonb_object_agg("expenseId", ${sql.identifier(field)})
    FROM (${expenseDerivedReadSql(read, { scope, expenseIds })}) derived_value)`;
  if (field === "evidence") return sql`${values} -> ${expenseId}::text`;
  const value = sql`${values} ->> ${expenseId}::text`;
  if (field === "cost") return sql`(${value})::float8`;
  if (field === "missing") return sql`(${value})::boolean`;
  return sql`${value}`;
}

/** One row per selected expense, suitable for joined grouped queries. */
export const expenseDerivedCostsSql = (
  scope?: ExpenseAllocationProjectScope,
  expenseIds?: ExpenseIdSelection,
): SQL => expenseDerivedReadSql("costs", { scope, expenseIds });

export function expenseDerivedCostRead(
  db: Database | DrizzleTransaction,
  scope?: ExpenseAllocationProjectScope,
  expenseIds?: ExpenseIdSelection,
  preparedCosts?: SQL,
) {
  const relation =
    preparedCosts ??
    sql`(${expenseDerivedCostsSql(scope, expenseIds)}) derived_cost`;
  const cost = scope
    ? sql<number | null>`derived_cost.cost`
    : sql<number | null>`${expense.cost}`;
  const select = <Fields extends SelectedFields>(fields: Fields) => {
    const query = unwrapDb(db).select(fields).from(expense);
    return scope
      ? query.innerJoin(relation, sql`derived_cost."expenseId" = ${expense.id}`)
      : query;
  };
  return { cost, select, aggregate: expenseAggregateFields(cost) };
}

/** Relational ledger population shared by analytical callers. */
export const expenseSelectionForWhere = (where?: SQL): ExpenseIdRelation => ({
  select: sql`SELECT ${expense.id} AS id FROM ${expense} WHERE ${where ?? sql`true`}`,
});

/** Request-local scope and set-based total relation shared by analytical callers. */
export async function prepareExpenseDerivedRead(
  db: Database,
  filters: ExpenseFilters,
  prepared?: { scope: ExpenseAllocationProjectScope | undefined },
) {
  const { buildExpenseWhereClause, resolveExpenseProjectAllocationScope } =
    await import("./lookup");
  const scope = prepared
    ? prepared.scope
    : await resolveExpenseProjectAllocationScope(db, filters);
  const where = await buildExpenseWhereClause(db, filters, {
    projectScope: undefined,
  });
  const selectedIds = expenseSelectionForWhere(where);
  return {
    scope,
    where,
    expenseIds: selectedIds,
    ...expenseDerivedCostRead(db, scope, selectedIds),
    allocations: sql`(${expenseDerivedReadSql("shares", { scope, expenseIds: selectedIds })}) allocation`,
  };
}

export type PreparedExpenseDerivedRead = Awaited<
  ReturnType<typeof prepareExpenseDerivedRead>
>;

export type DerivedProjectionQuery = SQLWrapper & {
  readonly _: { readonly result: object[] };
  as(alias: string): Subquery;
};
type DerivedProjectionResults<
  Queries extends Record<string, DerivedProjectionQuery>,
> = {
  [K in keyof Queries]: Queries[K]["_"]["result"];
};

export type ExpenseDerivedReadContext = Pick<
  PreparedExpenseDerivedRead,
  "scope" | "where"
> & { expenseIds: readonly ExpenseId[] | ExpenseIdRelation };

const derivedBatchRead = (
  db: Database,
  context: ExpenseDerivedReadContext,
  group = 0,
) => ({
  ...context,
  ...expenseDerivedCostRead(
    db,
    context.scope,
    context.expenseIds,
    sql`${sql.identifier(`expense_derived_cost_${group}`)} derived_cost`,
  ),
  allocations: sql`${sql.identifier(`expense_derived_share_${group}`)} allocation`,
});

export type ExpenseDerivedBatchRead = ReturnType<typeof derivedBatchRead>;

/** Compatible projections share selected purchases, scope membership, rounded
 * shares and grouped costs in one statement. Positional column aliases retain
 * the declaration's result keys when PostgreSQL words each JSON projection. */
export async function executeExpenseDerivedBatch<
  Queries extends Record<string, DerivedProjectionQuery>,
>(
  db: Database,
  context: ExpenseDerivedReadContext,
  projections: (read: ExpenseDerivedBatchRead) => Queries,
): Promise<DerivedProjectionResults<Queries>> {
  return executeExpenseDerivedBatches(db, { read: context }, (reads) =>
    projections(reads.read!),
  );
}

/** Different facet masks share the principal weighting. Equivalent share masks
 * also share their grouped relations, even when their stored row filters differ. */
export async function executeExpenseDerivedBatches<
  Queries extends Record<string, DerivedProjectionQuery>,
>(
  db: Database,
  contexts: Readonly<Record<string, ExpenseDerivedReadContext>>,
  projections: (
    reads: Readonly<Record<string, ExpenseDerivedBatchRead>>,
  ) => Queries,
): Promise<DerivedProjectionResults<Queries>> {
  const result = await unwrapDb(db).execute<DerivedProjectionResults<Queries>>(
    expenseDerivedBatchesSql(db, contexts, projections),
  );
  // SAFETY: the builder names each JSON array with its projection key and
  // positional aliases reproduce the Drizzle query's declared result fields.
  return result.rows[0] as DerivedProjectionResults<Queries>;
}

/** The executed statement is also available to EXPLAIN at the real batch boundary. */
export function expenseDerivedBatchesSql<
  Queries extends Record<string, DerivedProjectionQuery>,
>(
  db: Database,
  contexts: Readonly<Record<string, ExpenseDerivedReadContext>>,
  projections: (
    reads: Readonly<Record<string, ExpenseDerivedBatchRead>>,
  ) => Queries,
): SQL {
  const groups: Array<{ scope: ExpenseAllocationProjectScope | undefined }> =
    [];
  const groupByScope = new Map<string, number>();
  const reads = Object.fromEntries(
    Object.entries(contexts).map(([key, context]) => {
      const scope = context.scope;
      const mask = scope
        ? JSON.stringify({
            projectIds: scope.projectIds
              ? [...scope.projectIds].sort()
              : undefined,
            presence: scope.presence,
            membershipProjectIds: scope.membershipProjectIds
              ? [...scope.membershipProjectIds].sort()
              : undefined,
            spendingCategoryIds: scope.spendingCategoryIds
              ? [...scope.spendingCategoryIds].sort()
              : undefined,
            categoryPresence: scope.categoryPresence,
            trades: scope.trades ? [...scope.trades].sort() : undefined,
            costTypes: scope.costTypes
              ? [...scope.costTypes].sort()
              : undefined,
          })
        : "unscoped";
      let group = groupByScope.get(mask);
      if (group === undefined) {
        group = groups.length;
        groups.push({ scope });
        groupByScope.set(mask, group);
      }
      return [key, derivedBatchRead(db, context, group)];
    }),
  );
  const queries = projections(reads);
  const columns = Object.entries(queries).map(([key, query]) => {
    const rows = query.as("derived_rows");
    const names = Object.keys(rows._.selectedFields).map((name) =>
      sql.identifier(name),
    );
    return sql`(SELECT coalesce(jsonb_agg(to_jsonb(derived_rows)), '[]'::jsonb)
      FROM ${rows}(${sql.join(names, sql`, `)})) AS ${sql.identifier(key)}`;
  });
  const selected = Object.values(contexts).map((context) =>
    expenseSelectionIdsSql(context.expenseIds),
  );
  const expenseIds = {
    select: sql`SELECT DISTINCT id FROM (${sql.join(selected, sql` UNION ALL `)}) selected_ids`,
  };
  const relations = groups.flatMap(({ scope }, group) => {
    const shareName = sql.identifier(`expense_derived_share_${group}`);
    const costName = sql.identifier(`expense_derived_cost_${group}`);
    const shares = expenseDerivedReadSql("shares", {
      scope,
      source: sql`SELECT * FROM expense_derived_allocation`,
    });
    const costs = expenseDerivedReadSql("costs", {
      scope: scope ? { ...scope, membershipProjectIds: undefined } : undefined,
      source: sql`SELECT * FROM ${shareName}`,
    });
    return [
      sql`${shareName} AS MATERIALIZED (${shares})`,
      sql`${costName} AS MATERIALIZED (${costs})`,
    ];
  });
  return sql`
    WITH expense_derived_allocation AS MATERIALIZED (${expenseJointAllocationSql(expenseIds)}),
      ${sql.join(relations, sql`, `)}
    SELECT ${sql.join(columns, sql`, `)}
  `;
}
