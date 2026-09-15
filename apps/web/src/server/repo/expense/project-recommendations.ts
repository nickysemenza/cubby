import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import { and, eq, isNotNull, ne, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import { expense, project } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { projectNameOptions } from "~/server/repo/project/lookup";

/** Excluding the source before folding dates also removes its vote from ancestors. */
export async function expenseProjectRecommendationContext(
  db: Database,
  id: ExpenseShortcode,
) {
  const source = await getDb(db).query.expense.findFirst({
    where: and(eq(expense.shortcode, id), notDeleted(expense)),
  });
  if (!source) return null;
  const [projects, history, currentProject] = await Promise.all([
    projectNameOptions(db, source.id),
    getDb(db)
      .select({
        id: expense.shortcode,
        name: expense.name,
        projectId: project.shortcode,
        trade: expense.trade,
        productId: expense.productId,
      })
      .from(expense)
      .innerJoin(
        project,
        and(eq(expense.projectId, project.id), notDeleted(project)),
      )
      .where(
        and(
          notDeleted(expense),
          ne(expense.id, source.id),
          eq(expense.lineKind, "principal"),
          isNotNull(expense.projectId),
          or(
            eq(expense.trade, source.trade),
            source.productId
              ? eq(expense.productId, source.productId)
              : undefined,
          ),
        ),
      ),
    source.projectId
      ? getDb(db).query.project.findFirst({
          where: and(eq(project.id, source.projectId), notDeleted(project)),
          columns: { shortcode: true, name: true },
        })
      : undefined,
  ]);
  return {
    source,
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
