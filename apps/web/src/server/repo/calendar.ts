import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarRangeInput,
  CalendarRangeOut,
} from "@cubby/schemas/calendar";
import { addDays } from "date-fns";
import { and, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { project, purchase, task } from "~/server/db/schema";
import { getDb, notDeleted, relations } from "./database-helpers";
import { getMealsByDateRange } from "./meal";
import { loadProjectSubtreeRollups } from "./project/subtree";
import { dbPurchaseToAPI } from "./purchase/helpers";
import { dbTaskToAPI } from "./task/helpers";

const emptyDaySummary = (): CalendarDaySummary => ({
  actualSpend: 0,
  plannedSpend: 0,
  calories: 0,
  nutritionPending: false,
  taskCount: 0,
  purchaseCount: 0,
  mealCount: 0,
  projectCount: 0,
});

const shiftPlainDate = (value: string, amount: number) =>
  formatPlainDate(addDays(parsePlainDate(value), amount));

const itemOrder: Record<CalendarItem["kind"], number> = {
  project: 0,
  task: 1,
  meal: 2,
  purchase: 3,
};

/**
 * One bounded read for the unified planning calendar. Date-only comparisons
 * stay as YYYY-MM-DD strings; ReUI Date conversion is a client boundary.
 */
export async function getCalendarRange(
  db: Database,
  input: CalendarRangeInput,
): Promise<CalendarRangeOut> {
  const endInclusive = shiftPlainDate(input.endDateExclusive, -1);
  const [meals, taskRows, purchaseRows, projectRows, projectRollups] =
    await Promise.all([
      getMealsByDateRange(db, input.startDate, endInclusive),
      getDb(db).query.task.findMany({
        where: and(
          notDeleted(task),
          or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
          lte(sql`coalesce(${task.dueDate}, ${task.dueEndDate})`, endInclusive),
          gte(
            sql`coalesce(${task.dueEndDate}, ${task.dueDate})`,
            input.startDate,
          ),
        ),
        orderBy: (row, { asc }) => [asc(row.dueDate), asc(row.name)],
        ...relations.task.withProject,
      }),
      getDb(db).query.purchase.findMany({
        where: and(
          notDeleted(purchase),
          isNotNull(purchase.date),
          gte(purchase.date, input.startDate),
          lte(purchase.date, endInclusive),
        ),
        orderBy: (row, { asc }) => [asc(row.date), asc(row.name)],
        ...relations.purchase.withProject,
      }),
      getDb(db)
        .select({
          id: project.id,
          name: project.name,
          status: project.status,
          kind: project.kind,
        })
        .from(project)
        .where(notDeleted(project)),
      loadProjectSubtreeRollups(db),
    ]);

  const items: CalendarItem[] = [];

  for (const meal of meals) {
    items.push({
      kind: "meal",
      id: meal.id,
      title: meal.name || "Meal",
      startDate: meal.date,
      endDateExclusive: shiftPlainDate(meal.date, 1),
      interaction: "move",
      sortOrder: meal.sortOrder,
      recipeNames: meal.recipes.map((recipe) => recipe.recipe.name),
      cost: meal.totals.costTotal,
      calories: meal.totals.caloriesTotal,
      nutritionPending: meal.totals.pending,
    });
  }

  for (const row of taskRows) {
    const value = dbTaskToAPI(row, [], []);
    const startDate = value.dueDate ?? value.dueEndDate;
    const endDate = value.dueEndDate ?? value.dueDate;
    if (!startDate || !endDate) continue;
    items.push({
      kind: "task",
      id: value.id,
      title: value.name,
      startDate,
      endDateExclusive: shiftPlainDate(endDate, 1),
      interaction: "move",
      status: value.status,
      trade: value.trade,
      projectName: value.projectName,
    });
  }

  for (const row of purchaseRows) {
    const value = dbPurchaseToAPI(row);
    if (!value.date) continue;
    items.push({
      kind: "purchase",
      id: value.id,
      title: value.name,
      startDate: value.date,
      endDateExclusive: shiftPlainDate(value.date, 1),
      interaction: value.future ? "move" : "read-only",
      future: value.future,
      cost: value.cost,
      vendor: value.vendor,
      trade: value.trade,
      projectName: value.projectName,
    });
  }

  for (const row of projectRows) {
    const window = projectRollups.dateWindows.get(row.id);
    const firstDate = window?.effectiveStart ?? window?.effectiveEnd;
    const lastDate = window?.effectiveEnd ?? window?.effectiveStart;
    const startDate =
      firstDate && lastDate && firstDate > lastDate ? lastDate : firstDate;
    const endDate =
      firstDate && lastDate && firstDate > lastDate ? firstDate : lastDate;
    if (
      !startDate ||
      !endDate ||
      startDate >= input.endDateExclusive ||
      endDate < input.startDate
    ) {
      continue;
    }
    items.push({
      kind: "project",
      id: row.id,
      title: row.name,
      startDate,
      endDateExclusive: shiftPlainDate(endDate, 1),
      interaction: "read-only",
      status: row.status,
      projectKind: row.kind,
    });
  }

  items.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      itemOrder[a.kind] - itemOrder[b.kind] ||
      a.title.localeCompare(b.title),
  );

  const days: Record<string, CalendarDaySummary> = {};
  for (
    let day = input.startDate;
    day < input.endDateExclusive;
    day = shiftPlainDate(day, 1)
  ) {
    days[day] = emptyDaySummary();
  }

  for (const item of items) {
    const firstDay =
      item.startDate < input.startDate ? input.startDate : item.startDate;
    const lastExclusive =
      item.endDateExclusive > input.endDateExclusive
        ? input.endDateExclusive
        : item.endDateExclusive;
    for (
      let day = firstDay;
      day < lastExclusive;
      day = shiftPlainDate(day, 1)
    ) {
      const summary = days[day];
      if (!summary) continue;
      if (item.kind === "meal") {
        summary.mealCount += 1;
        summary.calories += item.calories;
        summary.nutritionPending ||= item.nutritionPending;
      } else if (item.kind === "task") {
        summary.taskCount += 1;
      } else if (item.kind === "purchase") {
        summary.purchaseCount += 1;
        if (item.future) summary.plannedSpend += item.cost ?? 0;
        else summary.actualSpend += item.cost ?? 0;
      } else {
        summary.projectCount += 1;
      }
    }
  }

  return { items, days };
}
