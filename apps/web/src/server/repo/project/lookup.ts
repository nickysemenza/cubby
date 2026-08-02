import {
  unsafeProjectId,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProjectFilters,
  ProjectOptionsOut,
  ProjectOut,
} from "@cubby/schemas/project";
import { projectSortableFields } from "@cubby/schemas/project";
import { arrayOverlaps, asc, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  notDeleted,
  presenceCondition,
} from "~/server/repo/database-helpers";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";
import { projectContentDates, projectDependencyIds } from "./analytics";
import { dashboardProjectDateCondition } from "./dashboard-shared";
import { EMPTY_PROJECT_DATE_WINDOW, hydrateProjectRow } from "./helpers";
import {
  aggregateSubtreeDates,
  collectDescendantIds,
  loadProjectDateWindows,
  loadProjectSubtreeRollups,
  loadProjectTree,
  projectCompletionYear,
} from "./subtree";

/**
 * Lightweight `{id, name}` options for pickers/filter selects — no
 * rollup/dependency joins. Feeds `project.options` (see `useProjectOptions`),
 * which used to page through the full `list` (rollups + deps) at pageSize 500
 * just to get names.
 *
 * Two queries, not one: the dates it carries are the EFFECTIVE window, so it
 * pays for `projectContentDates` on top of the project scan. That cost buys
 * correct expense→project suggestions (`rankProjectSuggestions` ranks by
 * "was this project running on that date?", and a stale hand-typed window is
 * exactly what made it miss); the fold itself is pure TS over rows already in
 * hand. Still nowhere near the `list` call it replaced.
 */
export const projectNameOptions = async (
  db: Database,
): Promise<ProjectOptionsOut[]> => {
  const [rows, contentDates] = await Promise.all([
    getDb(db)
      .select({
        id: project.id,
        shortcode: project.shortcode,
        name: project.name,
        parentProjectId: project.parentProjectId,
        startDate: project.startDate,
        endDate: project.endDate,
      })
      .from(project)
      .where(notDeleted(project))
      .orderBy(asc(project.name)),
    projectContentDates(db),
  ]);

  const windows = aggregateSubtreeDates(rows, contentDates);
  return rows.map((row) => {
    const window = windows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW;
    return {
      id: unsafeProjectShortcode(row.shortcode),
      name: row.name,
      effectiveStart: window.effectiveStart,
      effectiveEnd: window.effectiveEnd,
    };
  });
};

