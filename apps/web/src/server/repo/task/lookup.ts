import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import type {
  PaginationParams,
  PresenceFilter,
  SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters } from "@cubby/schemas/project";
import {
  type AnyColumn,
  and,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { product, task } from "~/server/db/schema";
import {
  auditDateWhereConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  relations,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import { matchingEmbeddedProjectIds } from "~/server/repo/project/dashboard-shared";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";

import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI, effectiveTaskDueDateSql } from "./helpers";

/**
 * Resolve a batch of shortcodes to their (unbranded) uuids for use in a WHERE
 * clause. Unknown/malformed codes simply drop out — a filter naming a code
 * that doesn't exist should match nothing, not throw. The `entity` parameter
 * pins the expected type so a wrong-prefix code (a `LOC-` code passed as a
 * task filter) is silently dropped rather than matching an unrelated row —
 * mirrors `expense/lookup.ts`'s and `project/lookup.ts`'s siblings.
 *
 * `resolveAllPresent` applies the same live-row semantics as the list itself,
 * including canonical/legacy shortcode normalization.
 */
const toUuids = async <E extends ShortcodeEntity>(
  db: Database,
  codes: readonly string[],
  entity: E,
): Promise<EntityId<E>[]> => {
  return resolveAllPresent(db, entity, codes);
};

/**
 * The `task.projectId` WHERE condition for a `projectId` + `includeSubProjects`
 * filter pair: a plain equality match, or — when `includeSubProjects` is set —
 * an `inArray` over the project plus every live descendant (walking
 * `parentProjectId` down via project/subtree.ts's shared helpers). Shared by
 * `taskList` and `getTaskBoard` so the subtree-expansion logic lives in one
 * place.
 *
 * `presence` is the header filter's `(none)` / `Has project` sentinel, OR-ed
 * with the selection rather than ANDed against it: `{projectId: [A],
 * presence: "none"}` means "project A **or** unassigned". That's why it can't
 * just be a separate condition in the caller's list — an AND there is the bug
 * this replaced. `undefined` when neither is given (no condition added).
 */
async function buildTaskProjectCondition(
  db: Database,
  projectId: TaskFilters["projectId"],
  includeSubProjects: boolean | undefined,
  presence?: PresenceFilter,
): Promise<SQL | undefined> {
  const presenceCond = presenceCondition(task.projectId, presence);
  const selectedCodes = projectId ? [projectId].flat() : [];
  if (selectedCodes.length === 0) return presenceCond;
  const selected = await toUuids(db, selectedCodes, "project");
  if (selected.length === 0) return presenceCond ?? sql`false`;
  if (!includeSubProjects)
    return or(eqAny(task.projectId, selected), presenceCond);

  const { childrenByParent } = await loadProjectTree(db);
  return or(
    inArray(
      task.projectId,
      uniq(
        selected.flatMap((id) => [
          id,
          ...collectDescendantIds(childrenByParent, id),
        ]),
      ),
    ),
    presenceCond,
  );
}

/**
 * The joined project name isn't a column on `task` — a correlated subquery
 * keeps `taskList` a relational `findMany`. Soft-delete guarded and NULLS LAST
 * in both directions, matching `buildOrderBy`'s convention.
 */
const joinedNameSort = (
  sort: SortParams,
  tableName: string,
  foreignKey: AnyColumn,
) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";
  return [
    sql.raw(
      `(SELECT j."name" FROM "${tableName}" j ` +
        `WHERE j."id" = "task"."${foreignKey.name}" AND j."deletedAt" IS NULL) ${dirSql}`,
    ),
  ];
};

const resolveTaskSort = (sort: SortParams) => {
  if (sort.orderBy === "project") {
    return joinedNameSort(sort, "Project", task.projectId);
  }
  if (sort.orderBy === "subjectProduct") {
    return joinedNameSort(sort, "Product", task.subjectProductId);
  }
  return null;
};

