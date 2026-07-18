/**
 * Project CRUD operations.
 *
 * The read path goes through `createEntityReader`, but the write path is
 * hand-rolled (like meal/location): `update` manages the `blockedByIds`
 * replacement set (delete-then-insert `projectDependency` rows) inside the
 * same transaction as the column update, and `delete` guards against
 * orphaning live tasks/purchases before hard-deleting the dependency edges.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectCreateInput,
  ProjectOut,
  ProjectUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, or } from "drizzle-orm";
import { countBy } from "es-toolkit";
import type { Database } from "~/server/db";
import {
  project,
  projectDependency,
  projectImage,
  purchase,
  task,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  assertNoDependents,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { projectDependencyIds, projectRollups } from "./analytics";
import { dbProjectToAPI, EMPTY_PROJECT_ROLLUP } from "./helpers";

/** `projectUpdateData` has no standalone type export — derive it from the input. */
type ProjectUpdateData = ProjectUpdateInput["data"];

const fetchProjectById = (db: Database, id: ProjectId) =>
  getDb(db).query.project.findFirst({
    where: and(eq(project.id, id), notDeleted(project)),
  });

const projectReader = createEntityReader({
  entityName: "project",
  fetchById: fetchProjectById,
  fromDB: async (db, row) => {
    const [rollups, deps] = await Promise.all([
      projectRollups(db, [row.id]),
      projectDependencyIds(db, [row.id]),
    ]);
    return dbProjectToAPI(
      row,
      rollups.get(row.id) ?? EMPTY_PROJECT_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
    );
  },
  notFoundReason: "PROJECT_NOT_FOUND",
});

export const getProjectByID = (
  db: Database,
  id: ProjectId,
): Promise<ProjectOut> => projectReader.getByID(db, id);

export const createProject = async (
  db: Database,
  data: ProjectCreateInput,
  actor: ActorContext,
): Promise<ProjectOut> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertAndReturn(tx, project, {
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      costEstimate: data.costEstimate,
      startDate: data.startDate,
      endDate: data.endDate,
      icon: data.icon,
      notes: data.notes,
    });
    await logAuditEntry(tx, actor, {
      entityType: "project",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return getProjectByID(db, id);
};

const AUDIT_FIELDS = [
  "name",
  "status",
  "kind",
  "locations",
  "costEstimate",
  "startDate",
  "endDate",
  "icon",
  "notes",
] as const;

export const updateProject = async (
  db: Database,
  id: ProjectId,
  data: ProjectUpdateData,
  actor: ActorContext,
): Promise<ProjectOut> => {
  const before = await fetchProjectById(db, id);
  if (!before) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${id} not found`);
  }
  const beforeBlockedBy =
    data.blockedByIds !== undefined
      ? ((await projectDependencyIds(db, [id])).blockedBy.get(id) ?? [])
      : undefined;

  await withTransaction(db, async (tx) => {
    const updateValues = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.locations !== undefined ? { locations: data.locations } : {}),
      ...(data.costEstimate !== undefined
        ? { costEstimate: data.costEstimate }
        : {}),
      ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    };
    const updated = await updateLiveAndReturn(tx, project, updateValues, id);

    // Full-replacement set: clear this project's blocked-by edges and insert
    // the new ones, all inside the same transaction as the column update.
    if (data.blockedByIds !== undefined) {
      await replaceDependencyEdges(
        tx,
        projectDependency,
        {
          ownColumn: projectDependency.projectId,
          blockedByColumn: projectDependency.blockedByProjectId,
          buildRow: (projectId, blockedByProjectId) => ({
            projectId,
            blockedByProjectId,
          }),
          entityTable: project,
          label: "Project",
          notFoundReason: "PROJECT_NOT_FOUND",
        },
        id,
        data.blockedByIds,
      );
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {
      ...(computeChanges(before, updated, [...AUDIT_FIELDS]) ?? {}),
    };
    if (data.blockedByIds !== undefined) {
      const beforeSorted = [...(beforeBlockedBy ?? [])].sort();
      const afterSorted = [...data.blockedByIds].sort();
      if (JSON.stringify(beforeSorted) !== JSON.stringify(afterSorted)) {
        changes.blockedByIds = {
          from: beforeBlockedBy ?? [],
          to: data.blockedByIds,
        };
      }
    }
    if (Object.keys(changes).length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  return getProjectByID(db, id);
};

/**
 * Soft-delete projects. Guards against orphaning live tasks/purchases (throws
 * `PROJECT_HAS_TASKS` / `PROJECT_HAS_PURCHASES`), then always hard-deletes the
 * project's dependency edges in both directions — a `projectDependency` row
 * carries no meaning once either endpoint is gone, so it isn't soft-deleted —
 * and soft-deletes the project's images (mirrors product delete's
 * productImage cascade).
 */
export const deleteProjects = async (
  db: Database,
  ids: ProjectId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, project, ids, "Project");

    const liveTasks = await tx.query.task.findMany({
      where: and(inArray(task.projectId, ids), notDeleted(task)),
      columns: { projectId: true },
    });
    await assertNoDependents({
      offendingParentIds: liveTasks.map((t) => t.projectId),
      fetchNames: (failedIds) =>
        tx.query.project.findMany({
          where: inArray(project.id, failedIds),
          columns: { name: true },
        }),
      reason: "PROJECT_HAS_TASKS",
      message: (count, names) =>
        `Cannot delete ${count} project(s): ${names} still have tasks. Delete or reassign them first.`,
    });

    const livePurchases = await tx.query.purchase.findMany({
      where: and(inArray(purchase.projectId, ids), notDeleted(purchase)),
      columns: { projectId: true },
    });
    await assertNoDependents({
      offendingParentIds: livePurchases.map((p) => p.projectId),
      fetchNames: (failedIds) =>
        tx.query.project.findMany({
          where: inArray(project.id, failedIds),
          columns: { name: true },
        }),
      reason: "PROJECT_HAS_PURCHASES",
      message: (count, names) =>
        `Cannot delete ${count} project(s): ${names} still have purchases. Delete or reassign them first.`,
    });

    await tx
      .delete(projectDependency)
      .where(
        or(
          inArray(projectDependency.projectId, ids),
          inArray(projectDependency.blockedByProjectId, ids),
        ),
      );

    const now = new Date();

    // Cascaded counts (per project) for the audit trail, gathered before the
    // soft-delete below flips their deletedAt.
    const cascadedImages = await tx.query.projectImage.findMany({
      where: and(
        inArray(projectImage.projectId, ids),
        notDeleted(projectImage),
      ),
      columns: { projectId: true },
    });

    await tx
      .update(projectImage)
      .set({ deletedAt: now })
      .where(
        and(inArray(projectImage.projectId, ids), notDeleted(projectImage)),
      );

    await tx
      .update(project)
      .set({ deletedAt: now })
      .where(and(inArray(project.id, ids), notDeleted(project)));

    const auditEntries = buildCascadeAuditEntries("project", ids, {
      cascadedImages: countBy(cascadedImages, (i) => i.projectId),
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
