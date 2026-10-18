import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import type { ProjectOptionsOut } from "@cubby/schemas/project";
import type { Trade } from "@cubby/schemas/project";
import { and, eq, sql } from "drizzle-orm";
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
 * roster and its ledger allocation are read once for the set; each source
 * keeps its own record, history and current-project reads.
 */
export async function expenseProjectRecommendationContexts(
  db: Database,
  ids: readonly ExpenseShortcode[],
) {
  const sources: Array<{ id: ExpenseShortcode; source: EligibleSource }> = [];
  for (const id of uniq(ids)) {
    const source = await readSource(db, id);
    if (source && isEligible(source)) sources.push({ id, source });
  }
  const rosters = await projectNameOptionsExcluding(
    db,
    sources.map(({ source }) => source.id),
  );
  const history = await readHistory(
    db,
    sources.map(({ source }) => source),
  );
  const contexts = new Map<ExpenseShortcode, RecommendationContext | null>(
    ids.map((id) => [id, null]),
  );
  for (const { id, source } of sources)
    contexts.set(
      id,
      await sourceContext(
        db,
        source,
        rosters.get(source.id) ?? [],
        history.filter(
          (row) =>
            row.expenseId !== source.id &&
            (row.trade === source.effectiveTrade ||
              (source.productId !== null &&
                row.productId === source.productId)),
        ),
      ),
    );
  return contexts;
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
type RecommendationSource = NonNullable<Awaited<ReturnType<typeof readSource>>>;
type EligibleSource = RecommendationSource & {
  effectiveTrade: NonNullable<RecommendationSource["effectiveTrade"]>;
};

const isEligible = (source: RecommendationSource): source is EligibleSource =>
  source.lineKind === "principal" && source.effectiveTrade !== null;

const readSource = (db: Database, id: ExpenseShortcode) =>
  getDb(db).query.expense.findFirst({
    where: and(eq(expense.shortcode, id), notDeleted(expense)),
    extras: expenseInheritanceReadExtras(),
    with: { product: { columns: { kind: true } } },
  });

async function sourceContext(
  db: Database,
  source: EligibleSource,
  projects: ProjectOptionsOut[],
  history: Awaited<ReturnType<typeof readHistory>>,
) {
  const currentProject = source.effectiveProjectId
    ? await getDb(db).query.project.findFirst({
        where: and(
          eq(project.id, source.effectiveProjectId),
          notDeleted(project),
        ),
        columns: { shortcode: true, name: true },
      })
    : undefined;
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
