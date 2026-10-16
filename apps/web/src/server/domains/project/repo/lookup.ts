import { type ExpenseId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { projectListItemOut } from "@cubby/schemas/project";
import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";
import type {
  ProjectAttentionItem,
  ProjectFilters,
  ProjectOptionsOut,
} from "@cubby/schemas/project";
import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import { projectListRows } from "~/entity/model/list-read-schema";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  formatSearchTerm,
  isTransaction,
  textArrayMatches,
  type ListReadIntent,
  notDeleted,
  shortcodeSetCondition,
} from "~/server/db/helpers";
import { entityAttachment, image, project } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { displayableImageWhere } from "~/server/domains/image/repo/image-displayability";
import { withProjectExternalUrls } from "~/server/domains/project/repo/external-links";
import {
  effectiveProjectAssigneeSql,
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
} from "~/server/domains/task/repo/task-project-inheritance";
import { withDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  listPrepare,
  shortcodeIdsSql,
} from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  loadListGroup,
  wantsListGroup,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";

import { projectContentDates, projectDependencyIds } from "./analytics";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "./attention";
import { dashboardProjectDateCondition } from "./dashboard-shared";
import { EMPTY_PROJECT_DATE_WINDOW, hydrateProjectRow } from "./helpers";
import {
  aggregateSubtreeDates,
  loadProjectDateWindows,
  loadProjectSubtreeRollups,
  loadProjectTree,
  type ProjectTree,
  projectCompletionYear,
} from "./subtree";

const qb = new QueryBuilder();

// Joins Image so presence matches what the thumbnail cell renders: the same
// `displayableImageWhere` gate, with Image separately soft-deletable.
const projectIdsWithImages = qb
  .select({ projectId: entityAttachment.entityId })
  .from(entityAttachment)
  .innerJoin(
    image,
    and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
  )
  .where(and(notDeleted(entityAttachment), displayableImageWhere));

const effectiveAssigneeSql = effectiveProjectAssigneeSql(
  sql.raw('"Project"."id"'),
);
const effectiveLocationsSql = effectiveProjectLocationsSql(sql`${project.id}`);

// The tree and attention reads take the request's Database handle; a project
// list never reads inside a write transaction.
const projectReadDatabase = (db: Database | DrizzleTransaction): Database => {
  if (isTransaction(db))
    throw new Error(
      "A project list cannot prepare its filters in a transaction.",
    );
  return db;
};

// Exact tracker membership comes from the deep module the dashboard and
// Problems share, so the list keeps no second copy of the stalled, budget,
// and blocked-next-action predicates. A caller that already computed the
// items seeds this prepare (`buildProjectListQuery`).
const projectAttention = listPrepare((db) =>
  computeAttentionItems(projectReadDatabase(db)),
);

// Completion years fold each subtree's effective dates in TS; the tree it
// loads is handed back so the list's rollups never query it twice.
const projectCompletion = listPrepare(async (db) => {
  const tree = await loadProjectTree(projectReadDatabase(db));
  const { dateWindows } = await loadProjectDateWindows(
    projectReadDatabase(db),
    tree,
  );
  return { tree, dateWindows };
});

