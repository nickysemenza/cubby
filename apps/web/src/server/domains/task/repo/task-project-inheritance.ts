import type {
  FieldResolution,
  FieldResolutions,
} from "@cubby/schemas/field-resolution";
import type {
  LedgerPartyId,
  ProductId,
  ProjectId,
  TaskId,
} from "@cubby/schemas/identifiers";
import type { TaskCreateInput } from "@cubby/schemas/project";
import { tradeSchema, type Trade } from "@cubby/schemas/task-fields";
/**
 * Task inheritance provenance and trade. Effective project, subject product
 * and assignee values compile from their `resolution.inherit`
 * (`effectiveFieldSql`); this module adds the `fieldResolutions` provenance
 * (source, parent decision, fallback) and the task trade chain.
 *
 * These expressions deliberately use scalar correlated subqueries rather than
 * joins. Callers can use them from a Task, Expense, or report query without
 * accidentally changing row cardinality.
 */
import { type SQL, and, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, product, project, task } from "~/server/db/schema";
import {
  effectiveFieldSql,
  inheritedFieldSql,
  inheritedSourceEntity,
  inheritedSourceSql,
} from "~/server/generic/list/repo/inheritance";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";


const taskColumn = (alias: string, column: string) =>
  sql.raw(`"${alias}"."${column}"`);

/** The nearest live project default trade, starting at `projectId`. */
export const effectiveProjectTradeSql = (
  projectId: SQL,
): SQL<Trade | null> => sql`
  (
    WITH RECURSIVE project_ancestors AS (
      SELECT p."id", p."parentProjectId", p."defaultTrade", 0 AS depth
      FROM "Project" p
      WHERE p."id" = ${projectId} AND p."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentProjectId", parent."defaultTrade",
        project_ancestors.depth + 1
      FROM "Project" parent
      JOIN project_ancestors ON parent."id" = project_ancestors."parentProjectId"
      WHERE parent."deletedAt" IS NULL AND project_ancestors.depth < 100
    )
    SELECT "defaultTrade"
    FROM project_ancestors
    WHERE "defaultTrade" IS NOT NULL
    ORDER BY depth
    LIMIT 1
  )
`;

// Effective values and their sources compile from each field's
// `resolution.inherit`; trade below is a different rule (see #2605).
const effectiveTaskProjectSql = (alias: string) =>
  effectiveFieldSql<ProjectId | null>("task", "projectId", alias);
/**
 * Task trade can come from its own explicit choice, a parent task only when
 * both effective projects match, then the effective project's default trade.
 */
export const eligibleParentTaskTradeSql = (alias = "Task"): SQL<Trade | null> =>
  sql`(SELECT parent."trade" FROM "Task" parent
    WHERE parent."id" = ${taskColumn(alias, "parentTaskId")}
      AND parent."deletedAt" IS NULL AND parent."trade" IS NOT NULL
      AND ${effectiveTaskProjectSql("parent")} IS NOT DISTINCT FROM ${effectiveTaskProjectSql(alias)})`;

export const effectiveTaskTradeSql = (alias = "Task"): SQL<Trade | null> =>
  sql`coalesce(${taskColumn(alias, "trade")}, ${eligibleParentTaskTradeSql(alias)},
    ${effectiveProjectTradeSql(effectiveTaskProjectSql(alias))})`;

/**
 * Select-list additions for readers that hydrate Task rows outside the normal
 * repository. Keep the names stable: calendar, search, and embeddings can
 * carry these values through their own projections without reimplementing the
 * inheritance expression.
 */
const taskInheritanceReadExtras = (alias = "Task") => ({
  effectiveProjectId: effectiveTaskProjectSql(alias),
  effectiveSubjectProductId: effectiveFieldSql<ProductId | null>(
    "task",
    "subjectProductId",
    alias,
  ),
  effectiveTrade: effectiveTaskTradeSql(alias),
  effectiveAssigneeId: effectiveFieldSql<LedgerPartyId | null>(
    "task",
    "assigneeId",
    alias,
  ),
});

