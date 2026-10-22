import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
  CalendarRangeInput,
  CalendarRangeOut,
  CalendarScheduleOut,
} from "@cubby/schemas/calendar";
import {
  calendarSources,
  calendarSourceMatches,
} from "@cubby/schemas/calendar";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  MEAL_TYPE_LABELS,
  type MealType,
  mealTypeRank,
} from "@cubby/schemas/meal-classification";
import type { NutritionTotals } from "@cubby/schemas/nutrition";
import type { SQL } from "drizzle-orm";
import {
  and,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { shiftPlainDate } from "~/lib/household-date";
import { aggregateTotals } from "~/lib/nutrition-estimates";
import type { Database } from "~/server/db";
import { getDb, notDeleted, relations } from "~/server/db/helpers";
import { expense, project, task, meal, planting } from "~/server/db/schema";
import { expenseInheritanceReadExtras } from "~/server/domains/expense/repo/expense-inheritance";
import { dbExpenseToAPI } from "~/server/domains/expense/repo/helpers";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import {
  plantingScaffold,
  getPlanting,
} from "~/server/domains/garden/repo/garden";
import {
  mealScaffold,
  getMealsByDateRange,
} from "~/server/domains/meal/repo/crud";
import { getProductCoverImageUrlsByProductIds } from "~/server/domains/product/repo/crud";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { loadProjectDateWindows } from "~/server/domains/project/repo/subtree";
import { getRecipeCoverImageUrlsByShortcodes } from "~/server/domains/recipe/repo/crud";
import { getTasksByIDs } from "~/server/domains/task/repo/crud";
import { dbTaskToAPI } from "~/server/domains/task/repo/helpers";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { hydrateTaskInheritanceRows } from "~/server/domains/task/repo/task-project-inheritance";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import type { NestedListScaffold } from "~/server/generic/list/repo/list";

import {
  loadCalendarPlantings,
  loadSchedulePlantingIds,
  mapPlantingItems,
} from "./calendar-plantings";

const emptyDaySummary = (): CalendarDaySummary => ({
  actualSpend: 0,
  plannedSpend: 0,
  mealTotals: aggregateTotals([]),
  taskCount: 0,
  expenseCount: 0,
  mealCount: 0,
  projectCount: 0,
  itemIds: [],
});

const itemOrder = {
  project: 0,
  task: 1,
  planting: 2,
  meal: 3,
  expense: 4,
} as const satisfies Record<CalendarItem["kind"], number>;

/** How an unnamed meal names itself: its slot, or the generic fallback. */
const mealTypeTitle = (mealType: MealType | null): string =>
  mealType ? MEAL_TYPE_LABELS[mealType] : "Meal";

/** Slot ordering — `mealTypeValues` is clock order — applied only when both
 *  items are meals. */
const mealSlotDelta = (a: CalendarItem, b: CalendarItem): number =>
  a.kind === "meal" && b.kind === "meal"
    ? mealTypeRank(a.mealType) - mealTypeRank(b.mealType)
    : 0;

const sourceTables = { meal, task, expense, project, planting };
const sourceScaffolds = {
  meal: mealScaffold,
  task: taskScaffold,
  expense: expenseScaffold,
  project: projectScaffold,
  planting: plantingScaffold,
} satisfies Record<CalendarItemKind, NestedListScaffold<CalendarItemKind>>;

/** Use the source's prepared list population, including derived fields and
 * related scopes, before calendar hydration and date layout. Keep this predicate
 * in plain table queries: Drizzle relational hydration rewrites nested columns
 * to its outer alias, corrupting the matchingIds subquery. Hydrate by IDs. */
const calendarSourceWhere = async (
  db: Database,
  input: CalendarRangeInput,
  kind: CalendarItemKind,
): Promise<SQL> => {
  if (!calendarSourceMatches(kind, input)) return sql`false`;
  const scaffold = sourceScaffolds[kind];
  const filters = input.filters?.[kind] ?? {};
  const context = await scaffold.context(db, { filters, readIntent: "count" });
  const ids = scaffold.matchingIds(filters, { context });
  return sql`${sourceTables[kind].id} IN ${ids}`;
};

const loadCalendarMeals = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  if (!calendarSourceMatches("meal", input)) return [];
  const condition = await calendarSourceWhere(db, input, "meal");
  const ids = await getDb(db)
    .select({ id: meal.id })
    .from(meal)
    .where(
      and(
        condition,
        gte(meal[calendarSources.meal.dates[0]], input.startDate),
        lte(meal[calendarSources.meal.dates[0]], endInclusive),
      ),
    );
  return ids.length
    ? getMealsByDateRange(
        db,
        input.startDate,
        endInclusive,
        inArray(
          meal.id,
          ids.map((row) => row.id),
        ),
      )
    : [];
};

