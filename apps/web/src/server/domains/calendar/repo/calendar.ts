import {
  calendarBeneficiarySource,
  calendarMealSource,
  calendarTaskSource,
  calendarExpenseSource,
  calendarProjectSource,
  calendarPurchaseSource,
  calendarPlantingSource,
  rawCalendarMealSource,
  rawCalendarTaskSource,
  rawCalendarExpenseSource,
  rawCalendarProjectSource,
  calendarItem,
} from "@cubby/schemas/calendar";
import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarSourceKind,
  CalendarRangeInput,
  CalendarRangeOut,
} from "@cubby/schemas/calendar";
import {
  calendarSources,
  calendarItemKey,
  calendarSourceMatches,
} from "@cubby/schemas/calendar";
import type { RawCalendarItem } from "@cubby/schemas/calendar-raw-read";
import { entityRefKey } from "@cubby/schemas/entity";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  MEAL_TYPE_LABELS,
  type MealType,
  mealTypeRank,
} from "@cubby/schemas/meal-classification";
import type { NutritionTotals } from "@cubby/schemas/nutrition";
import {
  type RawCalendarScheduleOut,
  rawExpenseOut,
  rawTaskOut,
} from "@cubby/schemas/work-raw-read";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { shiftPlainDate } from "~/lib/household-date";
import { aggregateTotals } from "~/lib/nutrition-estimates";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { expense, project, task, meal, planting } from "~/server/db/schema";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import {
  plantingScaffold,
  readPlantingById,
} from "~/server/domains/garden/repo/garden";
import {
  mealScaffold,
  getMealsByDateRange,
} from "~/server/domains/meal/repo/crud";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { loadProjectDateWindows } from "~/server/domains/project/repo/subtree";
import { loadPurchaseSpending } from "~/server/domains/purchase/repo/purchase-spending";
import { readTasksByIds } from "~/server/domains/task/repo/crud";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { publicFieldEnvelopeBatch } from "~/server/generic/derived/repo/public-read";
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
  purchase: 4,
} as const satisfies Record<CalendarItem["kind"], number>;

/** How an unnamed meal names itself: its slot, or the generic fallback. */
const mealTypeTitle = (mealType: MealType | null): string =>
  mealType ? MEAL_TYPE_LABELS[mealType] : "Meal";

/** Slot ordering — `mealTypeValues` is clock order — applied only when both
 *  items are meals. */
const mealSlotDelta = (a: CalendarItem, b: CalendarItem): number =>
  a.kind === "meal" && b.kind === "meal"
    ? mealTypeRank(fieldValueOf(a.source.fields.mealType)) -
      mealTypeRank(fieldValueOf(b.source.fields.mealType))
    : 0;

const sourceTables = { meal, task, spending: expense, project, planting };
const sourceScaffolds = {
  meal: mealScaffold,
  task: taskScaffold,
  spending: expenseScaffold,
  project: projectScaffold,
  planting: plantingScaffold,
} satisfies Record<
  CalendarSourceKind,
  NestedListScaffold<"meal" | "task" | "expense" | "project" | "planting">
>;

/** Use the source's prepared list population, including derived fields and
 * related scopes, before calendar hydration and date layout. Keep this predicate
 * in plain table queries: Drizzle relational hydration rewrites nested columns
 * to its outer alias, corrupting the matchingIds subquery. Hydrate by IDs. */
const calendarSourceWhere = async (
  db: Database,
  input: CalendarRangeInput,
  kind: CalendarSourceKind,
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
  page?: { limit: number; offset: number },
) => {
  if (!calendarSourceMatches("meal", input))
    return { rows: [], hasMore: false };
  const condition = await calendarSourceWhere(db, input, "meal");
  const query = getDb(db)
    .select({ id: meal.id })
    .from(meal)
    .where(
      and(
        condition,
        gte(meal[calendarSources.meal.dates[0]], input.startDate),
        lte(meal[calendarSources.meal.dates[0]], endInclusive),
      ),
    )
    .orderBy(asc(meal.date), asc(meal.id));
  const ids = await (page
    ? query.limit(page.limit).offset(page.offset)
    : query);
  const rows = ids.length
    ? await getMealsByDateRange(
        db,
        input.startDate,
        endInclusive,
        inArray(
          meal.id,
          ids.map((row) => row.id),
        ),
      )
    : [];
  return { rows, hasMore: page !== undefined && ids.length === page.limit };
};

