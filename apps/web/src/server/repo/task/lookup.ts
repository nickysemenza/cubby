import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import { unsafeProjectId, unsafeTaskId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type PresenceFilter,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { taskSortableFields } from "@cubby/schemas/project";
import {
  type AnyColumn,
  and,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { product, task } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  notDeleted,
  presenceCondition,
  relations,
} from "~/server/repo/database-helpers";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { resolveShortcode, resolveShortcodes } from "~/server/repo/shortcode-resolver";
import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { dbTaskToAPI, effectiveTaskDueDateSql } from "./helpers";

/**
 * Resolve a batch of shortcodes to their (unbranded) uuids for use in a WHERE
 * clause. Unknown/malformed codes simply drop out — a filter naming a code
 * that doesn't exist should match nothing, not throw.
 */
const toUuids = async (
  db: Database,
  codes: readonly string[],
): Promise<string[]> => {
  if (codes.length === 0) return [];
  const resolved = await resolveShortcodes(db, codes);
  return codes.flatMap((code) => {
    const ref = resolved.get(code);
    return ref ? [ref.id] : [];
  });
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
export async function buildTaskProjectCondition(
  db: Database,
  projectId: ProjectShortcode | ProjectShortcode[] | undefined,
  includeSubProjects: boolean | undefined,
  presence?: PresenceFilter,
): Promise<SQL | undefined> {
  const presenceCond = presenceCondition(task.projectId, presence);
  const selectedCodes = projectId ? [projectId].flat() : [];
  if (selectedCodes.length === 0) return presenceCond;
  const selected = (await toUuids(db, selectedCodes)).map(unsafeProjectId);
  if (selected.length === 0) return presenceCond;
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

export const taskList = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: TaskOut[]; count: number }> => {
  const dbClient = getDb(db);
  const projectCondition = await buildTaskProjectCondition(
    db,
    filters.projectId,
    filters.includeSubProjects,
    filters.projectPresenceFilter,
  );
  const parentTaskUuid = filters.parentTaskId
    ? await resolveShortcode(db, filters.parentTaskId)
    : null;
  const subjectProductNameMatches = filters.search
    ? dbClient
        .select({ id: product.id })
        .from(product)
        .where(
          and(
            notDeleted(product),
            formatSearchTerm(product.name, filters.search),
          ),
        )
    : undefined;
  const searchCondition = filters.search
    ? or(
        formatSearchTerm(task.name, filters.search),
        subjectProductNameMatches
          ? inArray(task.subjectProductId, subjectProductNameMatches)
          : undefined,
      )
    : undefined;

  const whereClause = buildSearchConditions(
    task,
    [],
    [
      searchCondition,
      eqAny(task.status, filters.status),
      // Carries `projectPresenceFilter` too — it ORs with the id selection, so
      // it can't be a sibling condition here (that AND is what made
      // "project A or unassigned" inexpressible).
      projectCondition,
      eqAnyOrPresence(
        task.subjectProductId,
        filters.subjectProductId,
        filters.subjectProductPresenceFilter,
      ),
      eqAny(task.trade, filters.trade),
      filters.topLevelOnly ? isNull(task.parentTaskId) : undefined,
      parentTaskUuid && parentTaskUuid.entity === "task"
        ? eq(task.parentTaskId, unsafeTaskId(parentTaskUuid.id))
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
      filters.dueFrom
        ? gte(effectiveTaskDueDateSql(), filters.dueFrom)
        : undefined,
      filters.dueTo ? lte(effectiveTaskDueDateSql(), filters.dueTo) : undefined,
      // Completion scope: undefined/"all" adds no condition (today's default,
      // unchanged) — see taskCompletionSchema.
      filters.completion === "open"
        ? ne(task.status, "done")
        : filters.completion === "done"
          ? eq(task.status, "done")
          : undefined,
    ],
  );

  const orderByArray = buildOrderBy(task, sorts, [...taskSortableFields], {
    resolve: resolveTaskSort,
  });
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    dbClient.query.task.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.task.withProject,
    }),
    countWhere(db, task, whereClause),
  );

  const ids = rows.map((r) => r.id);
  const [deps, subtaskCounts] = await Promise.all([
    taskDependencyIds(db, ids),
    taskSubtaskCounts(db, ids),
  ]);

  const data = rows.map((row) => {
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
