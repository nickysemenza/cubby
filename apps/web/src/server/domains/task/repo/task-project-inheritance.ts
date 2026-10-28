import { type TaskCreateInput } from "@cubby/schemas/entities/task";
import {
  fieldResolutionsSchema,
  type FieldResolutions,
} from "@cubby/schemas/field-resolution";
import type {
  LedgerPartyId,
  ProductId,
  ProjectId,
  TaskId,
} from "@cubby/schemas/identifiers";
import { tradeSchema, type Trade } from "@cubby/schemas/task-fields";
/**
 * Task inheritance provenance. Effective project, subject product, assignee
 * and trade values compile from their `resolution.inherit`
 * (`effectiveFieldSql`); the generic inherited-resolution compiler supplies
 * the matching public provenance for saved rows and draft candidates.
 *
 * These expressions deliberately use scalar correlated subqueries rather than
 * joins. Callers can use them from a Task, Expense, or report query without
 * accidentally changing row cardinality.
 */
import { and, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, product, project, task } from "~/server/db/schema";
import { inheritedFieldResolutionsSql } from "~/server/generic/derived/repo/inherited-resolution";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const effectiveTaskProjectSql = (alias: string) =>
  effectiveFieldSql<ProjectId | null>("task", "projectId", alias);

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
  effectiveTrade: effectiveFieldSql<Trade | null>("task", "trade", alias),
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

const taskResolutionExtras = (alias: string) => ({
  ...taskInheritanceReadExtras(alias),
  fieldResolutions: inheritedFieldResolutionsSql("task", alias),
});
type ResolvedAssignment = {
  effectiveAssigneeId: LedgerPartyId | null;
  effectiveProjectId: ProjectId | null;
  effectiveSubjectProductId: ProductId | null;
  effectiveTrade: Trade | null;
  fieldResolutions: FieldResolutions;
};

/** Typed relation hydration is separate from declaration-owned resolution facts. */
async function assignmentReferences(
  db: Database,
  extras: readonly ResolvedAssignment[],
) {
  const projectIds = [
    ...new Set(
      extras.flatMap((row) =>
        row.effectiveProjectId ? [row.effectiveProjectId] : [],
      ),
    ),
  ];
  const productIds = [
    ...new Set(
      extras.flatMap((row) =>
        row.effectiveSubjectProductId ? [row.effectiveSubjectProductId] : [],
      ),
    ),
  ];
  const assigneeIds = [
    ...new Set(
      extras.flatMap((row) =>
        row.effectiveAssigneeId ? [row.effectiveAssigneeId] : [],
      ),
    ),
  ];
  const [projects, products, assignees] = await Promise.all([
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
  ]);
  return {
    assignees: new Map(assignees.map((row) => [row.id, row])),
    projects: new Map(projects.map((row) => [row.id, row])),
    products: new Map(products.map((row) => [row.id, row])),
  };
}

/** Batch effective values and provenance; references always use public shortcodes. */
export async function hydrateTaskInheritanceRows<
  T extends TaskAssignment & { id: TaskId },
>(db: Database, rows: readonly T[]) {
  if (!rows.length) return [];
  const extras = await getDb(db)
    .select({ id: task.id, ...taskResolutionExtras("Task") })
    .from(task)
    .where(
      and(
        inArray(
          task.id,
          rows.map((row) => row.id),
        ),
        notDeleted(task),
      ),
    );
  const byId = new Map(extras.map((row) => [row.id, row]));
  const refs = await assignmentReferences(db, extras);
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
      fieldResolutions: extra.fieldResolutions,
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
  // Raw execute does not apply Drizzle column decoders.
  return fieldResolutionsSchema.parse(extra.fieldResolutions);
}