const loadCalendarTasks = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
  page?: { limit: number; offset: number },
) => {
  if (!calendarSourceMatches("task", input))
    return { rows: [], hasMore: false };
  const condition = await calendarSourceWhere(db, input, "task");
  const query = getDb(db)
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        condition,
        or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
        lte(sql`coalesce(${task.dueDate}, ${task.dueEndDate})`, endInclusive),
        gte(effectiveTaskDueDateSql(), input.startDate),
      ),
    )
    .orderBy(asc(task.dueDate), asc(task.name), asc(task.id));
  const ids = await (page
    ? query.limit(page.limit).offset(page.offset)
    : query);
  const read = await taskScaffold.getByIds(
    db,
    ids.map((row) => row.id),
  );
  return {
    rows: read.data.map((row) => rawTaskOut.parse(row)),
    hasMore: page !== undefined && ids.length === page.limit,
  };
};

const loadCalendarExpenses = async (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  if (!calendarSourceMatches("spending", input)) return [];
  const condition = await calendarSourceWhere(db, input, "spending");
  const ids = await getDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        condition,
        or(isNull(expense.purchaseId), sql`${expense.future} = true`),
        sql`NOT (coalesce(${expense.cost}, 0) = 0 AND coalesce(${expense.productQuantity}, 0) < 0)`,
        isNotNull(expense[calendarSources.spending.dates[0]]),
        gte(expense[calendarSources.spending.dates[0]], input.startDate),
        lte(expense[calendarSources.spending.dates[0]], endInclusive),
      ),
    )
    .orderBy(asc(expense.date), asc(expense.name));
  const read = await expenseScaffold.getByIds(
    db,
    ids.map((row) => row.id),
  );
  return read.data.map((row) => rawExpenseOut.parse(row));
};

