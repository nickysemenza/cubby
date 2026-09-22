import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
  CalendarRangeInput,
  CalendarRangeOut,
} from "@cubby/schemas/calendar";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  MEAL_TYPE_LABELS,
  type MealType,
  mealTypeRank,
} from "@cubby/schemas/meal-classification";
import type { NutritionTotals } from "@cubby/schemas/nutrition";
import { addDays } from "date-fns";
import type { AnyColumn, SQL } from "drizzle-orm";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { aggregateTotals } from "~/lib/nutrition-estimates";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { expense, project, purchase, task } from "~/server/db/schema";

import { loadCalendarPlantings, mapPlantingItems } from "./calendar-plantings";
import { loadDataQualities } from "./data-quality";
import { getDb, notDeleted, relations } from "./database-helpers";
import { eqAny, presenceCondition } from "./database-helpers/query";
import { expenseInheritanceReadExtras } from "./expense-inheritance";
import {
  expenseAllocationExistsSql,
  expenseAllocatedCostSql,
} from "./expense-project-allocation";
import { dbExpenseToAPI } from "./expense/helpers";
import { chargeCondition } from "./expense/lookup";
import { getMealsByDateRange } from "./meal";
import { getProductCoverImageUrlsByProductIds } from "./product";
import {
  collectDescendantIds,
  loadProjectDateWindows,
  loadProjectTree,
} from "./project/subtree";
import { getRecipeCoverImageUrlsByShortcodes } from "./recipe";
import { resolveAllPresent } from "./shortcode-resolver";
import {
  effectiveTaskProjectSql,
  effectiveTaskTradeSql,
  hydrateTaskInheritanceRows,
} from "./task-project-inheritance";
import { dbTaskToAPI } from "./task/helpers";

const emptyDaySummary = (): CalendarDaySummary => ({
  actualSpend: 0,
  plannedSpend: 0,
  mealTotals: aggregateTotals([]),
  taskCount: 0,
  expenseCount: 0,
  mealCount: 0,
  projectCount: 0,
});

const shiftPlainDate = (value: string, amount: number) =>
  formatPlainDate(addDays(parsePlainDate(value), amount));

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

const loadCalendarProjectScope = async (
  db: Database,
  input: CalendarRangeInput,
  wantsProjects: boolean,
) => {
  const projectCodes = input.projectId ? [input.projectId].flat() : [];
  const projectRequested = projectCodes.length > 0;
  const selectedProjectIds = projectRequested
    ? await resolveAllPresent(db, "project", projectCodes)
    : [];
  const tree =
    projectRequested || wantsProjects ? await loadProjectTree(db) : undefined;
  const scopeIds =
    tree && selectedProjectIds.length
      ? uniq(
          selectedProjectIds.flatMap((id) => [
            id,
            ...(input.includeSubProjects
              ? collectDescendantIds(tree.childrenByParent, id)
              : []),
          ]),
        )
      : selectedProjectIds;
  return { projectRequested, scopeIds, tree };
};

type CalendarProjectScope = Awaited<
  ReturnType<typeof loadCalendarProjectScope>
>;