type AssignmentMode = "inherit" | "explicit";
type TaskAssignment = {
  assigneeId: LedgerPartyId | null;
  assigneeMode: AssignmentMode;
  projectId: ProjectId | null;
  projectMode: AssignmentMode;
  subjectProductId: ProductId | null;
  subjectProductMode: AssignmentMode;
  parentTaskId: TaskId | null;
  trade: Trade | null;
};

const taskResolutionExtras = (alias: string) => {
  const parentId = taskColumn(alias, "parentTaskId");
  const parentTrade = eligibleParentTaskTradeSql(alias);
  return {
    ...taskInheritanceReadExtras(alias),
    fallbackAssigneeId: inheritedFieldSql<LedgerPartyId | null>(
      "task",
      "assigneeId",
      alias,
    ),
    assigneeSource: inheritedSourceSql("task", "assigneeId", alias),
    projectSource: inheritedSourceSql("task", "projectId", alias),
    subjectProductSource: inheritedSourceSql("task", "subjectProductId", alias),
    fallbackProjectId: inheritedFieldSql<ProjectId | null>(
      "task",
      "projectId",
      alias,
    ),
    fallbackSubjectProductId: inheritedFieldSql<ProductId | null>(
      "task",
      "subjectProductId",
      alias,
    ),
    fallbackTrade: sql<Trade | null>`coalesce(${parentTrade}, ${effectiveProjectTradeSql(effectiveTaskProjectSql(alias))})`,
    parentTrade,
    parentShortcode: sql<
      string | null
    >`(SELECT parent."shortcode" FROM "Task" parent
      WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL)`,
    parentName: sql<string | null>`(SELECT parent."name" FROM "Task" parent
      WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL)`,
  };
};
type InheritedSource = { source: number; id: string } | null;
type ResolvedAssignment = {
  effectiveAssigneeId: LedgerPartyId | null;
  fallbackAssigneeId: LedgerPartyId | null;
  assigneeSource: InheritedSource;
  projectSource: InheritedSource;
  subjectProductSource: InheritedSource;
  effectiveProjectId: ProjectId | null;
  effectiveSubjectProductId: ProductId | null;
  effectiveTrade: Trade | null;
  fallbackProjectId: ProjectId | null;
  fallbackSubjectProductId: ProductId | null;
  fallbackTrade: Trade | null;
  parentTrade: Trade | null;
  parentShortcode: string | null;
  parentName: string | null;
};

const sourceColumn = (
  row: ResolvedAssignment,
  field: "assigneeId" | "projectId" | "subjectProductId",
): InheritedSource =>
  field === "assigneeId"
    ? row.assigneeSource
    : field === "projectId"
      ? row.projectSource
      : row.subjectProductSource;

/** The record a declared source decided at, when that source names `entity`. */
const sourceOf = (
  source: InheritedSource,
  field: "assigneeId" | "projectId" | "subjectProductId",
  entity: "task" | "project",
): string | null =>
  source !== null &&
  inheritedSourceEntity("task", field, source.source) === entity
    ? source.id
    : null;