const loadCalendarTasks = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  if (!calendarSourceMatches("task", input)) return [];
  const condition = await calendarSourceWhere(db, input, "task");
  const ids = await getDb(db)
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        condition,
        or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
        lte(sql`coalesce(${task.dueDate}, ${task.dueEndDate})`, endInclusive),
        gte(
          sql`coalesce(${task.dueEndDate}, ${task.dueDate})`,
          input.startDate,
        ),
      ),
    );
  if (!ids.length) return [];
  const rows = await getDb(db).query.task.findMany({
    where: inArray(
      task.id,
      ids.map((row) => row.id),
    ),
    orderBy: (row, { asc }) => [asc(row.dueDate), asc(row.name)],
    ...relations.task.withProject,
  });
  return hydrateTaskInheritanceRows(db, rows);
};

const loadCalendarExpenses = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  if (!calendarSourceMatches("expense", input)) return [];
  const condition = await calendarSourceWhere(db, input, "expense");
  const ids = await getDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        condition,
        isNotNull(expense[calendarSources.expense.dates[0]]),
        gte(expense[calendarSources.expense.dates[0]], input.startDate),
        lte(expense[calendarSources.expense.dates[0]], endInclusive),
      ),
    );
  if (!ids.length) return [];
  return getDb(db).query.expense.findMany({
    where: inArray(
      expense.id,
      ids.map((row) => row.id),
    ),
    orderBy: (row, { asc }) => [asc(row.date), asc(row.name)],
    ...relations.expense.withProject,
    extras: {
      ...expenseInheritanceReadExtras(),
    },
  });
};

const loadCalendarProjects = async (
  db: Database,
  input: CalendarRangeInput,
) => {
  if (!calendarSourceMatches("project", input)) return [];
  const condition = await calendarSourceWhere(db, input, "project");
  return getDb(db)
    .select({
      id: project.id,
      shortcode: project.shortcode,
      name: project.name,
      status: project.status,
      kind: project.kind,
    })
    .from(project)
    .where(condition);
};

const mapMealItems = (
  meals: Awaited<ReturnType<typeof loadCalendarMeals>>,
  recipeCoverImageUrls: Map<string, string>,
): CalendarItem[] =>
  meals.map((meal) => ({
    kind: "meal",
    id: meal.id,
    title: meal.name || mealTypeTitle(meal.mealType),
    name: meal.name,
    startDate: meal[calendarSources.meal.dates[0]],
    endDateExclusive: shiftPlainDate(meal[calendarSources.meal.dates[0]], 1),
    interaction: "move" as const,
    sortOrder: meal.sortOrder,
    mealType: meal.mealType,
    mealKind: meal.mealKind,
    recipeNames: meal.recipes.map((recipe) => recipe.recipe.name),
    coverImageUrl:
      meal.recipes
        .map((recipe) => recipeCoverImageUrls.get(recipe.recipeId))
        .find((url) => url !== undefined) ?? null,
    mealTotals: meal.totals,
    dataQuality: meal.dataQuality,
  }));

const mapTaskItems = async (
  db: Database,
  rows: Awaited<ReturnType<typeof loadCalendarTasks>>,
  productCoverImageUrls: Map<string, string>,
): Promise<CalendarItem[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "task",
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) => {
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    const value = dbTaskToAPI(row, [], [], 0, 0, dataQualities.get(row.id)!);
    const startDate = value.due?.start ?? value.due?.end;
    const endDate = value.due?.end ?? value.due?.start;
    return startDate && endDate
      ? [
          {
            kind: "task" as const,
            id: parseShortcodeFor("task", row.shortcode),
            title: value.name,
            startDate,
            endDateExclusive: shiftPlainDate(endDate, 1),
            interaction: "move" as const,
            due: value.due,
            status: value.status,
            trade: value.trade,
            projectName: value.projectName,
            subjectProductName: value.subjectProductName,
            coverImageUrl: row.subjectProductId
              ? (productCoverImageUrls.get(row.subjectProductId) ?? null)
              : null,
          },
        ]
      : [];
  });
};

