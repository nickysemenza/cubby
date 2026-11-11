import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import type { ProjectOptionsOut } from "@cubby/schemas/project";
import type { Trade } from "@cubby/schemas/project";
import { and, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/db/helpers";
import { columnArrayParam } from "~/server/db/helpers/query";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { expense, project } from "~/server/db/schema";
import { projectNameOptionsExcluding } from "~/server/domains/project/repo/lookup";

import {
  expenseInheritanceReadExtras,
  principalExpenseInheritanceSql,
} from "./expense-inheritance";

/** Excluding the source before folding dates also removes its vote from ancestors. */
export async function expenseProjectRecommendationContext(
  db: Database,
  id: ExpenseShortcode,
) {
  return (await expenseProjectRecommendationContexts(db, [id])).get(id) ?? null;
}

/**
 * `expenseProjectRecommendationContext` for several Expenses. The project
 * roster, ledger allocation and current targets are read once for the set;
 * every source keeps its own history and derived-window exclusion.
 */
export async function expenseProjectRecommendationContexts(
  db: Database,
  ids: readonly ExpenseShortcode[],
) {
  return (await prepareExpenseProjectRecommendationContexts(db, ids))(ids);
}

/** Share input rows across bounded consumers without retaining every expanded context. */
export async function prepareExpenseProjectRecommendationContexts(
  db: Database,
  ids: readonly ExpenseShortcode[],
) {
  const read = await readSources(db, uniq(ids));
  const sources = uniq(ids).flatMap((id) => {
    const source = read.find((row) => row.shortcode === id);
    return source && isEligible(source) ? [{ id, source }] : [];
  });
  const rosters = await projectNameOptionsExcluding(
    db,
    sources.map(({ source }) => source.id),
  );
  const history = await readHistory(
    db,
    sources.map(({ source }) => source),
  );
  const normalizedHistory = new Map<
    (typeof history)[number],
    RecommendationHistoryRow
  >();
  const projectIds = uniq(
    sources.flatMap(({ source }) =>
      source.effectiveProjectId ? [source.effectiveProjectId] : [],
    ),
  );
  const currentProjects = projectIds.length
    ? await getDb(db)
        .select({
          id: project.id,
          shortcode: project.shortcode,
          name: project.name,
        })
        .from(project)
        .where(and(inArray(project.id, projectIds), notDeleted(project)))
    : [];
  const byProject = new Map(currentProjects.map((row) => [row.id, row]));
  /**
   * Each context owns independent row copies unless a view is given. A view sees
   * only rows this source includes, already normalized, as an object that stays
   * the same across expansions, so it can memoize per row. It must not mutate it.
   */
  function expand(
    requestedIds: readonly ExpenseShortcode[],
  ): RecommendationContexts<RecommendationHistoryRow>;
  function expand<Row>(
    requestedIds: readonly ExpenseShortcode[],
    historyView: (row: Readonly<RecommendationHistoryRow>) => Row,
  ): RecommendationContexts<Row>;
  function expand<Row>(
    requestedIds: readonly ExpenseShortcode[],
    historyView?: (row: Readonly<RecommendationHistoryRow>) => Row,
  ) {
    const requested = new Set(requestedIds);
    const contexts = new Map<
      ExpenseShortcode,
      RecommendationContext<Row | RecommendationHistoryRow> | null
    >(requestedIds.map((id) => [id, null]));
    for (const { id, source } of sources) {
      if (!requested.has(id)) continue;
      contexts.set(
        id,
        sourceContext(
          source,
          rosters.get(source.id) ?? [],
          history
            .filter(
              (row) =>
                row.expenseId !== source.id &&
                (row.trade === source.effectiveTrade ||
                  (source.productId !== null &&
                    row.productId === source.productId)),
            )
            .map((row) => {
              let normalized = normalizedHistory.get(row);
              if (!normalized) {
                normalized = historyRow(row);
                normalizedHistory.set(row, normalized);
              }
              return historyView
                ? historyView(normalized)
                : copyHistoryRow(normalized);
            }),
          source.effectiveProjectId
            ? byProject.get(source.effectiveProjectId)
            : undefined,
        ),
      );
    }
    return contexts;
  }
  return expand;
}

/**
 * Assigned principal lines sharing any source's trade or Product, in Expense
 * id order: the order is part of each fingerprinted basis, so it must not
 * follow physical tuple order. One read through the joined principal
 * inheritance serves every source, so its shortcodes are validated once here.
 */
const readHistory = async (
  db: Database,
  sources: readonly EligibleSource[],
) => {
  if (sources.length === 0) return [];
  const trades = uniq(sources.map((source) => source.effectiveTrade));
  const products = uniq(
    sources.flatMap((source) => (source.productId ? [source.productId] : [])),
  );
  const inherited = principalExpenseInheritanceSql("e", "live_purchase");
  const result = await unwrapDb(db).execute<{
    expenseId: string;
    id: string;
    name: string;
    projectId: string;
    trade: Trade | null;
    productId: string | null;
  }>(sql`SELECT * FROM (
      SELECT e.id AS "expenseId", e.shortcode AS id, e.name,
        assigned.shortcode AS "projectId", ${inherited.trade} AS trade,
        e."productId"
      FROM "Expense" e
      LEFT JOIN "Purchase" live_purchase
        ON live_purchase.id = e."purchaseId" AND ${notDeleted("live_purchase")}
      ${inherited.joins}
      JOIN "Project" assigned
        ON assigned.id = ${inherited.projectId} AND ${notDeleted("assigned")}
      WHERE ${notDeleted("e")} AND e."lineKind" = ${expenseLineKindSchema.enum.principal}
    ) history
    WHERE history.trade = ANY(${columnArrayParam(trades)})${
      products.length
        ? sql` OR history."productId" = ANY(${uuidArrayParam(products)})`
        : sql``
    }
    ORDER BY history."expenseId"`);
  return result.rows;
};

/** Normalize only included rows; an excluded malformed row must not fail another source. */
function historyRow({
  expenseId: _expenseId,
  ...row
}: Awaited<ReturnType<typeof readHistory>>[number]) {
  return {
    ...row,
    id: parseShortcodeFor("expense", row.id),
    projectId: parseShortcodeFor("project", row.projectId),
  };
}

/** Each default context owns its row objects; only their immutable primitives are shared. */
const copyHistoryRow = (row: Readonly<RecommendationHistoryRow>) => ({
  ...row,
});

export type RecommendationHistoryRow = ReturnType<typeof historyRow>;
type RecommendationContext<Row> = ReturnType<typeof sourceContext<Row>>;
type RecommendationContexts<Row> = Map<
  ExpenseShortcode,
  RecommendationContext<Row> | null
>;
type RecommendationSource = Awaited<ReturnType<typeof readSources>>[number];
type EligibleSource = RecommendationSource & {
  effectiveTrade: NonNullable<RecommendationSource["effectiveTrade"]>;
};

const isEligible = (source: RecommendationSource): source is EligibleSource =>
  source.lineKind === "principal" && source.effectiveTrade !== null;

const readSources = async (db: Database, ids: readonly ExpenseShortcode[]) =>
  ids.length === 0
    ? []
    : getDb(db).query.expense.findMany({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(inArray(expense.shortcode, [...ids]), notDeleted(expense)),
            ),
        },
        extras: expenseInheritanceReadExtras(),
        with: { product: { columns: { kind: true } } },
      });

function sourceContext<Row>(
  source: EligibleSource,
  projects: ProjectOptionsOut[],
  history: Row[],
  currentProject: { shortcode: string; name: string } | undefined,
) {
  return {
    source: {
      ...source,
      projectId: source.effectiveProjectId,
      trade: source.effectiveTrade,
      productKind: source.product?.kind ?? null,
    },
    projects,
    history,
    currentTarget: currentProject
      ? {
          id: parseShortcodeFor("project", currentProject.shortcode),
          name: currentProject.name,
        }
      : null,
  };
}