async function assignmentReferences(
  db: Database,
  rows: readonly TaskAssignment[],
  extras: readonly ResolvedAssignment[],
) {
  const projectIds = [
    ...new Set([
      ...rows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
      ...extras.flatMap((row) =>
        [
          row.effectiveProjectId,
          row.fallbackProjectId,
          sourceOf(row.assigneeSource, "assigneeId", "project"),
        ].filter((id): id is ProjectId => id !== null),
      ),
    ]),
  ];
  const productIds = [
    ...new Set([
      ...rows.flatMap((row) =>
        row.subjectProductId ? [row.subjectProductId] : [],
      ),
      ...extras.flatMap((row) =>
        [row.effectiveSubjectProductId, row.fallbackSubjectProductId].filter(
          (id): id is ProductId => id !== null,
        ),
      ),
    ]),
  ];
  const assigneeIds = [
    ...new Set([
      ...rows.flatMap((row) => (row.assigneeId ? [row.assigneeId] : [])),
      ...extras.flatMap((row) =>
        [row.effectiveAssigneeId, row.fallbackAssigneeId].filter(
          (id): id is LedgerPartyId => id !== null,
        ),
      ),
    ]),
  ];
  const taskIds = [
    ...new Set(
      extras.flatMap((row) =>
        (["assigneeId", "projectId", "subjectProductId"] as const).flatMap(
          (field) => {
            const id = sourceOf(
              sourceColumn(row, field),
              field,
              "task",
            );
            return id === null ? [] : [id as TaskId];
          },
        ),
      ),
    ),
  ];
  const [projects, products, assignees, tasks] = await Promise.all([
    projectIds.length
      ? getDb(db).query.project.findMany({
          where: and(inArray(project.id, projectIds), notDeleted(project)),
          columns: { id: true, shortcode: true, name: true, deletedAt: true },
        })
      : [],
    productIds.length
      ? getDb(db).query.product.findMany({
          where: and(inArray(product.id, productIds), notDeleted(product)),
          columns: { id: true, shortcode: true, name: true, deletedAt: true },
        })
      : [],
    assigneeIds.length
      ? getDb(db).query.ledgerParty.findMany({
          where: and(
            inArray(ledgerParty.id, assigneeIds),
            notDeleted(ledgerParty),
          ),
          columns: { id: true, shortcode: true, name: true, deletedAt: true },
        })
      : [],
    taskIds.length
      ? getDb(db).query.task.findMany({
          where: and(inArray(task.id, taskIds), notDeleted(task)),
          columns: { id: true, shortcode: true, name: true },
        })
      : [],
  ]);
  return {
    tasks: new Map(tasks.map((row) => [row.id, row])),
    assignees: new Map(assignees.map((row) => [row.id, row])),
    projects: new Map(projects.map((row) => [row.id, row])),
    products: new Map(products.map((row) => [row.id, row])),
  };
}

function referenceResolution(
  explicit: boolean,
  stored: string | null,
  value: string | null,
  fallback: string | null,
  source: Readonly<{ label: string; entity: FieldResolution["sourceEntity"] }>,
): FieldResolution {
  return {
    mode: explicit ? (stored === null ? "none" : "explicit") : "inherit",
    storedValue: stored,
    value,
    fallbackValue: fallback,
    source: explicit ? "Task override" : source.label,
    sourceEntity: explicit ? null : source.entity,
    matchesFallback: explicit && stored !== null && stored === fallback,
    canReset: explicit,
  };
}

function tradeResolution(
  row: TaskAssignment,
  extra: ResolvedAssignment,
  parent: FieldResolution["sourceEntity"],
  projectCode: string | null,
  projectName: string | null,
): FieldResolution {
  return {
    mode: row.trade === null ? "inherit" : "explicit",
    storedValue: row.trade,
    value: extra.effectiveTrade,
    fallbackValue: extra.fallbackTrade,
    source:
      row.trade !== null
        ? "Task override"
        : extra.parentTrade
          ? "Parent task"
          : extra.fallbackTrade
            ? "Project default"
            : "No trade source",
    sourceEntity:
      row.trade !== null
        ? null
        : extra.parentTrade
          ? parent
          : projectCode
            ? {
                entityKind: "project",
                entityId: projectCode,
                name: projectName,
              }
            : null,
    matchesFallback: row.trade !== null && row.trade === extra.fallbackTrade,
    canReset: row.trade !== null && extra.fallbackTrade !== null,
  };
}