const mapExpenseItems = async (
  db: Database,
  rows: Awaited<ReturnType<typeof loadCalendarExpenses>>,
  productCoverImageUrls: Map<string, string>,
): Promise<CalendarItem[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "expense",
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) => {
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    const value = dbExpenseToAPI(row, dataQualities.get(row.id)!);
    return value.date
      ? [
          {
            kind: "expense" as const,
            id: parseShortcodeFor("expense", row.shortcode),
            title: value.name,
            startDate: value.date,
            endDateExclusive: shiftPlainDate(value.date, 1),
            interaction: value.future
              ? ("move" as const)
              : ("read-only" as const),
            future: value.future,
            cost: value.cost,
            vendor: value.vendor,
            trade: value.trade,
            projectName: value.projectName,
            productName: value.productName,
            coverImageUrl: row.productId
              ? (productCoverImageUrls.get(row.productId) ?? null)
              : null,
          },
        ]
      : [];
  });
};

const mapProjectItems = (
  rows: Awaited<ReturnType<typeof loadCalendarProjects>>,
  projectDates: Awaited<ReturnType<typeof loadProjectDateWindows>> | null,
  input: CalendarRangeInput,
): CalendarItem[] =>
  rows.flatMap((row) => {
    const window = projectDates?.dateWindows.get(row.id);
    const firstDate = window?.effectiveStart ?? window?.effectiveEnd;
    const lastDate = window?.effectiveEnd ?? window?.effectiveStart;
    const inverted = firstDate && lastDate && firstDate > lastDate;
    const startDate = inverted ? lastDate : firstDate;
    const endDate = inverted ? firstDate : lastDate;
    const outsideRange =
      !startDate ||
      !endDate ||
      startDate >= input.endDateExclusive ||
      endDate < input.startDate;
    return outsideRange
      ? []
      : [
          {
            kind: "project" as const,
            id: parseShortcodeFor("project", row.shortcode),
            title: row.name,
            startDate,
            endDateExclusive: shiftPlainDate(endDate, 1),
            interaction: "read-only" as const,
            status: row.status,
            projectKind: row.kind,
          },
        ];
  });

const sortCalendarItems = (items: CalendarItem[]) =>
  items.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      itemOrder[a.kind] - itemOrder[b.kind] ||
      mealSlotDelta(a, b) ||
      a.title.localeCompare(b.title),
  );