export const projectList = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: ProjectOut[]; count: number }> => {
  // Whole-tree parent/child map — cheap single query — see subtree.ts's doc
  // comment. Fetched up front (rather than inside `loadProjectSubtreeRollups`
  // below) because it also resolves `includeSubProjects` into the WHERE
  // clause, which has to be built before this page's ids exist; it is then
  // handed back in so the tree is never queried twice.
  const tree = await loadProjectTree(db);
  const { childrenByParent } = tree;

  const parentCodes = filters.parentProjectId
    ? [filters.parentProjectId].flat()
    : [];
  const resolvedParents = await resolveShortcodes(db, parentCodes);
  const parentProjectUuids = parentCodes.flatMap((code) => {
    const resolved = resolvedParents.get(code);
    return resolved?.entity === "project" ? [unsafeProjectId(resolved.id)] : [];
  });

  // When scoped to a parent's subtree, resolve every live descendant id and
  // match on that set (excluding the parent itself — same shape as the plain
  // `parentProjectId` filter, just recursive); otherwise a direct-children match.
  let parentValues =
    parentCodes.length === 0
      ? undefined
      : parentProjectUuids.length === 0
        ? sql`false`
        : inArray(project.parentProjectId, parentProjectUuids);
  if (parentProjectUuids.length > 0 && filters.includeSubProjects) {
    parentValues = inArray(
      project.id,
      parentProjectUuids.flatMap((id) =>
        collectDescendantIds(childrenByParent, id),
      ),
    );
  }
  const parentCondition = or(
    parentValues,
    presenceCondition(
      project.parentProjectId,
      filters.parentProjectPresenceFilter,
    ),
  );

  const completionIds = filters.completionYear
    ? await loadProjectDateWindows(db, tree).then(({ dateWindows }) =>
        tree.allRows
          .filter((row) => {
            const window = dateWindows.get(row.id);
            return (
              window &&
              projectCompletionYear(row, window) === filters.completionYear
            );
          })
          .map((row) => row.id),
      )
    : null;

  const pickerSearch = filters.search
    ? or(
        formatSearchTerm(project.name, filters.search),
        formatSearchTerm(project.notes, filters.search),
        sql`EXISTS (SELECT 1 FROM unnest(${project.locations}) AS location_name WHERE location_name ILIKE ${`%${filters.search}%`})`,
      )
    : undefined;
  const whereClause = buildSearchConditions(
    project,
    [],
    [
      ...auditDateWhereConditions(project, filters),
      ...relatedWhereConditions("project", filters, project.id),
      pickerSearch,
      eqAny(project.status, filters.status),
      eqAny(project.kind, filters.kind),
      filters.location
        ? arrayOverlaps(project.locations, [filters.location].flat())
        : undefined,
      dashboardProjectDateCondition(filters),
      completionIds ? inArray(project.id, completionIds) : undefined,
      filters.topLevelOnly ? isNull(project.parentProjectId) : undefined,
      parentCondition,
    ],
  );

  // `startDate` is an override that is usually null now that the window is
  // derived, so sorting on the raw column would sink most of the table into a
  // null bucket. Sort on the effective start instead: the override when set,
  // else the project's own earliest dated task/expense.
  //
  // APPROXIMATION: non-recursive. A parent with no override and no own content
  // still sorts as null even when its children are dated — matching the true
  // recursive fold would need a recursive CTE, and at this scale (75 projects,
  // 15 of them children) it moves nothing. Everything *displayed* comes from
  // `dates.effectiveStart`, which is fully recursive; this only orders rows.
  //
  // `sql.raw` with the alias spelled out by hand, NOT a `sql` template over
  // Drizzle column refs — same pattern as `resolveProductSort`
  // (product/crud.ts) and location/crud.ts's "parent" resolver, for the same
  // reason `buildDashboardProjectWhere` had to drop correlated `EXISTS`
  // (dashboard-shared.ts). This is fed to `query.project.findMany`, whose
  // alias mapper rewrites EVERY column ref inside the clause — including ones
  // belonging to Task/Expense — to the root alias, emitting
  // `min("project"."dueDate") from "Task"` and a self-referential
  // `"project"."projectId" = "project"."id"`. That is not a subtle ordering
  // bug: the query throws, and `startDate` is this table's DEFAULT sort.
  // Exercised by project.integration.test.ts's "sorts by effective start".
  //
  // The `deletedAt IS NULL` guards below are hand-written for the same reason
  // and are load-bearing — `check-soft-delete-filters.mjs` only scans
  // `exists`/`notExists` bodies, so it cannot see them.
  //
  // The two content sources are combined with LEAST, not chained into the
  // coalesce: a project with both tasks and expenses must sort by the
  // EARLIER of the two, and `coalesce(taskMin, expenseMin)` would take the
  // task min whenever any task exists — silently ignoring an earlier expense
  // and disagreeing with the `dates.effectiveStart` the row displays.
  // (LEAST ignores NULL args and is NULL only when all of them are.)
  const effectiveStartSortSql = (direction: SortParams["direction"]) =>
    sql.raw(
      `coalesce("project"."startDate", LEAST(` +
        `(SELECT min(t."dueDate") FROM "Task" t ` +
        `WHERE t."projectId" = "project"."id" AND t."deletedAt" IS NULL), ` +
        `(SELECT min(pu."date") FROM "Expense" pu ` +
        `WHERE pu."projectId" = "project"."id" AND pu."deletedAt" IS NULL))) ` +
        `${direction === "asc" ? "asc" : "desc"} nulls last`,
    );
  const orderByArray = buildOrderBy(
    project,
    sorts,
    [...projectSortableFields],
    {
      resolve: (s) =>
        s.orderBy === "startDate" ? [effectiveStartSortSql(s.direction)] : null,
    },
  );
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.project.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    countWhere(db, project, whereClause),
  );

  const ids = rows.map((r) => r.id);

  const [projectContext, deps] = await Promise.all([
    loadProjectSubtreeRollups(db, ids, tree),
    projectDependencyIds(db, ids),
  ]);

  const data = rows.map((row) => hydrateProjectRow(row, projectContext, deps));

  return { data, count };
};