function assignmentResolutions(
  row: TaskAssignment,
  extra: ResolvedAssignment,
  refs: Awaited<ReturnType<typeof assignmentReferences>>,
): FieldResolutions {
  const projectCode = (id: ProjectId | null) =>
    id ? (refs.projects.get(id)?.shortcode ?? null) : null;
  const productCode = (id: ProductId | null) =>
    id ? (refs.products.get(id)?.shortcode ?? null) : null;
  const parent = extra.parentShortcode
    ? {
        entityKind: "task" as const,
        entityId: extra.parentShortcode,
        name: extra.parentName,
      }
    : null;
  const assigneeCode = (id: LedgerPartyId | null) =>
    id ? (refs.assignees.get(id)?.shortcode ?? null) : null;
  // The declared source that decided: an ancestor task (`hierarchy`) or,
  // for the assignee, the effective project's default.
  const sourceOfField = (
    field: "assigneeId" | "projectId" | "subjectProductId",
    source: InheritedSource,
  ): { label: string; entity: FieldResolution["sourceEntity"] } => {
    const ancestor = sourceOf(source, field, "task");
    const fromTask = ancestor === null ? undefined : refs.tasks.get(ancestor as TaskId);
    if (fromTask)
      return {
        label: ancestor === row.parentTaskId ? "Parent task" : "Ancestor task",
        entity: {
          entityKind: "task",
          entityId: fromTask.shortcode,
          name: fromTask.name,
        },
      };
    const projectId = sourceOf(source, field, "project") as ProjectId | null;
    const fromProject = projectId === null ? undefined : refs.projects.get(projectId);
    if (fromProject)
      return {
        label: "Project default",
        entity: {
          entityKind: "project",
          entityId: fromProject.shortcode,
          name: fromProject.name,
        },
      };
    return { label: "Unassigned", entity: null };
  };
  return {
    assigneeId: referenceResolution(
      row.assigneeMode === "explicit",
      assigneeCode(row.assigneeId),
      assigneeCode(extra.effectiveAssigneeId),
      assigneeCode(extra.fallbackAssigneeId),
      sourceOfField("assigneeId", extra.assigneeSource),
    ),
    projectId: referenceResolution(
      row.projectMode === "explicit" || row.projectId !== null,
      projectCode(row.projectId),
      projectCode(extra.effectiveProjectId),
      projectCode(extra.fallbackProjectId),
      sourceOfField("projectId", extra.projectSource),
    ),
    subjectProductId: referenceResolution(
      row.subjectProductMode === "explicit" || row.subjectProductId !== null,
      productCode(row.subjectProductId),
      productCode(extra.effectiveSubjectProductId),
      productCode(extra.fallbackSubjectProductId),
      sourceOfField("subjectProductId", extra.subjectProductSource),
    ),
    trade: tradeResolution(
      row,
      extra,
      parent,
      projectCode(extra.effectiveProjectId),
      extra.effectiveProjectId
        ? (refs.projects.get(extra.effectiveProjectId)?.name ?? null)
        : null,
    ),
  };
}

/** Batch effective values and provenance; references always use public shortcodes. */
export async function hydrateTaskInheritanceRows<
  T extends TaskAssignment & { id: TaskId },