const summarizeCalendarDays = (
  input: CalendarRangeInput,
  items: CalendarItem[],
) => {
  const days: Record<string, CalendarDaySummary> = {};
  const mealTotalsByDay: Record<string, NutritionTotals[]> = {};
  for (
    let day = input.startDate;
    day < input.endDateExclusive;
    day = shiftPlainDate(day, 1)
  ) {
    days[day] = emptyDaySummary();
    mealTotalsByDay[day] = [];
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
      summary.itemIds.push(item.id);
      if (item.kind === "meal") {
        summary.mealCount += 1;
        mealTotalsByDay[day]?.push(item.mealTotals);
      } else if (item.kind === "task") summary.taskCount += 1;
      else if (item.kind === "expense") {
        summary.expenseCount += 1;
        if (item.future) summary.plannedSpend += item.cost ?? 0;
        else summary.actualSpend += item.cost ?? 0;
      } else if (item.kind === "project") summary.projectCount += 1;
      // Plantings are a read-only calendar decoration, not a planning-load
      // signal — the day summary intentionally has no plantingCount.
    }
  }
  for (const [day, totals] of Object.entries(mealTotalsByDay)) {
    const summary = days[day];
    if (summary) summary.mealTotals = aggregateTotals(totals);
  }
  return days;
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
  // Omitted `kinds` means all five, so the in-app calendar is unchanged. A
  // narrowed request skips whole reads rather than filtering after the fact —
  // the ICS feed asks for meals + tasks (or, for the garden feed, plantings),
  // and the project branch it drops is a whole-tree date fold it would
  // otherwise pay for on every poll.
  const wants = (kind: CalendarItemKind) => calendarSourceMatches(kind, input);

  const [
    meals,
    taskRows,
    expenseRows,
    projectRows,
    plantingRows,
    projectDates,
  ] = await Promise.all([
    loadCalendarMeals(db, input, endInclusive),
    loadCalendarTasks(db, input, endInclusive),
    loadCalendarExpenses(db, input, endInclusive),
    loadCalendarProjects(db, input),
    calendarSourceWhere(db, input, "planting").then((condition) =>
      loadCalendarPlantings(db, input, endInclusive, condition),
    ),
    // The date fold stays WHOLE-TREE on purpose. `aggregateSubtreeDates`
    // folds a parent's window up from its descendants, so scoping the fold to
    // the filtered set would make a filtered-in parent lose the window its
    // filtered-out children contribute. Only the emitted rows narrow.
    //
    // `loadProjectDateWindows`, not `loadProjectSubtreeRollups`: the calendar
    // reads `.dateWindows` and nothing else, and the rollup variant
    // additionally runs two spend/task aggregates whose results are discarded.
    wants("project") ? loadProjectDateWindows(db) : null,
  ]);

  const recipeIds = uniq(
    meals.flatMap((meal) => meal.recipes.map((value) => value.recipeId)),
  );
  const productIds = uniq([
    ...taskRows.flatMap((row) =>
      row.subjectProductId ? [row.subjectProductId] : [],
    ),
    ...expenseRows.flatMap((row) => (row.productId ? [row.productId] : [])),
  ]);
  const [recipeCoverImageUrls, productCoverImageUrls] = await Promise.all([
    getRecipeCoverImageUrlsByShortcodes(db, recipeIds),
    getProductCoverImageUrlsByProductIds(db, productIds),
  ]);

  const items = sortCalendarItems([
    ...mapMealItems(meals, recipeCoverImageUrls),
    ...(await mapTaskItems(db, taskRows, productCoverImageUrls)),
    ...(await mapExpenseItems(db, expenseRows, productCoverImageUrls)),
    ...mapProjectItems(projectRows, projectDates, input),
    ...mapPlantingItems(plantingRows, input),
  ]);
  return { items, days: summarizeCalendarDays(input, items) };
}

/** One read for the two-kind Schedule workbench. The window selects dated
 * records by overlap, while records with no date remain available in its
 * undated lanes. Filters use the same source membership as the date grid. */
export async function getCalendarSchedule(
  db: Database,
  input: CalendarRangeInput,
): Promise<CalendarScheduleOut> {
  const endInclusive = shiftPlainDate(input.endDateExclusive, -1);
  const [taskCondition, plantingCondition] = await Promise.all([
    calendarSourceWhere(db, input, "task"),
    calendarSourceWhere(db, input, "planting"),
  ]);
  const wantsTask = calendarSourceMatches("task", input);
  const wantsPlanting = calendarSourceMatches("planting", input);
  const [taskIds, plantingIds] = await Promise.all([
    wantsTask
      ? getDb(db)
          .select({ id: task.id })
          .from(task)
          .where(
            and(
              notDeleted(task),
              or(
                and(isNull(task.dueDate), isNull(task.dueEndDate)),
                and(
                  lte(
                    sql`coalesce(${task.dueDate}, ${task.dueEndDate})`,
                    endInclusive,
                  ),
                  gte(
                    sql`coalesce(${task.dueEndDate}, ${task.dueDate})`,
                    input.startDate,
                  ),
                ),
              ),
              taskCondition,
            ),
          )
      : [],
    wantsPlanting
      ? loadSchedulePlantingIds(db, input, endInclusive, plantingCondition)
      : [],
  ]);
  const [tasks, plantings] = await Promise.all([
    getTasksByIDs(
      db,
      taskIds.map((row) => row.id),
    ),
    Promise.all(
      plantingIds.map((row) =>
        getPlanting(db, parseEntityId("planting", row.id)),
      ),
    ),
  ]);
  tasks.sort(
    (a, b) =>
      (a.due?.start ?? a.due?.end ?? "9999-12-31").localeCompare(
        b.due?.start ?? b.due?.end ?? "9999-12-31",
      ) || a.name.localeCompare(b.name),
  );
  plantings.sort(
    (a, b) =>
      (
        a.season?.start ??
        a.transplantedOn ??
        a.season?.end ??
        "9999-12-31"
      ).localeCompare(
        b.season?.start ?? b.transplantedOn ?? b.season?.end ?? "9999-12-31",
      ) || a.displayName.localeCompare(b.displayName),
  );
  return { tasks, plantings };
}
