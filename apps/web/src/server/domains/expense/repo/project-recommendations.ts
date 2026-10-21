import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import type { ProjectOptionsOut } from "@cubby/schemas/project";
import type { Trade } from "@cubby/schemas/project";
import { and, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/db/helpers";
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
  return (requestedIds: readonly ExpenseShortcode[]) => {
    const requested = new Set(requestedIds);
    const contexts = new Map<ExpenseShortcode, RecommendationContext | null>(
      requestedIds.map((id) => [id, null]),
    );
    for (const { id, source } of sources) {
      if (!requested.has(id)) continue;
      contexts.set(
        id,
        sourceContext(
          source,
          rosters.get(source.id) ?? [],
          history.filter(
            (row) =>
              row.expenseId !== source.id &&
              (row.trade === source.effectiveTrade ||
                (source.productId !== null &&
                  row.productId === source.productId)),
          ),
          source.effectiveProjectId
            ? byProject.get(source.effectiveProjectId)
            : undefined,
        ),
      );
    }
    return contexts;
  };
}

/**
 * Assigned principal lines sharing any source's trade or Product, in Expense
 * id order: the order is part of each fingerprinted basis, so it must not
 * follow physical tuple order. One read through the joined principal
 * inheritance serves every source.
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
        ON live_purchase.id = e."purchaseId" AND live_purchase."deletedAt" IS NULL
      ${inherited.joins}
      JOIN "Project" assigned
        ON assigned.id = ${inherited.projectId} AND assigned."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL AND e."lineKind" = ${expenseLineKindSchema.enum.principal}
    ) history
    WHERE history.trade IN (${sql.join(
      trades.map((trade) => sql`${trade}`),
      sql`, `,
    )})${
      products.length
        ? sql` OR history."productId" = ANY(${uuidArrayParam(products)})`
        : sql``
    }
    ORDER BY history."expenseId"`);
  return result.rows;
};

type RecommendationContext = Awaited<ReturnType<typeof sourceContext>>;
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
        where: and(inArray(expense.shortcode, [...ids]), notDeleted(expense)),
        extras: expenseInheritanceReadExtras(),
        with: { product: { columns: { kind: true } } },
      });

function sourceContext(
  source: EligibleSource,
  projects: ProjectOptionsOut[],
  history: Awaited<ReturnType<typeof readHistory>>,
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
    history: history.map(({ expenseId: _expenseId, ...row }) => ({
      ...row,
      id: parseShortcodeFor("expense", row.id),
      projectId: parseShortcodeFor("project", row.projectId),
    })),
    currentTarget: currentProject
      ? {
          id: parseShortcodeFor("project", currentProject.shortcode),
          name: currentProject.name,
        }
      : null,
  };
}
