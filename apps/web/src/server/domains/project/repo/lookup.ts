import {
  type ExpenseId,
  parseShortcodeFor,
  type ProjectId,
} from "@cubby/schemas/identifiers";
import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";
import type { ProjectOptionsOut } from "@cubby/schemas/project";
import { rawProjectListItemOut } from "@cubby/schemas/work-raw-read";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  getDb,
  databaseForTransaction,
  isTransaction,
  notDeleted,
} from "~/server/db/helpers";
import { entityAttachment, image, project } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { displayableImageWhere } from "~/server/domains/image/repo/image-displayability";
import { withProjectExternalUrls } from "~/server/domains/project/repo/external-links";
import { projectSearch } from "~/server/domains/project/repo/search-read-project";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { storedDerivedSql } from "~/server/generic/derived/repo/read";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";

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
import { aggregateSubtreeDates, loadProjectTree } from "./subtree";

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

// The tree, rollup and attention reads take a Database; a record read inside
// a write sees the transaction's rows.
const projectReadDatabase = (db: Database | DrizzleTransaction): Database =>
  isTransaction(db) ? databaseForTransaction(db) : db;

// Exact tracker membership comes from the deep module the dashboard and
// Problems share, so the list keeps no second copy of the stalled, budget,
// and blocked-next-action predicates. A caller that already computed the
// items seeds this prepare (`buildProjectListQuery`).
export const projectAttention = listPrepare((db) =>
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
  read: {
    search: projectSearch,
    media: true,
    bindings: (bind) => {
      const hierarchy = bind.batch(({ db }) =>
        loadProjectTree(projectReadDatabase(db)),
      );
      const settings = bind.batch(async (page) => {
        const loaded = await hierarchy.load(page);
        return new Map(
          page.rows.map((row) => [
            row.id,
            projectSettingsFields(row, loaded.rowsById, loaded.rowsByShortcode),
          ]),
        );
      });
      const dependencies = bind.batch(({ db, rows }) =>
        projectDependencyIds(
          projectReadDatabase(db),
          rows.map((row) => row.id),
        ),
      );
      const urls = bind.batch(
        async ({ db, rows }) =>
          new Map(
            (await withProjectExternalUrls(projectReadDatabase(db), rows)).map(
              (row) => [row.id, row],
            ),
          ),
      );
      return [
        settings.fields(
          rawProjectListItemOut.pick({ locations: true }),
          (row, loaded) => {
            const value = loaded.get(row.id);
            if (!value) throw new Error("Project settings were not loaded");
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
            childProjectIds: (loaded.childrenByParent.get(row.id) ?? []).map(
              (id) =>
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
              blockingIds: (loaded.dependencies.blocking.get(row.id) ?? []).map(
                (id) =>
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
