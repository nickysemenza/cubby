import type {
  FieldResolution,
  FieldResolutions,
} from "@cubby/schemas/field-resolution";
import type { ProductId, ProjectId, TaskId } from "@cubby/schemas/identifiers";
import type { TaskCreateInput } from "@cubby/schemas/project";
import { tradeSchema, type Trade } from "@cubby/schemas/task-fields";
/**
 * Canonical SQL resolution for task and project inheritance.
 *
 * These expressions deliberately use scalar correlated subqueries rather than
 * joins. Callers can use them from a Task, Expense, or report query without
 * accidentally changing row cardinality. The aliases are internal constants;
 * the optional task alias is only used by repository-owned call sites.
 */
import { type SQL, and, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product, project, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

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

/** The nearest explicit project locations, starting at `projectId`. */
export const effectiveProjectLocationsSql = (
  projectId: SQL,
): SQL<string[]> => sql`
  coalesce((
    WITH RECURSIVE project_ancestors AS (
      SELECT p."id", p."parentProjectId", p."locations", p."locationsMode", 0 AS depth
      FROM "Project" p
      WHERE p."id" = ${projectId} AND p."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentProjectId", parent."locations", parent."locationsMode",
        project_ancestors.depth + 1
      FROM "Project" parent
      JOIN project_ancestors ON parent."id" = project_ancestors."parentProjectId"
      WHERE parent."deletedAt" IS NULL AND project_ancestors.depth < 100
    )
    SELECT "locations"
    FROM project_ancestors
    WHERE "locationsMode" = 'explicit'
    ORDER BY depth
    LIMIT 1
  ), '{}'::text[])
`;

/** Effective task project: an explicit value (including NULL) or live parent. */
export const effectiveTaskProjectSql = (
  alias = "Task",
): SQL<ProjectId | null> => {
  const mode = taskColumn(alias, "projectMode");
  const value = taskColumn(alias, "projectId");
  const parentId = taskColumn(alias, "parentTaskId");
  return sql`
    CASE WHEN ${mode} = 'explicit' OR ${value} IS NOT NULL THEN ${value}
    ELSE (
      SELECT CASE WHEN parent."projectMode" = 'explicit' OR parent."projectId" IS NOT NULL THEN parent."projectId"
        ELSE NULL END
      FROM "Task" parent
      WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL
    ) END
  `;
};

/** Effective task subject product: an explicit value (including NULL) or live parent. */
export const effectiveTaskSubjectProductSql = (
  alias = "Task",
): SQL<ProductId | null> => {
  const mode = taskColumn(alias, "subjectProductMode");
  const value = taskColumn(alias, "subjectProductId");
  const parentId = taskColumn(alias, "parentTaskId");
  return sql`
    CASE WHEN ${mode} = 'explicit' OR ${value} IS NOT NULL THEN ${value}
    ELSE (
      SELECT CASE WHEN parent."subjectProductMode" = 'explicit' OR parent."subjectProductId" IS NOT NULL THEN parent."subjectProductId"
        ELSE NULL END
      FROM "Task" parent
      WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL
    ) END
  `;
};

/**
 * Task trade can come from its own explicit choice, a parent task only when
 * both effective projects match, then the effective project's default trade.
 */
export const effectiveTaskTradeSql = (alias = "Task"): SQL<Trade | null> => {
  const ownTrade = taskColumn(alias, "trade");
  const parentId = taskColumn(alias, "parentTaskId");
  const projectId = effectiveTaskProjectSql(alias);
  return sql`
    coalesce(
      ${ownTrade},
      (
        SELECT parent."trade"
        FROM "Task" parent
        WHERE parent."id" = ${parentId}
          AND parent."deletedAt" IS NULL
          AND parent."trade" IS NOT NULL
          AND ${effectiveTaskProjectSql("parent")} IS NOT DISTINCT FROM ${projectId}
      ),
      ${effectiveProjectTradeSql(projectId)}
    )
  `;
};

/**
 * Select-list additions for readers that hydrate Task rows outside the normal
 * repository. Keep the names stable: calendar, search, and embeddings can
 * carry these values through their own projections without reimplementing the
 * inheritance expression.
 */
const taskInheritanceReadExtras = (alias = "Task") => ({
  effectiveProjectId: effectiveTaskProjectSql(alias),
  effectiveSubjectProductId: effectiveTaskSubjectProductSql(alias),
  effectiveTrade: effectiveTaskTradeSql(alias),
});

type AssignmentMode = "inherit" | "explicit";
type TaskAssignment = {
  projectId: ProjectId | null;
  projectMode: AssignmentMode;
  subjectProductId: ProductId | null;
  subjectProductMode: AssignmentMode;
  parentTaskId: TaskId | null;
  trade: Trade | null;
};

const taskResolutionExtras = (alias: string) => {
  const parentId = taskColumn(alias, "parentTaskId");
  const parentProject = sql<ProjectId | null>`(SELECT ${effectiveTaskProjectSql("parent")}
    FROM "Task" parent WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL)`;
  const parentProduct = sql<ProductId | null>`(SELECT ${effectiveTaskSubjectProductSql("parent")}
    FROM "Task" parent WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL)`;
  const parentTrade = sql<Trade | null>`(SELECT parent."trade" FROM "Task" parent
    WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL
      AND ${effectiveTaskProjectSql("parent")} IS NOT DISTINCT FROM ${effectiveTaskProjectSql(alias)})`;
  return {
    ...taskInheritanceReadExtras(alias),
    fallbackProjectId: parentProject,
    fallbackSubjectProductId: parentProduct,
    fallbackTrade: sql<Trade | null>`coalesce(${parentTrade}, ${effectiveProjectTradeSql(effectiveTaskProjectSql(alias))})`,
    parentTrade,
    parentShortcode: sql<
      string | null
    >`(SELECT parent."shortcode" FROM "Task" parent
      WHERE parent."id" = ${parentId} AND parent."deletedAt" IS NULL)`,
  };
};
type ResolvedAssignment = {
  effectiveProjectId: ProjectId | null;
  effectiveSubjectProductId: ProductId | null;
  effectiveTrade: Trade | null;
  fallbackProjectId: ProjectId | null;
  fallbackSubjectProductId: ProductId | null;
  fallbackTrade: Trade | null;
  parentTrade: Trade | null;
  parentShortcode: string | null;
};

async function assignmentReferences(
  db: Database,
  rows: readonly TaskAssignment[],
  extras: readonly ResolvedAssignment[],
) {
  const projectIds = [
    ...new Set([
      ...rows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
      ...extras.flatMap((row) =>
        [row.effectiveProjectId, row.fallbackProjectId].filter(
          (id): id is ProjectId => id !== null,
        ),
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
  const [projects, products] = await Promise.all([
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
  ]);
  return {
    projects: new Map(projects.map((row) => [row.id, row])),
    products: new Map(products.map((row) => [row.id, row])),
  };
}

function referenceResolution(
  explicit: boolean,
  stored: string | null,
  value: string | null,
  fallback: string | null,
  parent: FieldResolution["sourceEntity"],
): FieldResolution {
  return {
    mode: explicit ? (stored === null ? "none" : "explicit") : "inherit",
    storedValue: stored,
    value,
    fallbackValue: fallback,
    source: explicit ? "Task override" : parent ? "Parent task" : "Unassigned",
    sourceEntity: explicit ? null : parent,
    matchesFallback: explicit && stored !== null && stored === fallback,
    canReset: explicit,
  };
}

function tradeResolution(
  row: TaskAssignment,
  extra: ResolvedAssignment,
  parent: FieldResolution["sourceEntity"],
  projectCode: string | null,
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
            ? { entityType: "project", entityId: projectCode }
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
    ? { entityType: "task" as const, entityId: extra.parentShortcode }
    : null;
  return {
    projectId: referenceResolution(
      row.projectMode === "explicit" || row.projectId !== null,
      projectCode(row.projectId),
      projectCode(extra.effectiveProjectId),
      projectCode(extra.fallbackProjectId),
      parent,
    ),
    subjectProductId: referenceResolution(
      row.subjectProductMode === "explicit" || row.subjectProductId !== null,
      productCode(row.subjectProductId),
      productCode(extra.effectiveSubjectProductId),
      productCode(extra.fallbackSubjectProductId),
      parent,
    ),
    trade: tradeResolution(
      row,
      extra,
      parent,
      projectCode(extra.effectiveProjectId),
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
      effectiveProjectId: null,
      effectiveSubjectProductId: row.subjectProductId,
      effectiveTrade: row.trade,
      fallbackProjectId: null,
      fallbackSubjectProductId: null,
      fallbackTrade: null,
      parentTrade: null,
      parentShortcode: null,
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
    WITH candidate AS (SELECT ${row.projectId}::uuid AS "projectId", ${row.projectMode}::text AS "projectMode",
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
