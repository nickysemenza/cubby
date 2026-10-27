import {
  type ExpenseId,
  parseShortcodeFor,
  type ProjectId,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";
import type {
  ProjectAttentionReport,
  ProjectFilters,
  ProjectOptionsOut,
} from "@cubby/schemas/project";
import { rawProjectListItemOut } from "@cubby/schemas/work-raw-read";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  getDb,
  isTransaction,
  type ListReadIntent,
  notDeleted,
} from "~/server/db/helpers";
import { entityAttachment, image, project } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { displayableImageWhere } from "~/server/domains/image/repo/image-displayability";
import { withProjectExternalUrls } from "~/server/domains/project/repo/external-links";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { storedDerivedSql } from "~/server/generic/derived/repo/read";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";

import {
  projectContentDates,
  projectContentDatesExcluding,
  projectDependencyIds,
} from "./analytics";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "./attention";
import { dashboardProjectDateCondition } from "./dashboard-shared";
import {
  EMPTY_PROJECT_DATE_WINDOW,
  projectSettingsFields,
  type ProjectContentDates,
} from "./helpers";
import {
  aggregateSubtreeDates,
  loadProjectTree,
  type ProjectTree,
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

/**
 * Each project-grain attention type's list filter value. Read on render, not
 * at load: task and expense lists import `projectScaffold` for their project
 * scope, and `attention.ts` reaches the task list (through task
 * actionability) before its own exports exist.
 */
const attentionFilterOf = (type: string) =>
  Object.entries(projectAttentionFilterTypes).find(
    ([, attention]) => attention === type,
  )?.[0];

/**
 * The effective start the drain stores (ADR 0021). Stop at explicit starts:
 * descendants behind an override must not influence an ancestor's folded date.
 */
export const projectStartDateSql = sql`(
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
        (SELECT min(${effectiveTaskDueDateSql("t")}) FROM "Task" t
         WHERE ${effectiveFieldSql("task", "projectId", "t")} = node."id" AND t."deletedAt" IS NULL),
        (SELECT min(e."date") FROM "Expense" e JOIN allocations a ON a."expenseId" = e."id"
         WHERE a."projectId" = node."id" AND e."deletedAt" IS NULL)
      ))) FROM date_tree node
    )`;

export const projectScaffold = listScaffold("project", project, {
  derived: {
    image: inArray(project.id, projectIdsWithImages),
    dateRange: ({ from, to }) =>
      dashboardProjectDateCondition({
        dateFrom: typeof from === "string" ? from : undefined,
        dateTo: typeof to === "string" ? to : undefined,
      }),
    // Stored (ADR 0021): the TS subtree fold no longer runs per list read.
    completionYear: storedDerivedSql("project", "completionYear", project.id),
    startDate: storedDerivedSql("project", "startDate", project.id),
  },
  rows: {
    attentionItems: projectAttention.rows(({ items }) => {
      const rows = items.flatMap((item) => {
        const filter = attentionFilterOf(item.type);
        return filter === undefined ? [] : [sql`(${item.entityId}, ${filter})`];
      });
      return rows.length === 0
        ? sql`SELECT NULL::uuid AS "owner", NULL::text AS "type" WHERE false`
        : sql`SELECT p."id" AS "owner", item."type"
          FROM (VALUES ${sql.join(rows, sql`, `)}) item("code", "type")
          JOIN "Project" p ON p."shortcode" = item."code"`;
    }),
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
  if (excludeExpenseId)
    return (
      (await projectNameOptionsExcluding(db, [excludeExpenseId])).get(
        excludeExpenseId,
      ) ?? []
    );
  const [rows, contentDates] = await Promise.all([
    projectOptionRows(db),
    projectContentDates(db),
  ]);
  return projectOptions(rows, contentDates);
};

/** `projectNameOptions` once per excluded Expense, sharing one roster read
 * and one allocation pass across the set. */
export const projectNameOptionsExcluding = async (
  db: Database,
  excludeExpenseIds: readonly ExpenseId[],
): Promise<Map<ExpenseId, ProjectOptionsOut[]>> => {
  if (excludeExpenseIds.length === 0) return new Map();
  const [rows, contentDates] = await Promise.all([
    projectOptionRows(db),
    projectContentDatesExcluding(db, excludeExpenseIds),
  ]);
  return new Map(
    excludeExpenseIds.map((id) => [
      id,
      projectOptions(rows, contentDates.get(id) ?? new Map()),
    ]),
  );
};

const projectOptionRows = (db: Database) =>
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
    // Recommendation evidence fingerprints this order; the id breaks name ties.
    .orderBy(asc(project.name), asc(project.id));

const projectOptions = (
  rows: Awaited<ReturnType<typeof projectOptionRows>>,
  contentDates: Map<ProjectId, ProjectContentDates>,
): ProjectOptionsOut[] => {
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
  attentionItems?: ProjectAttentionReport,
  preparedTree?: ProjectTree,
  readIntent: ListReadIntent = "page",
) => {
  // `getEntityCounts` calls this with `{}` inside a function whose design is
  // one round trip, so the tree and attention items load only when a filter,
  // sort or group asks; rows hydrate apart from this context.
  const context = await projectScaffold.context(
    db,
    { filters, sorts, projection: { kind: "base" }, readIntent },
    attentionItems === undefined ? [] : [[projectAttention, attentionItems]],
  );
  const loadedTree = preparedTree;
  const whereClause = projectScaffold.where(filters, { context });

  const orderByArray =
    readIntent === "count"
      ? []
      : projectScaffold.orderBy(sorts, {}, filters, context);

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
  attentionItems?: ProjectAttentionReport,
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
  prepared?: {
    tree?: ProjectTree;
    attentionItems?: ProjectAttentionReport;
  },
) => {
  const { tree, whereClause, orderByArray, context } =
    await buildProjectListQuery(
      db,
      filters,
      sorts,
      prepared?.attentionItems,
      prepared?.tree,
      readIntent,
    );
  // Both start beside the page read rather than after it.
  const sumsRead =
    readIntent === "page" && projection.kind === "full"
      ? projectListSums(db, whereClause)
      : undefined;
  const [page, sums] = await Promise.all([
    projectScaffold.read(
      db,
      { filters, sorts, pagination, readIntent, projection },
      {
        where: whereClause,
        context,
        orderBy: orderByArray,
        read: {
          media: true,
          bindings: (bind) => {
            const hierarchy = bind.batch(() =>
              Promise.resolve(tree ?? loadProjectTree(db)),
            );
            const settings = bind.batch(async (page) => {
              const loaded = await hierarchy.load(page);
              return new Map(
                page.rows.map((row) => [
                  row.id,
                  projectSettingsFields(
                    row,
                    loaded.rowsById,
                    loaded.rowsByShortcode,
                  ),
                ]),
              );
            });
            const dependencies = bind.batch(({ rows }) =>
              projectDependencyIds(
                db,
                rows.map((row) => row.id),
              ),
            );
            const urls = bind.batch(
              async ({ rows }) =>
                new Map(
                  (await withProjectExternalUrls(db, rows)).map((row) => [
                    row.id,
                    row,
                  ]),
                ),
            );
            return [
              settings.fields(
                rawProjectListItemOut.pick({ locations: true }),
                (row, loaded) => {
                  const value = loaded.get(row.id);
                  if (!value)
                    throw new Error("Project settings were not loaded");
                  return { locations: value.locations };
                },
              ),
              settings.fields(
                rawProjectListItemOut.pick({
                  assigneeId: true,
                  assigneeName: true,
                  defaultTrade: true,
                  fieldResolutions: true,
                }),
                (row, loaded) => {
                  const value = loaded.get(row.id);
                  if (!value)
                    throw new Error("Project field resolution was not loaded");
                  const { locations: _locations, ...derived } = value;
                  return derived;
                },
              ),
              hierarchy.fields(
                rawProjectListItemOut.pick({
                  parentProjectId: true,
                  parentProjectName: true,
                  childProjectIds: true,
                }),
                (row, loaded) => ({
                  parentProjectId:
                    row.parentProjectId &&
                    loaded.shortcodeById.has(row.parentProjectId)
                      ? parseShortcodeFor(
                          "project",
                          loaded.shortcodeById.get(row.parentProjectId)!,
                        )
                      : null,
                  parentProjectName: row.parentProjectId
                    ? (loaded.nameById.get(row.parentProjectId) ?? null)
                    : null,
                  childProjectIds: (
                    loaded.childrenByParent.get(row.id) ?? []
                  ).map((id) =>
                    parseShortcodeFor(
                      "project",
                      loaded.shortcodeById.get(id) ?? "",
                    ),
                  ),
                }),
              ),
              bind
                .batch(async (page) => ({
                  dependencies: await dependencies.load(page),
                  tree: await hierarchy.load(page),
                }))
                .fields(
                  rawProjectListItemOut.pick({
                    blockedByIds: true,
                    blockingIds: true,
                  }),
                  (row, loaded) => ({
                    blockedByIds: (
                      loaded.dependencies.blockedBy.get(row.id) ?? []
                    ).map((id) =>
                      parseShortcodeFor(
                        "project",
                        loaded.tree.shortcodeById.get(id) ?? "",
                      ),
                    ),
                    blockingIds: (
                      loaded.dependencies.blocking.get(row.id) ?? []
                    ).map((id) =>
                      parseShortcodeFor(
                        "project",
                        loaded.tree.shortcodeById.get(id) ?? "",
                      ),
                    ),
                  }),
                ),
              urls.fields(
                rawProjectListItemOut.pick({
                  googleDriveFolderUrl: true,
                  notionPageUrl: true,
                }),
                (row, loaded) => {
                  const value = loaded.get(row.id);
                  if (!value)
                    throw new Error("Project external links were not loaded");
                  return {
                    googleDriveFolderUrl: value.googleDriveFolderUrl,
                    notionPageUrl: value.notionPageUrl,
                  };
                },
              ),
            ];
          },
        },
      },
    ),
    sumsRead,
  ]);
  return projection.kind === "base" || readIntent === "count"
    ? page
    : { ...page, sums };
};

export const projectList = completeListReader(
  rawProjectListItemOut,
  projectListRead,
);
export const projectListSummary = async (
  db: Database,
  filters: ProjectFilters,
) => projectListSums(db, await buildProjectWhere(db, filters));
