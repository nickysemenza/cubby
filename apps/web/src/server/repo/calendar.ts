import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
  CalendarRangeInput,
  CalendarRangeOut,
} from "@cubby/schemas/calendar";
import {
  unsafeExpenseShortcode,
  unsafeProjectShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import {
  MEAL_TYPE_LABELS,
  type MealType,
  mealTypeRank,
} from "@cubby/schemas/meal-classification";
import { addDays } from "date-fns";
import type { AnyColumn, SQL } from "drizzle-orm";
import { and, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { expense, project, purchase, task } from "~/server/db/schema";
import { getDb, notDeleted, relations } from "./database-helpers";
import { eqAny, presenceCondition } from "./database-helpers/query";
import { dbExpenseToAPI } from "./expense/helpers";
import { chargeCondition } from "./expense/lookup";
import { getMealsByDateRange } from "./meal";
import {
  collectDescendantIds,
  loadProjectDateWindows,
  loadProjectTree,
} from "./project/subtree";
import { resolveAllPresent } from "./shortcode-resolver";
import { dbTaskToAPI } from "./task/helpers";

const emptyDaySummary = (): CalendarDaySummary => ({
  actualSpend: 0,
  plannedSpend: 0,
  calories: 0,
  nutritionPending: false,
  taskCount: 0,
  expenseCount: 0,
  mealCount: 0,
  projectCount: 0,
});

const shiftPlainDate = (value: string, amount: number) =>
  formatPlainDate(addDays(parsePlainDate(value), amount));

const itemOrder: Record<CalendarItem["kind"], number> = {
  project: 0,
  task: 1,
  meal: 2,
  expense: 3,
};

/** How an unnamed meal names itself: its slot, or the generic fallback. */
const mealTypeTitle = (mealType: MealType | null): string =>
  mealType ? MEAL_TYPE_LABELS[mealType] : "Meal";

/** Slot ordering, applied only when both items are meals. */
const mealSlotDelta = (a: CalendarItem, b: CalendarItem): number =>
  a.kind === "meal" && b.kind === "meal"
    ? mealTypeRank(a.mealType) - mealTypeRank(b.mealType)
    : 0;

/**
 * One bounded read for the unified planning calendar. Date-only comparisons
 * stay as YYYY-MM-DD strings; ReUI Date conversion is a client boundary.
 */
export async function getCalendarRange(
  db: Database,
  input: CalendarRangeInput,
): Promise<CalendarRangeOut> {
  const endInclusive = shiftPlainDate(input.endDateExclusive, -1);
  // Omitted `kinds` means all four, so the in-app calendar is unchanged. A
  // narrowed request skips whole reads rather than filtering after the fact —
  // the ICS feed asks for meals + tasks, and the project branch it drops is a
  // whole-tree date fold it would otherwise pay for on every poll.
  const wants = (kind: CalendarItemKind) =>
    !input.kinds || input.kinds.includes(kind);

  // ── Project scope ───────────────────────────────────────────────────────
  // Resolved once, ahead of the reads, because three branches share it.
  const projectCodes = input.projectId ? [input.projectId].flat() : [];
  const projectRequested = projectCodes.length > 0;
  const selectedProjectIds = projectRequested
    ? await resolveAllPresent(db, "project", projectCodes)
    : [];
  // The tree is needed by the scope expansion AND by the date fold below, so
  // load it once and hand it to both — this branch used to scan every project
  // row twice.
  const tree =
    projectRequested || wants("project")
      ? await loadProjectTree(db)
      : undefined;
  const scopeIds =
    tree && selectedProjectIds.length
      ? uniq(
          selectedProjectIds.flatMap((id) => [
            id,
            // A project bar is already the SUBTREE-folded window, so scoping
            // to a parent without its descendants would draw a span covering
            // dates whose tasks and expenses are hidden — a contradiction on
            // the same pixels. Hence the expansion, always.
            ...(input.includeSubProjects
              ? collectDescendantIds(tree.childrenByParent, id)
              : []),
          ]),
        )
      : selectedProjectIds;

  /**
   * The project predicate for a table with a nullable `projectId`.
   *
   * A requested-but-unresolved code must match NOTHING rather than widening to
   * an unfiltered query, hence the explicit `false` arm. The presence sentinel
   * ORs with the id selection rather than ANDing, so "Kitchen or unassigned" is
   * one filter — the repo-wide `eqAnyOrPresence` semantics.
   */
  const projectScopeOn = (column: AnyColumn): SQL | undefined =>
    or(
      scopeIds.length
        ? inArray(column, scopeIds)
        : projectRequested
          ? sql`false`
          : undefined,
      presenceCondition(column, input.projectPresenceFilter),
    );

  /**
   * Meals have no project relation, so they are treated as permanently
   * unassigned rows rather than being dropped outright.
   *
   * Dropping them would break `(none)` — the unassigned-work worklist, which is
   * exactly where a meal belongs — and passing them through would make
   * `?project=X` render a month still dominated by unrelated dinners, with
   * "Has project" and "(none)" returning identical meal sets. Reading them as
   * NULL-valued is the only interpretation under which the sentinels mean what
   * they mean everywhere else.
   */
  const mealsInProjectScope =
    input.projectPresenceFilter === "none" ||
    (!projectRequested && input.projectPresenceFilter === undefined);

  const vendorIds = input.expenseVendorId
    ? await resolveAllPresent(db, "vendor", [input.expenseVendorId].flat())
    : [];

  const [meals, taskRows, expenseRows, projectRows, projectDates] =
    await Promise.all([
      wants("meal") && mealsInProjectScope
        ? getMealsByDateRange(db, input.startDate, endInclusive)
        : [],
      wants("task")
        ? getDb(db).query.task.findMany({
            where: and(
              notDeleted(task),
              or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
              lte(
                sql`coalesce(${task.dueDate}, ${task.dueEndDate})`,
                endInclusive,
              ),
              gte(
                sql`coalesce(${task.dueEndDate}, ${task.dueDate})`,
                input.startDate,
              ),
              // Task-scoped filters live HERE and nowhere else — that is the
              // cross-kind rule (see calendarFilterFields): narrowing tasks by
              // status must leave every meal, expense, and project span alone.
              eqAny(task.status, input.taskStatus),
              eqAny(task.trade, input.taskTrade),
              projectScopeOn(task.projectId),
            ),
            orderBy: (row, { asc }) => [asc(row.dueDate), asc(row.name)],
            ...relations.task.withProject,
          })
        : [],
      wants("expense")
        ? getDb(db).query.expense.findMany({
            where: and(
              notDeleted(expense),
              isNotNull(expense.date),
              gte(expense.date, input.startDate),
              lte(expense.date, endInclusive),
              input.expenseFuture !== undefined
                ? eq(expense.future, input.expenseFuture)
                : undefined,
              projectScopeOn(expense.projectId),
              // Vendor rides on the charge, so it goes through
              // `chargeCondition` rather than a hand-written subquery: that
              // helper carries the uncorrelated-IN shape the relational query
              // builder requires AND the mandatory `notDeleted(purchase)`,
              // which the soft-delete guard cannot see here.
              or(
                input.expenseVendorId
                  ? vendorIds.length
                    ? chargeCondition(db, eqAny(purchase.vendorId, vendorIds))
                    : sql`false`
                  : undefined,
                presenceCondition(
                  expense.purchaseId,
                  input.expenseVendorPresenceFilter,
                ),
              ),
            ),
            orderBy: (row, { asc }) => [asc(row.date), asc(row.name)],
            ...relations.expense.withProject,
          })
        : [],
      wants("project")
        ? getDb(db)
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
                  presenceCondition(
                    project.kind,
                    input.projectKindPresenceFilter,
                  ),
                ),
                // A span always HAS a project — itself — so `has` is vacuously
                // true and `none` vacuously false, each OR-ing with the id
                // selection the same way the nullable columns above do.
                or(
                  scopeIds.length
                    ? inArray(project.id, scopeIds)
                    : projectRequested
                      ? sql`false`
                      : undefined,
                  input.projectPresenceFilter === "has"
                    ? sql`true`
                    : input.projectPresenceFilter === "none"
                      ? sql`false`
                      : undefined,
                ),
              ),
            )
        : [],
      // The date fold stays WHOLE-TREE on purpose. `aggregateSubtreeDates`
      // folds a parent's window up from its descendants, so scoping the fold to
      // the filtered set would make a filtered-in parent lose the window its
      // filtered-out children contribute. Only the emitted rows narrow.
      //
      // `loadProjectDateWindows`, not `loadProjectSubtreeRollups`: the calendar
      // reads `.dateWindows` and nothing else, and the rollup variant
      // additionally runs two spend/task aggregates whose results are discarded.
      wants("project") ? loadProjectDateWindows(db, tree) : null,
    ]);

  const items: CalendarItem[] = [];

  for (const meal of meals) {
    items.push({
      kind: "meal",
      id: meal.id,
      // An unnamed meal now identifies itself by its slot ("Dinner") instead
      // of the bare literal "Meal" — this title is what the calendar chip and
      // the iCalendar SUMMARY both render.
      title: meal.name || mealTypeTitle(meal.mealType),
      startDate: meal.date,
      endDateExclusive: shiftPlainDate(meal.date, 1),
      interaction: "move",
      sortOrder: meal.sortOrder,
      mealType: meal.mealType,
      mealKind: meal.mealKind,
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
      id: unsafeTaskShortcode(row.shortcode),
      title: value.name,
      startDate,
      endDateExclusive: shiftPlainDate(endDate, 1),
      interaction: "move",
      status: value.status,
      trade: value.trade,
      projectName: value.projectName,
    });
  }

  for (const row of expenseRows) {
    const value = dbExpenseToAPI(row);
    if (!value.date) continue;
    items.push({
      kind: "expense",
      id: unsafeExpenseShortcode(row.shortcode),
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
    const window = projectDates?.dateWindows.get(row.id);
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
      id: unsafeProjectShortcode(row.shortcode),
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
      // Within a day, meals run in slot order — breakfast before dinner
      // regardless of what they're called. Before this, a breakfast named
      // "Oatmeal" sorted after a dinner named "Chili". Unslotted meals rank
      // last and keep their alphabetical order among themselves.
      mealSlotDelta(a, b) ||
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
      } else if (item.kind === "expense") {
        summary.expenseCount += 1;
        if (item.future) summary.plannedSpend += item.cost ?? 0;
        else summary.actualSpend += item.cost ?? 0;
      } else {
        summary.projectCount += 1;
      }
    }
  }

  return { items, days };
}