const taskScaffold = listScaffold("task", task);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildTaskWhere = async (db: Database, filters: TaskFilters) => {
  const dbClient = getDb(db);
  const projectCondition = await buildTaskProjectCondition(
    db,
    filters.projectId,
    filters.includeSubProjects,
    filters.projectPresenceFilter,
  );
  const parentTaskCodes = filters.parentTaskId
    ? [filters.parentTaskId].flat()
    : [];
  const parentTaskIds = await toUuids(db, parentTaskCodes, "task");
  const scopedProjectIds = filters.projectScope
    ? await matchingEmbeddedProjectIds(db, filters.projectScope)
    : null;
  const subjectProductIds = await toUuids(
    db,
    filters.subjectProductId ? [filters.subjectProductId].flat() : [],
    "product",
  );
  const subjectProductCondition = () =>
    filters.subjectProductId &&
    [filters.subjectProductId].flat().length > 0 &&
    subjectProductIds.length === 0 &&
    !filters.subjectProductPresenceFilter
      ? sql`false`
      : eqAnyOrPresence(
          task.subjectProductId,
          subjectProductIds,
          filters.subjectProductPresenceFilter,
        );
  const parentTaskCondition = () =>
    parentTaskCodes.length > 0 &&
    parentTaskIds.length === 0 &&
    !filters.parentTaskPresenceFilter
      ? sql`false`
      : eqAnyOrPresence(
          task.parentTaskId,
          parentTaskIds,
          filters.parentTaskPresenceFilter,
        );
  const searchCondition = () => {
    if (!filters.search) return undefined;
    const subjectProductNameMatches = dbClient
      .select({ id: product.id })
      .from(product)
      .where(
        and(
          notDeleted(product),
          formatSearchTerm(product.name, filters.search),
        ),
      );
    return or(
      formatSearchTerm(task.name, filters.search),
      inArray(task.subjectProductId, subjectProductNameMatches),
    );
  };
  const scopeCondition = () =>
    scopedProjectIds
      ? scopedProjectIds.length > 0
        ? inArray(task.projectId, scopedProjectIds)
        : sql`false`
      : undefined;
  const dueConditions = () => [
    filters.dueFrom
      ? gte(effectiveTaskDueDateSql(), filters.dueFrom)
      : undefined,
    filters.dueTo ? lte(effectiveTaskDueDateSql(), filters.dueTo) : undefined,
    filters.dueRelative === "beforeToday"
      ? lt(effectiveTaskDueDateSql(), householdLocalDate())
      : filters.dueRelative === "onOrBeforeToday"
        ? lte(effectiveTaskDueDateSql(), householdLocalDate())
        : undefined,
    presenceCondition(
      task.dueDate,
      filters.duePresenceFilter,
      and(isNull(task.dueDate), isNull(task.dueEndDate)),
    ),
  ];
  const completionCondition = () =>
    filters.completion === "open"
      ? ne(task.status, "done")
      : filters.completion === "done"
        ? eq(task.status, "done")
        : undefined;

  // `status` and `trade` are declared stored filters — `taskScaffold.where`
  // applies them via `declaredFilterPredicates` before the conditions below.
  return taskScaffold.where(filters, [
    ...auditDateWhereConditions(task, filters),
    ...relatedWhereConditions("task", filters, task.id),
    searchCondition(),
    // Carries `projectPresenceFilter` too — it ORs with the id selection, so
    // it can't be a sibling condition here (that AND is what made
    // "project A or unassigned" inexpressible).
    projectCondition,
    subjectProductCondition(),
    filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
    parentTaskCondition(),
    scopeCondition(),
    // Filter on the EFFECTIVE due date — `dueEndDate ?? dueDate` — so a
    // ranged task still inside its window isn't treated as overdue, matching
    // the "overdue" semantics used on the board/stat tiles.
    //
    // A task with BOTH due columns null falls out of any window by plain SQL
    // comparison semantics — `coalesce(NULL, NULL) >= x` is NULL, not true —
    // that's intended, not a bug to work around (the identical rule is
    // documented for `expense.date` in `expense/lookup.ts`'s
    // `buildExpenseWhereClause`). The dashboard surfaces the count of rows
    // hidden this way as `hiddenByDate.tasks`.
    ...dueConditions(),
    // Completion scope: undefined/"all" adds no condition (today's default,
    // unchanged) — see taskCompletionSchema.
    completionCondition(),
  ]);
};

export const taskList = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
  const dbClient = getDb(db);
  const whereClause = await buildTaskWhere(db, filters);

  const orderByArray = taskScaffold.orderBy(
    sorts,
    {
      resolve: resolveTaskSort,
    },
    filters,
  );
  const { take, skip } = taskScaffold.page(pagination);

  const { data: rows, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      dbClient.query.task.findMany({
        where: whereClause,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        ...relations.task.withProject,
      }),
    count: () => countWhere(db, task, whereClause),
  });
  if (readIntent === "count") {
    return { data: [], count };
  }

  const ids = rows.map((r) => r.id);
  const [deps, subtaskCounts] = await Promise.all([
    taskDependencyIds(db, ids),
    taskSubtaskCounts(db, ids),
  ]);

  const data = await withDisplayImages(db, "task", rows, (row) => {
    const counts = subtaskCounts.get(row.id);
    return dbTaskToAPI(
      row,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );
  });

  return { data, count };
};