>(db: Database, rows: readonly T[]) {
  if (!rows.length) return [];
  // Standalone tasks without a project have no inheritance source to query.
  // Avoid planning recursive project resolution for large unassigned lists.
  const sourcedRows = rows.filter((row) => row.parentTaskId || row.projectId);
  const extras = sourcedRows.length
    ? await getDb(db)
        .select({ id: task.id, ...taskResolutionExtras("Task") })
        .from(task)
        .where(
          and(
            inArray(
              task.id,
              sourcedRows.map((row) => row.id),
            ),
            notDeleted(task),
          ),
        )
    : [];
  for (const row of rows) {
    if (row.parentTaskId || row.projectId) continue;
    extras.push({
      id: row.id,
      effectiveAssigneeId:
        row.assigneeMode === "explicit" ? row.assigneeId : null,
      fallbackAssigneeId: null,
      assigneeSource: null,
      projectSource: null,
      subjectProductSource: null,
      effectiveProjectId: null,
      effectiveSubjectProductId: row.subjectProductId,
      effectiveTrade: row.trade,
      fallbackProjectId: null,
      fallbackSubjectProductId: null,
      fallbackTrade: null,
      parentTrade: null,
      parentShortcode: null,
      parentName: null,
    });
  }
  const byId = new Map(extras.map((row) => [row.id, row]));
  const refs = await assignmentReferences(db, rows, extras);
  return rows.map((row) => {
    const extra = byId.get(row.id);
    if (!extra)
      throw new Error(`Live task ${row.id} absent from inheritance projection`);
    return {
      ...row,
      assigneeId: extra.effectiveAssigneeId,
      assignee: extra.effectiveAssigneeId
        ? (refs.assignees.get(extra.effectiveAssigneeId) ?? null)
        : null,
      projectId: extra.effectiveProjectId,
      subjectProductId: extra.effectiveSubjectProductId,
      trade: tradeSchema.parse(extra.effectiveTrade),
      project: extra.effectiveProjectId
        ? (refs.projects.get(extra.effectiveProjectId) ?? null)
        : null,
      subjectProduct: extra.effectiveSubjectProductId
        ? (refs.products.get(extra.effectiveSubjectProductId) ?? null)
        : null,
      fieldResolutions: assignmentResolutions(row, extra, refs),
    };
  });
}

type TaskDraft = Pick<
  TaskCreateInput,
  | "assigneeId"
  | "assigneeMode"
  | "projectId"
  | "projectMode"
  | "subjectProductId"
  | "subjectProductMode"
  | "parentTaskId"
  | "trade"
>;

/** Draft and saved reads use exactly the same resolution expressions. */
export async function resolveDraftTaskFields(
  db: Database,
  draft: TaskDraft,
): Promise<FieldResolutions> {
  const row: TaskAssignment = {
    assigneeId:
      draft.assigneeMode === "inherit" || !draft.assigneeId
        ? null
        : await resolveOrThrow(db, "ledgerParty", draft.assigneeId),
    assigneeMode:
      draft.assigneeMode ??
      (draft.assigneeId === undefined ? "inherit" : "explicit"),
    projectId: draft.projectId
      ? await resolveOrThrow(db, "project", draft.projectId)
      : null,
    projectMode:
      draft.projectMode ?? (draft.projectId == null ? "inherit" : "explicit"),
    subjectProductId: draft.subjectProductId
      ? await resolveOrThrow(db, "product", draft.subjectProductId)
      : null,
    subjectProductMode:
      draft.subjectProductMode ??
      (draft.subjectProductId == null ? "inherit" : "explicit"),
    parentTaskId: draft.parentTaskId
      ? await resolveOrThrow(db, "task", draft.parentTaskId)
      : null,
    trade: draft.trade ?? null,
  };
  const extras = taskResolutionExtras("candidate");
  const selection = sql.join(
    Object.entries(extras).map(
      ([key, expression]) => sql`${expression} AS ${sql.identifier(key)}`,
    ),
    sql`, `,
  );
  const result = await getDb(db).execute<ResolvedAssignment>(sql`
    WITH candidate AS (SELECT NULL::uuid AS "id", ${row.assigneeId}::uuid AS "assigneeId", ${row.assigneeMode}::text AS "assigneeMode", ${row.projectId}::uuid AS "projectId", ${row.projectMode}::text AS "projectMode",
      ${row.subjectProductId}::uuid AS "subjectProductId", ${row.subjectProductMode}::text AS "subjectProductMode",
      ${row.parentTaskId}::uuid AS "parentTaskId", ${row.trade}::text AS "trade")
    SELECT ${selection} FROM candidate
  `);
  const extra = result.rows[0];
  if (!extra) throw new Error("Task draft resolution returned no row");
  return assignmentResolutions(
    row,
    extra,
    await assignmentReferences(db, [row], [extra]),
  );
}
