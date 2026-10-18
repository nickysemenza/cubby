import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import type { ProjectOptionsOut } from "@cubby/schemas/project";
import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { expense, project } from "~/server/db/schema";
import { projectNameOptionsExcluding } from "~/server/domains/project/repo/lookup";

import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
  expenseInheritanceReadExtras,
} from "./expense-inheritance";

const effectiveProjectId = effectiveExpenseProjectSql('"Expense"');
const effectiveTrade = effectiveExpenseTradeSql('"Expense"');

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
  const contexts = new Map<ExpenseShortcode, RecommendationContext | null>(
    ids.map((id) => [id, null]),
  );
  for (const { id, source } of sources)
    contexts.set(
      id,
      await sourceContext(db, source, rosters.get(source.id) ?? []),
    );
  return contexts;
}

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
) {
  const [history, currentProject] = await Promise.all([
    getDb(db)
      .select({
        id: expense.shortcode,
        name: expense.name,
        projectId: project.shortcode,
        trade: effectiveTrade,
        productId: expense.productId,
      })
      .from(expense)
      .innerJoin(
        project,
        and(eq(effectiveProjectId, project.id), notDeleted(project)),
      )
      .where(
        and(
          notDeleted(expense),
          ne(expense.id, source.id),
          eq(expense.lineKind, "principal"),
          isNotNull(effectiveProjectId),
          or(
            source.effectiveTrade
              ? eq(effectiveTrade, source.effectiveTrade)
              : undefined,
            source.productId
              ? eq(expense.productId, source.productId)
              : undefined,
          ),
        ),
      ),
    source.effectiveProjectId
      ? getDb(db).query.project.findFirst({
          where: and(
            eq(project.id, source.effectiveProjectId),
            notDeleted(project),
          ),
          columns: { shortcode: true, name: true },
        })
      : undefined,
  ]);
  return {
    source: {
      ...source,
      projectId: source.effectiveProjectId,
      trade: source.effectiveTrade,
      productKind: source.product?.kind ?? null,
    },
    projects,
    history: history.map((row) => ({
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
