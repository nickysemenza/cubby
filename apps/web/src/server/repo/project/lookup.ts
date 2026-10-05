import {
  type ExpenseId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { projectListItemOut } from "@cubby/schemas/project";
import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";
import type { ProjectFilters, ProjectOptionsOut } from "@cubby/schemas/project";
import { parseShortcode } from "@cubby/shared";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { projectListRows } from "~/entity/list-read-schema";
import type { Database } from "~/server/db";
import { entityAttachment, image, project } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
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
import { listScaffold } from "~/server/repo/list";
import {
  loadListGroup,
  wantsListGroup,
  type ListProjection,
} from "~/server/repo/list-projection";
import { resolveShortcodes } from "~/server/repo/shortcode-resolver";
import {
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
} from "~/server/repo/task-project-inheritance";

import { completeListReader } from "../list-read-adapters";
import { projectContentDates, projectDependencyIds } from "./analytics";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "./attention";
import { dashboardProjectDateCondition } from "./dashboard-shared";
import { withProjectExternalUrls } from "./external-links";
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
 * Lightweight `{id, name, emoji}` options for pickers/filter selects — no
 * rollup/dependency joins. Feeds the `dates` projection of
 * `getFilterOptions`'s `entity: "project"` roster (see `useEntityOptions`),
 * and the direct callers below that need the excludable window without going
 * through the wire (expense→project suggestions, AI field-suggest). It used
 * to back a dedicated `project.options` procedure that paged through the
 * full `list` (rollups + deps) at pageSize 500 just to get names.
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
        emoji: project.emoji,
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
      emoji: row.emoji,
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
  // resolves fine in SQL but misses the Map here (the trap `resolveAllPresent`
  // handles for single-entity lists).
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
    .select({ projectId: entityAttachment.entityId })
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

export const projectListRead = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const { tree, whereClause, orderByArray } = await buildProjectListQuery(
    db,
    filters,
    sorts,
  );
  // Both start beside the page read rather than after it.
  const sumsRead =
    readIntent === "page" && projection.kind === "full"
      ? projectListSums(db, whereClause)
      : undefined;
  const treeRead =
    readIntent !== "count" &&
    (wantsListGroup(projection, "relations") ||
      wantsListGroup(projection, "derived"))
      ? Promise.resolve(tree ?? loadProjectTree(db))
      : undefined;

  const [page, sums] = await Promise.all([
    projectScaffold.list(
      db,
      { filters, sorts, pagination, readIntent, projection },
      {
        where: whereClause,
        orderBy: orderByArray,
        select: (clauses) => getDb(db).query.project.findMany({ ...clauses }),
        hydrate: async (rows) => {
          if (projection.kind === "base")
            return projectListRows(
              "project",
              rows.map((row) => ({ ...row, id: row.shortcode })),
              projection,
            );
          const loadedTree = await treeRead;
          const ids = rows.map((r) => r.id);

          const [projectContext, deps, dataQualities] = await Promise.all([
            loadListGroup(projection, "derived", () =>
              loadProjectSubtreeRollups(db, ids, loadedTree),
            ),
            loadListGroup(projection, "relations", () =>
              projectDependencyIds(db, ids),
            ),
            loadListGroup(projection, "quality", () =>
              loadDataQualities(db, "project", ids),
            ),
          ]);

          const selectedRows = wantsListGroup(projection, "relations")
            ? await withProjectExternalUrls(db, rows)
            : rows;
          const context =
            projectContext ??
            (loadedTree
              ? {
                  ...loadedTree,
                  ownRollups: new Map(),
                  subtreeRollups: new Map(),
                  dateWindows: new Map(),
                }
              : undefined);
          const mapRow = (row: (typeof selectedRows)[number]) =>
            context
              ? hydrateProjectRow(
                  {
                    ...row,
                    googleDriveFolderUrl:
                      "googleDriveFolderUrl" in row
                        ? z.string().nullable().parse(row.googleDriveFolderUrl)
                        : null,
                    notionPageUrl:
                      "notionPageUrl" in row
                        ? z.string().nullable().parse(row.notionPageUrl)
                        : null,
                  },
                  context,
                  deps ?? { blockedBy: new Map(), blocking: new Map() },
                  dataQualities?.get(row.id),
                )
              : {
                  ...row,
                  id: parseShortcodeFor("project", row.shortcode),
                  dataQuality: dataQualities?.get(row.id),
                };
          const mapped = wantsListGroup(projection, "media")
            ? await withDisplayImages(db, "project", selectedRows, mapRow)
            : selectedRows.map(mapRow);
          return projectListRows("project", mapped, projection);
        },
      },
    ),
    sumsRead,
    // Awaited here too, so a failed tree read never goes unhandled while the
    // page query is still running.
    treeRead,
  ]);
  return projection.kind === "base" || readIntent === "count"
    ? page
    : { ...page, sums };
};

export const projectList = completeListReader(
  projectListItemOut,
  projectListRead,
);
export const projectListSummary = async (
  db: Database,
  filters: ProjectFilters,
) => projectListSums(db, await buildProjectWhere(db, filters));