const projectScaffold = listScaffold("project", project, {
  derived: {
    image: inArray(project.id, projectIdsWithImages),
    search: (term) =>
      or(
        formatSearchTerm(project.name, term),
        formatSearchTerm(project.notes, term),
        textArrayMatches(effectiveLocationsSql, term),
      ),
    effectiveLocations: ({ values }) =>
      values.length === 0
        ? undefined
        : sql`${effectiveLocationsSql} && ARRAY[${sql.join(
            values.map((location) => sql`${location}`),
            sql`, `,
          )}]::text[]`,
    effectiveAssignee: ({ values, presence }) =>
      or(
        values.length === 0
          ? undefined
          : sql`${effectiveAssigneeSql} IN ${shortcodeIdsSql(
              "ledgerParty",
              (shortcode) => shortcodeSetCondition(shortcode, values),
            )}`,
        presence === undefined
          ? undefined
          : presence === "has"
            ? sql`${effectiveAssigneeSql} IS NOT NULL`
            : sql`${effectiveAssigneeSql} IS NULL`,
      ),
    attention: projectAttention.predicate((items, { values }) => {
      const types = new Set<string>(
        Object.entries(projectAttentionFilterTypes)
          .filter(([filter]) => values.includes(filter))
          .map(([, type]) => type),
      );
      const codes = items
        .filter((item) => types.has(item.type))
        .map((item) => item.entityId);
      return codes.length ? inArray(project.shortcode, codes) : sql`false`;
    }),
    dateRange: ({ from, to }) =>
      dashboardProjectDateCondition({
        dateFrom: typeof from === "string" ? from : undefined,
        dateTo: typeof to === "string" ? to : undefined,
      }),
    completionYear: projectCompletion.predicate(
      ({ tree, dateWindows }, { values }) => {
        const ids = tree.allRows
          .filter((row) => {
            const window = dateWindows.get(row.id);
            return (
              window !== undefined &&
              values.includes(projectCompletionYear(row, window))
            );
          })
          .map((row) => row.id);
        return ids.length ? inArray(project.id, ids) : sql`false`;
      },
    ),
    assigneeId: sql`(SELECT member."name" FROM "LedgerParty" member WHERE member."id" = ${effectiveProjectAssigneeSql(
      sql.raw('"Project"."id"'),
    )} AND member."deletedAt" IS NULL)`,
    // Stop at explicit starts: descendants behind an override must not
    // influence an ancestor's folded date.
    startDate: sql`(
      WITH RECURSIVE date_tree AS (
        SELECT p."id", p."startDate", 0 AS depth
        FROM "Project" p WHERE p."id" = "Project"."id" AND p."deletedAt" IS NULL
        UNION ALL
        SELECT child."id", child."startDate", parent.depth + 1
        FROM "Project" child JOIN date_tree parent ON child."parentProjectId" = parent."id"
        WHERE child."deletedAt" IS NULL AND parent."startDate" IS NULL
          AND parent.depth < ${MAX_PROJECT_TREE_DEPTH}
      ), allocations AS (${expenseDerivedReadSql("projects")})
      SELECT min(coalesce(node."startDate", LEAST(
        (SELECT min(coalesce(t."dueEndDate", t."dueDate")) FROM "Task" t
         WHERE ${effectiveTaskProjectSql("t")} = node."id" AND t."deletedAt" IS NULL),
        (SELECT min(e."date") FROM "Expense" e JOIN allocations a ON a."expenseId" = e."id"
         WHERE a."projectId" = node."id" AND e."deletedAt" IS NULL)
      ))) FROM date_tree node
    )`,
  },
});

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
  attentionItems?: readonly ProjectAttentionItem[],
  preparedTree?: ProjectTree,
) => {
  // Filter-only: `getEntityCounts` calls this with `{}` inside a function
  // whose design is one round trip, so the tree and attention items load
  // only when their filter asks.
  const context = await projectScaffold.context(
    db,
    { filters, readIntent: "count" },
    attentionItems === undefined ? [] : [[projectAttention, attentionItems]],
  );
  const loadedTree = context.has(projectCompletion)
    ? context.get(projectCompletion).tree
    : preparedTree;
  const whereClause = projectScaffold.where(filters, [], { context });

  const orderByArray = projectScaffold.orderBy(sorts, {}, filters);

  return { tree: loadedTree, whereClause, orderByArray, context };
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
  attentionItems?: readonly ProjectAttentionItem[],
) => (await buildProjectListQuery(db, filters, [], attentionItems)).whereClause;

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
  preparedTree?: ProjectTree,
) => {
  const { tree, whereClause, orderByArray, context } =
    await buildProjectListQuery(db, filters, sorts, undefined, preparedTree);
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
        context,
        orderBy: orderByArray,
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
