import type { EntityId } from "@cubby/schemas/identifiers";
import type {
  PaginationParams,
  PresenceFilter,
  SortParams,
} from "@cubby/schemas/pagination";
import { taskListItemOut } from "@cubby/schemas/project";
import type { TaskFilters } from "@cubby/schemas/project";
import {
  and,
  eq,
  gte,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { projectListRows } from "~/entity/list-read-schema";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { product, task } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
  countWhere,
  eqAnyOrPresence,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  relations,
  uuidArrayParam,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list";
import {
  loadListGroup,
  wantsListGroup,
  type ListProjection,
} from "~/server/repo/list-projection";
import { matchingEmbeddedProjectIds } from "~/server/repo/project/dashboard-shared";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";

import { completeListReader } from "../list-read-adapters";
import {
  effectiveTaskProjectSql,
  effectiveTaskSubjectProductSql,
  effectiveTaskTradeSql,
  hydrateTaskInheritanceRows,
} from "../task-project-inheritance";
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI, effectiveTaskDueDateSql } from "./helpers";

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
function buildTaskProjectCondition(
  projectId: TaskFilters["projectId"],
  projectIds: EntityId<"project">[],
  presence?: PresenceFilter,
  taskAlias = "Task",
): SQL | undefined {
  const effectiveProjectId = effectiveTaskProjectSql(taskAlias);
  const presenceCond =
    presence === "has"
      ? sql`${effectiveProjectId} IS NOT NULL`
      : presence === "none"
        ? sql`${effectiveProjectId} IS NULL`
        : undefined;
  const selectedCodes = projectId ? [projectId].flat() : [];
  if (selectedCodes.length === 0) return presenceCond;
  if (projectIds.length === 0) return presenceCond ?? sql`false`;
  return or(
    sql`${effectiveProjectId} = ANY(${uuidArrayParam(projectIds)})`,
    presenceCond,
  );
}

async function resolveTaskFilterReferences(db: Database, filters: TaskFilters) {
  const parentTaskCodes = filters.parentTaskId
    ? [filters.parentTaskId].flat()
    : [];
  const [
    selectedProjectIds,
    parentTaskIds,
    scopedProjectIds,
    subjectProductIds,
  ] = await Promise.all([
    resolveAllPresent(
      db,
      "project",
      filters.projectId ? [filters.projectId].flat() : [],
    ),
    resolveAllPresent(db, "task", parentTaskCodes),
    filters.projectScope
      ? matchingEmbeddedProjectIds(db, filters.projectScope)
      : Promise.resolve(null),
    resolveAllPresent(
      db,
      "product",
      filters.subjectProductId ? [filters.subjectProductId].flat() : [],
    ),
  ]);
  let projectIds = selectedProjectIds;
  if (selectedProjectIds.length > 0 && filters.includeSubProjects) {
    const { childrenByParent } = await loadProjectTree(db);
    projectIds = uniq(
      selectedProjectIds.flatMap((id) => [
        id,
        ...collectDescendantIds(childrenByParent, id),
      ]),
    );
  }
  return {
    projectIds,
    parentTaskCodes,
    parentTaskIds,
    scopedProjectIds,
    subjectProductIds,
  };
}

/**
 * The joined project name isn't a column on `task` — a correlated subquery
 * keeps `taskList` a relational `findMany`. Soft-delete guarded and NULLS LAST
 * in both directions, matching `buildOrderBy`'s convention.
 */
const joinedNameSort = (
  sort: SortParams,
  tableName: string,
  foreignKey: SQL,
) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";
  return [
    sql`(SELECT j."name" FROM ${sql.raw(`"${tableName}"`)} j
        WHERE j."id" = ${foreignKey} AND j."deletedAt" IS NULL)
      ${sql.raw(dirSql)}`,
  ];
};

const resolveTaskSort = (sort: SortParams) => {
  if (sort.orderBy === "projectId") {
    return joinedNameSort(sort, "Project", effectiveTaskProjectSql("task"));
  }
  if (sort.orderBy === "subjectProductId") {
    return joinedNameSort(
      sort,
      "Product",
      effectiveTaskSubjectProductSql("task"),
    );
  }
  return null;
};