const loadCalendarPurchaseItems = async (
  db: Database,
  input: CalendarRangeInput,
): Promise<RawCalendarItem[]> => {
  if (!calendarSourceMatches("spending", input)) return [];
  const filters = input.filters?.spending;
  const hasFilters =
    filters &&
    Object.entries(filters).some(
      ([key, value]) => value !== undefined && !key.startsWith("includeSub"),
    );
  const events = await loadPurchaseSpending(db, {
    startDate: input.startDate,
    endDateExclusive: input.endDateExclusive,
    expenseCondition: hasFilters
      ? await calendarSourceWhere(db, input, "spending")
      : undefined,
  });
  return events
    .filter(
      (event) =>
        !(
          event.lines.length > 0 &&
          event.lines.every(
            ({ line }) =>
              (line.cost ?? 0) === 0 && (line.productQuantity ?? 0) < 0,
          )
        ),
    )
    .map((event) => ({
      kind: "purchase",
      id: event.purchase.id,
      title: event.purchase.vendorName ?? event.purchase.title,
      vendor: event.purchase.vendorName,
      occurrence: event.occurrence,
      startDate: event.date,
      endDateExclusive: shiftPlainDate(event.date, 1),
      interaction: "read-only",
      cost: event.amount,
      ledgerAmount: event.ledgerAmount,
      basis: event.basis,
      dateBasis: event.dateBasis,
      evidenceNote:
        event.ambiguities.length > 0
          ? "Some refund evidence could not be matched uniquely. Review the full purchase."
          : undefined,
      lines: event.lines.map(({ line }) => ({
        id: line.id,
        name: line.name,
        cost: line.cost,
        productName: null,
      })),
      displayImages: [],
    }));
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

const mapMealItems = async (
  meals: Awaited<ReturnType<typeof loadCalendarMeals>>["rows"],
): Promise<RawCalendarItem[]> => {
  return meals.map((meal) => ({
    kind: "meal",
    id: meal.id,
    title: meal.name || mealTypeTitle(meal.mealType),
    name: meal.name,
    startDate: meal[calendarSources.meal.dates[0]],
    endDateExclusive: shiftPlainDate(meal[calendarSources.meal.dates[0]], 1),
    interaction: "move" as const,
    sortOrder: meal.sortOrder,
    source: rawCalendarMealSource.parse({
      ...meal,
      recipeNames: meal.recipes.map((recipe) => recipe.recipe.name),
    }),
    displayImages: [],
    mealTotals: meal.totals,
  }));
};

const mapTaskItems = (
  values: Awaited<ReturnType<typeof loadCalendarTasks>>["rows"],
): RawCalendarItem[] =>
  values.flatMap((value) => {
    const startDate = value.due?.start ?? value.due?.end;
    const endDate = effectiveTaskDueDate(value) ?? undefined;
    return startDate && endDate
      ? [
          {
            kind: "task" as const,
            id: value.id,
            title: value.name,
            startDate,
            endDateExclusive: shiftPlainDate(endDate, 1),
            interaction: "move" as const,
            due: value.due,
            status: value.status,
            source: rawCalendarTaskSource.parse(value),
            projectName: value.projectName,
            assignedProjectName:
              value.fieldResolutions?.projectId?.mode === "explicit"
                ? value.projectName
                : null,
            subjectProductName: value.subjectProductName,
            displayImages: [],
          },
        ]
      : [];
  });

const mapExpenseItems = (
  values: Awaited<ReturnType<typeof loadCalendarExpenses>>,
): RawCalendarItem[] =>
  values.flatMap((value) =>
    value.date
      ? [
          {
            kind: "expense" as const,
            id: value.id,
            title: value.name,
            startDate: value.date,
            endDateExclusive: shiftPlainDate(value.date, 1),
            interaction: value.future
              ? ("move" as const)
              : ("read-only" as const),
            future: value.future,
            cost: value.cost,
            source: rawCalendarExpenseSource.parse(value),
            projectName: value.projectName,
            productName: value.productName,
            displayImages: [],
          },
        ]
      : [],
  );

const mapProjectItems = async (
  rows: Awaited<ReturnType<typeof loadCalendarProjects>>,
  projectDates: Awaited<ReturnType<typeof loadProjectDateWindows>> | null,
  input: CalendarRangeInput,
): Promise<RawCalendarItem[]> => {
  const selected = rows.flatMap((row) => {
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
            displayImages: [],
            id: parseShortcodeFor("project", row.shortcode),
            title: row.name,
            startDate,
            endDateExclusive: shiftPlainDate(endDate, 1),
            interaction: "read-only" as const,
            status: row.status,
            source: {
              id: parseShortcodeFor("project", row.shortcode),
              kind: row.kind,
            },
          },
        ];
  });

  return selected.map((item) => ({
    ...item,
    source: rawCalendarProjectSource.parse(item.source),
  }));
};

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
      summary.itemIds.push(calendarItemKey(item));
      if (item.kind === "meal") {
        summary.mealCount += 1;
        mealTotalsByDay[day]?.push(item.mealTotals);
      } else if (item.kind === "task") summary.taskCount += 1;
      else if (item.kind === "expense") {
        summary.expenseCount += 1;
        if (item.future) summary.plannedSpend += item.cost ?? 0;
        else summary.actualSpend += item.cost ?? 0;
      } else if (item.kind === "purchase") {
        summary.expenseCount += 1;
        summary.actualSpend += item.ledgerAmount;
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
async function getCalendarItems(
  db: Database,
  input: CalendarRangeInput,
  page?: { limit: number; offset: number },
): Promise<{ items: CalendarItem[]; hasMore: boolean }> {
  const endInclusive = shiftPlainDate(input.endDateExclusive, -1);
  // Omitted `kinds` means all five, so the in-app calendar is unchanged. A
  // narrowed request skips whole reads rather than filtering after the fact —
  // the ICS feed asks for meals + tasks (or, for the garden feed, plantings),
  // and the project branch it drops is a whole-tree date fold it would
  // otherwise pay for on every poll.
  const wants = (kind: CalendarSourceKind) =>
    calendarSourceMatches(kind, input);

  const [
    mealPage,
    taskPage,
    expenseRows,
    purchaseItems,
    projectRows,
    plantingRows,
    projectDates,
  ] = await Promise.all([
    loadCalendarMeals(db, input, endInclusive, page),
    loadCalendarTasks(db, input, endInclusive, page),
    loadCalendarExpenses(db, input, endInclusive),
    loadCalendarPurchaseItems(db, input),
    loadCalendarProjects(db, input),
    calendarSourceWhere(db, input, "planting").then((condition) =>
      loadCalendarPlantings(db, input, endInclusive, condition, page),
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

  const [mealItems, taskItems, expenseItems, projectItems] = await Promise.all([
    mapMealItems(mealPage.rows),
    mapTaskItems(taskPage.rows),
    mapExpenseItems(expenseRows),
    mapProjectItems(projectRows, projectDates, input),
  ]);
  const items = [
    ...mealItems,
    ...taskItems,
    ...expenseItems,
    ...purchaseItems,
    ...projectItems,
    ...mapPlantingItems(plantingRows, input),
  ];
  const spendingLineCodes = [
    ...new Set(
      items.flatMap((item) =>
        item.kind === "expense"
          ? [item.id]
          : item.kind === "purchase"
            ? item.lines.map((line) => line.id)
            : [],
      ),
    ),
  ];
  const spendingRows = spendingLineCodes.length
    ? await getDb(db)
        .select({
          shortcode: expense.shortcode,
          name: expense.name,
          expenseId: expense.id,
          projectName: project.name,
        })
        .from(expense)
        .leftJoin(
          project,
          and(eq(project.id, expense.projectId), notDeleted(project)),
        )
        .where(
          and(
            inArray(expense.shortcode, spendingLineCodes),
            notDeleted(expense),
          ),
        )
    : [];
  const spendingByLine = new Map<string, typeof spendingRows>();
  for (const row of spendingRows) {
    const rows = spendingByLine.get(row.shortcode) ?? [];
    rows.push(row);
    spendingByLine.set(row.shortcode, rows);
  }
  type SpendingParty = NonNullable<
    Extract<CalendarItem, { kind: "expense" }>["spendingContext"]
  >["parties"][number];
  const covers = await resolvePublicEntityDisplayImageLists(
    db,
    items.map((item) => ({ entityKind: item.kind, entityId: item.id })),
  );
  const sourceSchemas = {
    meal: calendarMealSource,
    task: calendarTaskSource,
    expense: calendarExpenseSource,
    purchase: calendarPurchaseSource,
    project: calendarProjectSource,
    planting: calendarPlantingSource,
  };
  const sources = await publicFieldEnvelopeBatch({
    db,
    reads: [
      ...items.map((item) => ({
        entity: item.kind,
        schema: sourceSchemas[item.kind],
        row: {
          ...("source" in item ? item.source : undefined),
          id: item.id,
          displayImages: covers.get(entityRefKey(item.kind, item.id)) ?? [],
        },
      })),
      ...spendingRows.map((row) => ({
        entity: "expense" as const,
        schema: calendarBeneficiarySource,
        row: {
          id: row.shortcode,
          name: row.name,
          effectiveBeneficiaries: null,
        },
      })),
    ],
  });
  const beneficiarySources = new Map(
    spendingRows.map((row, index) => [
      row.shortcode,
      calendarBeneficiarySource.parse(sources[items.length + index]),
    ]),
  );
  const hydrated = items.map((item, index) => {
    const rows = (
      item.kind === "expense"
        ? [item.id]
        : item.kind === "purchase"
          ? item.lines.map((line) => line.id)
          : []
    ).flatMap((code) => spendingByLine.get(code) ?? []);
    const parties = new Map<string, SpendingParty>();
    for (const row of rows) {
      const source = beneficiarySources.get(row.shortcode);
      const resolved = source
        ? (fieldValueOf(source.fields.effectiveBeneficiaries) ?? []).flatMap(
            (portion) =>
              portion.partyId && portion.partyName
                ? [
                    {
                      id: portion.partyId,
                      name: portion.partyName,
                      inherited: portion.basis !== "recorded",
                    },
                  ]
                : [],
          )
        : [];
      for (const party of resolved)
        parties.set(party.id, {
          ...party,
          inherited:
            party.inherited && (parties.get(party.id)?.inherited ?? true),
        });
    }
    return calendarItem.parse({
      ...item,
      source: sources[index],
      ...((item.kind === "expense" || item.kind === "purchase") && {
        spendingContext: {
          beneficiarySources: [
            ...new Set(rows.map((row) => row.shortcode)),
          ].flatMap((code) => {
            const source = beneficiarySources.get(code);
            return source ? [source] : [];
          }),
          projectNames: [
            ...new Set(
              rows.flatMap((row) => (row.projectName ? [row.projectName] : [])),
            ),
          ].sort(),
          parties: [...parties.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
      }),
    });
  });
  return {
    items: sortCalendarItems(hydrated),
    hasMore:
      mealPage.hasMore ||
      taskPage.hasMore ||
      (page !== undefined && plantingRows.length === page.limit),
  };
}

/** Visit bounded feed pages under one snapshot; the awaited consumer releases each page. */
export async function visitCalendarFeedItems(
  db: Database,
  input: CalendarRangeInput,
  visit: (items: CalendarItem[]) => Promise<void>,
): Promise<void> {
  if (
    !input.kinds ||
    input.kinds.some(
      (kind) => kind !== "meal" && kind !== "task" && kind !== "planting",
    )
  )
    throw new Error(
      "Calendar feed pages require meal, task, or planting kinds",
    );
  const limit = 100;
  await withTransactionDatabase(db, async (snapshotDb) => {
    await getDb(snapshotDb).execute(
      sql`set transaction isolation level repeatable read read only`,
    );
    for (let offset = 0; ; offset += limit) {
      const page = await getCalendarItems(snapshotDb, input, { limit, offset });
      await visit(page.items);
      if (!page.hasMore) break;
    }
  });
}

export async function getCalendarRange(
  db: Database,
  input: CalendarRangeInput,
): Promise<CalendarRangeOut> {
  const { items } = await getCalendarItems(db, input);
  return { items, days: summarizeCalendarDays(input, items) };
}

/** One read for the two-kind Schedule workbench. The window selects dated
 * records by overlap, while records with no date remain available in its
 * undated lanes. Filters use the same source membership as the date grid. */
export async function getCalendarSchedule(
  db: Database,
  input: CalendarRangeInput,
): Promise<RawCalendarScheduleOut> {
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
                  gte(effectiveTaskDueDateSql(), input.startDate),
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
    readTasksByIds(
      db,
      taskIds.map((row) => row.id),
    ),
    Promise.all(
      plantingIds.map((row) =>
        readPlantingById(db, parseEntityId("planting", row.id)),
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
