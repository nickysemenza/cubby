import {
  type ExpenseId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ProjectFilters,
  ProjectOptionsOut,
  ProjectListItemOut,
} from "@cubby/schemas/project";
import { parseShortcode } from "@cubby/shared";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { image, project, projectImage } from "~/server/db/schema";
import {
  auditDateWhereConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  idSetPresence,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { listScaffold } from "~/server/repo/list-scaffold";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";

import { projectContentDates, projectDependencyIds } from "./analytics";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "./attention";
import { dashboardProjectDateCondition } from "./dashboard-shared";
import { EMPTY_PROJECT_DATE_WINDOW, hydrateProjectRow } from "./helpers";
import {
  aggregateSubtreeDates,
  collectDescendantIds,
  loadProjectDateWindows,
  loadProjectSubtreeRollups,
  loadProjectTree,
  type ProjectTree,
  projectCompletionYear,
} from "./subtree";

const projectScaffold = listScaffold("project", project);

/**
 * Lightweight `{id, name, icon}` options for pickers/filter selects — no
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
  excludeExpenseId?: ExpenseId,
): Promise<ProjectOptionsOut[]> => {
  const [rows, contentDates] = await Promise.all([
    getDb(db)
      .select({
        id: project.id,
        shortcode: project.shortcode,
        name: project.name,
        icon: project.icon,
        parentProjectId: project.parentProjectId,
        startDate: project.startDate,
        endDate: project.endDate,
      })
      .from(project)
      .where(notDeleted(project))
      .orderBy(asc(project.name)),
    projectContentDates(db, undefined, excludeExpenseId),
  ]);

  const windows = aggregateSubtreeDates(rows, contentDates);
  return rows.map((row) => {
    const window = windows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW;
    return {
      id: parseShortcodeFor("project", row.shortcode),
      name: row.name,
      icon: row.icon,
      effectiveStart: window.effectiveStart,
      effectiveEnd: window.effectiveEnd,
    };
  });
};

/**
 * Everything the project list does before it paginates: the whole-tree load,
 * the filters resolved into a WHERE clause, and the ORDER BY.
 *
 * Shared with the WBS tree page (`repo/project/tree.ts`), which applies the
 * SAME predicates but paginates by root of the filtered forest rather than by
 * row. Extracted rather than copied precisely because those two must never
 * disagree about membership — a tree that selected a different set than the
 * flat list would be the browser-side membership bug this endpoint exists to
 * avoid, just moved to the server.
 */
export const buildProjectListQuery = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
) => {
  // Whole-tree parent/child map — cheap single query — see subtree.ts's doc
  // comment. Loaded LAZILY and memoized: only two filters need it for the WHERE
  // clause (`includeSubProjects` below, and `completionYear`'s date windows),
  // and `getEntityCounts` calls this with `{}` inside a function whose entire
  // design is one round trip. Eagerly loading here made that a second query
  // before a single filter had been inspected.
  //
  // Whoever forces it keeps the result, and it is handed back so the tree is
  // never queried twice. `loadProjectSubtreeRollups` already declares its
  // `tree` argument optional and re-fetches when absent (subtree.ts:385), so
  // the `undefined` this can now return needs no call-site change — and a
  // `readIntent: "count"` list, which returns before rollups, stops loading the
  // tree at all.
  let loadedTree: ProjectTree | undefined;
  let treePromise: Promise<ProjectTree> | undefined;
  const getTree = async () => {
    treePromise ??= loadProjectTree(db);
    loadedTree = await treePromise;
    return loadedTree;
  };

  // Delegate exact tracker membership to the same deep module used by the
  // dashboard and Problems. This avoids a second copy of the stalled, budget,
  // and blocked-next-action predicates in the ordinary entity list.
  const attentionFilter = filters.attention;
  const attentionCodes = attentionFilter
    ? (await computeAttentionItems(db))
        .filter(
          (item) => item.type === projectAttentionFilterTypes[attentionFilter],
        )
        .map((item) => item.entityId)
    : undefined;

  const parentCodes = filters.parentProjectId
    ? [filters.parentProjectId].flat()
    : [];
  const resolvedParents = await resolveShortcodes(db, parentCodes);
  // `resolveShortcodes` keys its result Map by the CANONICAL code (see its
  // docstring), so the lookup goes through `parseShortcode(code).shortcode`
  // rather than the raw input — otherwise a lowercase or legacy-prefix code
  // resolves fine in SQL but misses the Map here, same trap as
  // `expense/lookup.ts`'s and `task/lookup.ts`'s `toUuids`.
  const parentProjectUuids = parentCodes.flatMap((code) => {
    const parsed = parseShortcode(code);
    const resolved = parsed ? resolvedParents.get(parsed.shortcode) : undefined;
    return resolved?.entity === "project"
      ? [parseEntityId("project", resolved.id)]
      : [];
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
    const { childrenByParent } = await getTree();
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

  const completionTree = filters.completionYear ? await getTree() : undefined;
  const completionIds = completionTree
    ? await loadProjectDateWindows(db, completionTree).then(({ dateWindows }) =>
        completionTree.allRows
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

  // Joins Image so this matches what the thumbnail cell actually renders —
  // `getImagesByProjectIds` (which feeds the column) applies the same
  // `displayableImageWhere` gate, and Image is separately soft-deletable from
  // ProjectImage.
  const projectIdsWithImages = getDb(db)
    .select({ projectId: projectImage.projectId })
    .from(projectImage)
    .innerJoin(
      image,
      and(eq(image.id, projectImage.imageId), notDeleted(image)),
    )
    .where(and(notDeleted(projectImage), displayableImageWhere));

  // `search` (name ∪ notes ∪ locations), `status`, `kind` and `location` (an
  // overlap over the `locations` array) are declared stored filters — applied
  // by `projectScaffold.where` before the conditions below.
  const whereClause = projectScaffold.where(filters, [
    ...auditDateWhereConditions(project, filters),
    ...relatedWhereConditions("project", filters, project.id),
    dashboardProjectDateCondition(filters),
    attentionCodes
      ? attentionCodes.length
        ? inArray(project.shortcode, attentionCodes)
        : sql`false`
      : undefined,
    completionIds ? inArray(project.id, completionIds) : undefined,
    filters.topLevelOnly ? isNull(project.parentProjectId) : undefined,
    parentCondition,
    idSetPresence(
      project.id,
      filters.imagePresenceFilter,
      projectIdsWithImages,
    ),
  ]);

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
  // and are load-bearing — the `cubby/require-soft-delete-filter` oxlint rule
  // only scans `exists`/`notExists` bodies, so it cannot see them.
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
  const orderByArray = projectScaffold.orderBy(
    sorts,
    {
      resolve: (s) =>
        s.orderBy === "startDate" ? [effectiveStartSortSql(s.direction)] : null,
    },
    filters,
  );

  return { tree: loadedTree, whereClause, orderByArray };
};

/**
 * The complete WHERE for a project list. `getEntityCounts` calls it with `{}` —
 * see repo/dashboard.ts. Thin wrapper so the registry's entries all look alike
 * and the dashboard never has to discard an `orderByArray` it did not ask for;
 * with no filters set, the lazy tree above means this issues no query.
 */
export const buildProjectWhere = async (
  db: Database,
  filters: ProjectFilters,
) => (await buildProjectListQuery(db, filters, [])).whereClause;

/**
 * Footer total for the `costEstimate` column: `SUM` over the FULL filtered
 * set, not the loaded page — see `createCurrencyColumn`'s footer and
 * `vendor.ts`'s `vendorList` for the pattern this follows. The displayed
 * column reads each row's own `costEstimate` (not the subtree rollup — see
 * `helpers.ts`'s `dbProjectToAPI`), so the matching total is a flat SUM over
 * `whereClause`, no tree-fold needed.
 *
 * Shared by `projectList` and `projectTreePage`: both apply the identical
 * `whereClause` (`buildProjectListQuery`), and the tree page's matching SET is
 * the same filtered forest as the flat list — it only paginates by root. So
 * "the total" means the same thing in both renderers: the sum over every
 * matching project, not just roots. A roots-only sum would under-report
 * whenever a filtered-in project has a costEstimate but its parent (also
 * shown, also summed in flat mode) does too, and would disagree with what
 * fully expanding the tree already sums row-by-row.
 */
export const projectListSums = async (
  db: Database,
  whereClause: SQL | undefined,
): Promise<{ costEstimate: number }> => {
  const [row] = await getDb(db)
    .select({
      costEstimate: sql<number>`COALESCE(sum(${project.costEstimate}), 0)::double precision`,
    })
    .from(project)
    .where(whereClause);
  return { costEstimate: Number(row?.costEstimate ?? 0) };
};

export const projectList = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
): Promise<{
  data: ProjectListItemOut[];
  count: number;
  sums: { costEstimate: number };
}> => {
  const { tree, whereClause, orderByArray } = await buildProjectListQuery(
    db,
    filters,
    sorts,
  );
  if (readIntent === "count") {
    return {
      data: [],
      count: await countWhere(db, project, whereClause),
      // Count-only consumers deliberately do not request table footers.
      sums: { costEstimate: 0 },
    };
  }
  const { take, skip } = projectScaffold.page(pagination);

  const [{ data: rows, count }, sums] = await Promise.all([
    executeListQueryWithCount({
      kind: readIntent,
      rows: () =>
        getDb(db).query.project.findMany({
          where: whereClause,
          orderBy: orderByArray,
          limit: take,
          offset: skip,
        }),
      count: () => countWhere(db, project, whereClause),
    }),
    readIntent === "sample"
      ? Promise.resolve({ costEstimate: 0 })
      : projectListSums(db, whereClause),
  ]);

  const ids = rows.map((r) => r.id);

  const [projectContext, deps] = await Promise.all([
    loadProjectSubtreeRollups(db, ids, tree),
    projectDependencyIds(db, ids),
  ]);

  const data = await withDisplayImages(db, "project", rows, (row) =>
    hydrateProjectRow(row, projectContext, deps),
  );

  return { data, count, sums };
};