const taskScaffold = listScaffold("task", task);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildTaskWhere = async (
  db: Database,
  filters: TaskFilters,
  taskAlias = "Task",
  resolved?: Awaited<ReturnType<typeof resolveTaskFilterReferences>>,
) => {
  const dbClient = getDb(db);
  const {
    projectIds,
    parentTaskCodes,
    parentTaskIds,
    scopedProjectIds,
    subjectProductIds,
  } = resolved ?? (await resolveTaskFilterReferences(db, filters));
  const projectCondition = buildTaskProjectCondition(
    filters.projectId,
    projectIds,
    filters.projectPresenceFilter,
    taskAlias,
  );
  const subjectProductCondition = () =>
    filters.subjectProductId &&
    [filters.subjectProductId].flat().length > 0 &&
    subjectProductIds.length === 0 &&
    !filters.subjectProductPresenceFilter
      ? sql`false`
      : (() => {
          const effectiveSubject = effectiveTaskSubjectProductSql(taskAlias);
          const match =
            subjectProductIds.length > 0
              ? sql`${effectiveSubject} = ANY(${uuidArrayParam(subjectProductIds)})`
              : undefined;
          const presence =
            filters.subjectProductPresenceFilter === "has"
              ? sql`${effectiveSubject} IS NOT NULL`
              : filters.subjectProductPresenceFilter === "none"
                ? sql`${effectiveSubject} IS NULL`
                : undefined;
          return match && presence ? or(match, presence) : (match ?? presence);
        })();
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
      sql`${effectiveTaskSubjectProductSql(taskAlias)} IN ${subjectProductNameMatches}`,
    );
  };
  const scopeCondition = () =>
    scopedProjectIds
      ? scopedProjectIds.length > 0
        ? sql`${effectiveTaskProjectSql(taskAlias)} = ANY(${uuidArrayParam(scopedProjectIds)})`
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

  // `status` is declared stored; trade is resolved below instead of reading the
  // applies them via `declaredFilterPredicates` before the conditions below.
  return taskScaffold.where(filters, [
    searchCondition(),
    // Carries `projectPresenceFilter` too — it ORs with the id selection, so
    // it can't be a sibling condition here (that AND is what made
    // "project A or unassigned" inexpressible).
    projectCondition,
    subjectProductCondition(),
    filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
    parentTaskCondition(),
    scopeCondition(),
    filters.trade
      ? sql`${effectiveTaskTradeSql(taskAlias)} IN (${sql.join(
          [filters.trade].flat().map((value) => sql`${value}`),
          sql`, `,
        )})`
      : undefined,
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

export const taskListRead = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const resolved = await resolveTaskFilterReferences(db, filters);
  const [whereClause, countWhereClause] = await Promise.all([
    buildTaskWhere(db, filters, "task", resolved),
    buildTaskWhere(db, filters, "Task", resolved),
  ]);
  return taskScaffold.list(
    db,
    { filters, sorts, pagination, readIntent, projection },
    {
      where: whereClause,
      count: () => countWhere(db, task, countWhereClause),
      resolveSort: resolveTaskSort,
      select: (page) => {
        const declared = relations.task.withProject.with;
        const references =
          wantsListGroup(projection, "relations") ||
          wantsListGroup(projection, "derived");
        return getDb(db).query.task.findMany({
          ...page,
          with: {
            project: references ? declared.project : undefined,
            subjectProduct: references ? declared.subjectProduct : undefined,
            parentTask: references ? declared.parentTask : undefined,
            images: wantsListGroup(projection, "media")
              ? declared.images
              : undefined,
          },
        });
      },
      hydrate: async (rows) => {
        if (projection.kind === "base")
          return projectListRows(
            "task",
            rows.map((row) => ({ ...row, id: row.shortcode })),
            projection,
          );
        const ids = rows.map((r) => r.id);
        const [deps, subtaskCounts, dataQualities, hydratedRows] =
          await Promise.all([
            loadListGroup(projection, "relations", () =>
              taskDependencyIds(db, ids),
            ),
            loadListGroup(projection, "derived", () =>
              taskSubtaskCounts(db, ids),
            ),
            loadListGroup(projection, "quality", () =>
              loadDataQualities(db, "task", ids),
            ),
            loadListGroup(projection, ["relations", "derived"], () =>
              hydrateTaskInheritanceRows(db, rows),
            ),
          ]);
        const mapRow = (row: (typeof rows)[number]) => {
          const counts = subtaskCounts?.get(row.id);
          return dbTaskToAPI(
            {
              ...row,
              project: row.project ?? null,
              subjectProduct: row.subjectProduct ?? null,
              images:
                row.images?.map((image) => {
                  if (!("image" in image))
                    throw new Error("Task media relation was not loaded");
                  return image;
                }) ?? [],
            },
            deps?.blockedBy.get(row.id) ?? [],
            deps?.blocking.get(row.id) ?? [],
            counts?.count ?? 0,
            counts?.doneCount ?? 0,
            // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
            dataQualities?.get(row.id),
          );
        };
        const selectedRows = hydratedRows ?? rows;
        const mapped = wantsListGroup(projection, "media")
          ? await withDisplayImages(db, "task", selectedRows, mapRow)
          : selectedRows.map(mapRow);
        return projectListRows("task", mapped, projection);
      },
    },
  );
};

export const taskList = completeListReader(taskListItemOut, taskListRead);
