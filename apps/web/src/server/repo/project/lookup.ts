import {
  type ExpenseId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";
import type {
  ProjectFilters,
  ProjectOptionsOut,
  ProjectListItemOut,
} from "@cubby/schemas/project";
import { parseShortcode } from "@cubby/shared";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityAttachment, image, project } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  countWhere,
  executeListQueryWithCount,
  getDb,
  formatSearchTerm,
  textArrayMatches,
  idSetPresence,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { expenseProjectAllocationSql } from "~/server/repo/expense-project-allocation";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { listScaffold } from "~/server/repo/list-scaffold";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";
import {
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
} from "~/server/repo/task-project-inheritance";

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
    .select({ projectId: entityAttachment.subjectEntityId })
    .from(entityAttachment)
    .innerJoin(
      image,
      and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
    )
    .where(and(notDeleted(entityAttachment), displayableImageWhere));

  // `search` (name ∪ notes ∪ locations), `status`, `kind` and `location` (an
  // overlap over the `locations` array) are declared stored filters — applied
  // by `projectScaffold.where` before the conditions below.
  const whereClause = projectScaffold.where({ ...filters, search: undefined }, [
    or(
      formatSearchTerm(project.name, filters.search),
      formatSearchTerm(project.notes, filters.search),
      textArrayMatches(
        effectiveProjectLocationsSql(sql`${project.id}`),
        filters.search,
      ),
    ),
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
    filters.location && [filters.location].flat().length > 0
      ? sql`${effectiveProjectLocationsSql(sql`${project.id}`)} && ARRAY[${sql.join(
          [filters.location].flat().map((location) => sql`${location}`),
          sql`, `,
        )}]::text[]`
      : undefined,
    idSetPresence(
      project.id,
      filters.imagePresenceFilter,
      projectIdsWithImages,
    ),
  ]);

  // Stop at explicit starts: descendants behind an override must not influence
  // an ancestor's folded date. Raw aliases avoid Drizzle's root-alias rewrite.
  const effectiveStartSortSql = (direction: SortParams["direction"]) =>
    sql`(
      WITH RECURSIVE date_tree AS (
        SELECT p."id", p."startDate", 0 AS depth
        FROM "Project" p WHERE p."id" = "project"."id" AND p."deletedAt" IS NULL
        UNION ALL
        SELECT child."id", child."startDate", parent.depth + 1
        FROM "Project" child JOIN date_tree parent ON child."parentProjectId" = parent."id"
        WHERE child."deletedAt" IS NULL AND parent."startDate" IS NULL
          AND parent.depth < ${MAX_PROJECT_TREE_DEPTH}
      ), allocations AS (${expenseProjectAllocationSql()})
      SELECT min(coalesce(node."startDate", LEAST(
        (SELECT min(coalesce(t."dueEndDate", t."dueDate")) FROM "Task" t
         WHERE ${effectiveTaskProjectSql("t")} = node."id" AND t."deletedAt" IS NULL),
        (SELECT min(e."date") FROM "Expense" e JOIN allocations a ON a."expenseId" = e."id"
         WHERE a."projectId" = node."id" AND e."deletedAt" IS NULL)
      ))) FROM date_tree node
    ) ${sql.raw(direction === "asc" ? "asc" : "desc")} nulls last`;
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

  const [projectContext, deps, dataQualities] = await Promise.all([
    loadProjectSubtreeRollups(db, ids, tree),
    projectDependencyIds(db, ids),
    loadDataQualities(db, "project", ids),
  ]);

  const data = await withDisplayImages(db, "project", rows, (row) =>
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    hydrateProjectRow(row, projectContext, deps, dataQualities.get(row.id)!),
  );

  return { data, count, sums };
};