const projectScopeOn = (
  column: AnyColumn | SQL,
  input: CalendarRangeInput,
  scope: CalendarProjectScope,
): SQL | undefined =>
  or(
    scope.scopeIds.length
      ? sql`${column} IN (${sql.join(
          scope.scopeIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : scope.projectRequested
        ? sql`false`
        : undefined,
    input.projectPresenceFilter === "none"
      ? isNull(column)
      : input.projectPresenceFilter === "has"
        ? isNotNull(column)
        : undefined,
  );

const loadCalendarMeals = (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  const mealsInProjectScope =
    input.projectPresenceFilter === "none" ||
    (!input.projectId && input.projectPresenceFilter === undefined);
  return !input.kinds?.includes("meal") && input.kinds
    ? Promise.resolve([])
    : mealsInProjectScope
      ? getMealsByDateRange(db, input.startDate, endInclusive)
      : Promise.resolve([]);
};

const loadCalendarTasks = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
  scope: CalendarProjectScope,
) => {
  if (input.kinds && !input.kinds.includes("task")) return Promise.resolve([]);
  const rows = await getDb(db).query.task.findMany({
    where: and(
      notDeleted(task),
      or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
      lte(sql`coalesce(${task.dueDate}, ${task.dueEndDate})`, endInclusive),
      gte(sql`coalesce(${task.dueEndDate}, ${task.dueDate})`, input.startDate),
      eqAny(task.status, input.taskStatus),
      input.taskTrade
        ? inArray(effectiveTaskTradeSql("task"), [input.taskTrade].flat())
        : undefined,
      projectScopeOn(effectiveTaskProjectSql("task"), input, scope),
    ),
    orderBy: (row, { asc }) => [asc(row.dueDate), asc(row.name)],
    ...relations.task.withProject,
  });
  return hydrateTaskInheritanceRows(db, rows);
};

const loadCalendarExpenses = (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
  scope: CalendarProjectScope,
  vendorIds: Awaited<ReturnType<typeof resolveAllPresent>>,
) => {
  if (input.kinds && !input.kinds.includes("expense")) {
    return Promise.resolve([]);
  }
  const vendorCondition = input.expenseVendorId
    ? vendorIds.length
      ? chargeCondition(db, eqAny(purchase.vendorId, vendorIds))
      : sql`false`
    : undefined;
  return getDb(db).query.expense.findMany({
    where: and(
      notDeleted(expense),
      isNotNull(expense.date),
      gte(expense.date, input.startDate),
      lte(expense.date, endInclusive),
      input.expenseFuture !== undefined
        ? eq(expense.future, input.expenseFuture)
        : undefined,
      scope.projectRequested || input.projectPresenceFilter
        ? expenseAllocationExistsSql(sql`"expense"."id"`, {
            projectIds: scope.projectRequested ? scope.scopeIds : undefined,
            presence: input.projectPresenceFilter,
          })
        : undefined,
      or(
        vendorCondition,
        presenceCondition(
          expense.purchaseId,
          input.expenseVendorPresenceFilter,
        ),
      ),
    ),
    orderBy: (row, { asc }) => [asc(row.date), asc(row.name)],
    ...relations.expense.withProject,
    extras: {
      ...expenseInheritanceReadExtras(),
      scopedCost: (scope.projectRequested || input.projectPresenceFilter
        ? expenseAllocatedCostSql(sql`"expense"."id"`, {
            projectIds: scope.projectRequested ? scope.scopeIds : undefined,
            presence: input.projectPresenceFilter,
          })
        : sql<number | null>`"expense"."cost"`
      ).as("scopedCost"),
    },
  });
};

const loadCalendarProjects = (
  db: Database,
  input: CalendarRangeInput,
  scope: CalendarProjectScope,
) => {
  if (input.kinds && !input.kinds.includes("project")) {
    return Promise.resolve([]);
  }
  const presence =
    input.projectPresenceFilter === "has"
      ? sql`true`
      : input.projectPresenceFilter === "none"
        ? sql`false`
        : undefined;
  return getDb(db)
    .select({
      id: project.id,
      shortcode: project.shortcode,
      name: project.name,
      status: project.status,
      kind: project.kind,
    })
    .from(project)
    .where(
      and(
        notDeleted(project),
        eqAny(project.status, input.projectStatus),
        or(
          eqAny(project.kind, input.projectKind),
          presenceCondition(project.kind, input.projectKindPresenceFilter),
        ),
        or(
          scope.scopeIds.length
            ? inArray(project.id, scope.scopeIds)
            : scope.projectRequested
              ? sql`false`
              : undefined,
          presence,
        ),
      ),
    );
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
    startDate: meal.date,
    endDateExclusive: shiftPlainDate(meal.date, 1),
    interaction: "move",
    sortOrder: meal.sortOrder,
    mealType: meal.mealType,
    mealKind: meal.mealKind,
    recipeNames: meal.recipes.map((recipe) => recipe.recipe.name),
    coverImageUrl:
      meal.recipes
        .map((recipe) => recipeCoverImageUrls.get(recipe.recipeId))
        .find((url) => url !== undefined) ?? null,
    mealTotals: meal.totals,
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
    const startDate = value.dueDate ?? value.dueEndDate;
    const endDate = value.dueEndDate ?? value.dueDate;
    return startDate && endDate
      ? [
          {
            kind: "task" as const,
            id: parseShortcodeFor("task", row.shortcode),
            title: value.name,
            startDate,
            endDateExclusive: shiftPlainDate(endDate, 1),
            interaction: "move" as const,
            dueDate: value.dueDate,
            dueEndDate: value.dueEndDate,
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
            cost: row.scopedCost,
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
  const wants = (kind: CalendarItemKind) =>
    !input.kinds || input.kinds.includes(kind);

  // The tree is shared by scope expansion and the project date fold. Loading
  // it here prevents either branch from scanning the project table twice.
  const scope = await loadCalendarProjectScope(db, input, wants("project"));
  const vendorIds = input.expenseVendorId
    ? await resolveAllPresent(db, "vendor", [input.expenseVendorId].flat())
    : [];
  const [
    meals,
    taskRows,
    expenseRows,
    projectRows,
    plantingRows,
    projectDates,
  ] = await Promise.all([
    loadCalendarMeals(db, input, endInclusive),
    loadCalendarTasks(db, input, endInclusive, scope),
    loadCalendarExpenses(db, input, endInclusive, scope, vendorIds),
    loadCalendarProjects(db, input, scope),
    loadCalendarPlantings(db, input, endInclusive),
    // The date fold stays WHOLE-TREE on purpose. `aggregateSubtreeDates`
    // folds a parent's window up from its descendants, so scoping the fold to
    // the filtered set would make a filtered-in parent lose the window its
    // filtered-out children contribute. Only the emitted rows narrow.
    //
    // `loadProjectDateWindows`, not `loadProjectSubtreeRollups`: the calendar
    // reads `.dateWindows` and nothing else, and the rollup variant
    // additionally runs two spend/task aggregates whose results are discarded.
    wants("project") ? loadProjectDateWindows(db, scope.tree) : null,
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
