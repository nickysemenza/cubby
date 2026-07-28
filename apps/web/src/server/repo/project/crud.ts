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
import type { Database, DrizzleTransaction } from "~/server/db";
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
  diffUnorderedIdSet,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  assertNoDependents,
  buildPartialUpdateValues,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { projectDependencyIds } from "./analytics";
import {
  dbProjectToAPI,
  EMPTY_PROJECT_OWN_ROLLUP,
  EMPTY_PROJECT_SUBTREE_ROLLUP,
} from "./helpers";
import { loadProjectSubtreeRollups, MAX_PROJECT_TREE_DEPTH } from "./subtree";

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
    // Whole-tree parent/child map + this project's subtree rollup — see
    // subtree.ts's doc comment for why the tree is loaded in full rather than
    // walked with per-row queries.
    const [{ childrenByParent, nameById, ownRollups, subtreeRollups }, deps] =
      await Promise.all([
        loadProjectSubtreeRollups(db, [row.id]),
        projectDependencyIds(db, [row.id]),
      ]);

    return dbProjectToAPI(
      row,
      ownRollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
      subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
      deps.blockedBy.get(row.id) ?? [],
      deps.blocking.get(row.id) ?? [],
      row.parentProjectId ? (nameById.get(row.parentProjectId) ?? null) : null,
      childrenByParent.get(row.id) ?? [],
    );
  },
  notFoundReason: "PROJECT_NOT_FOUND",
});

export const getProjectByID = (
  db: Database,
  id: ProjectId,
): Promise<ProjectOut> => projectReader.getByID(db, id);

/**
 * The referenced project must exist and be live. Guards `parentProjectId`
 * writes (this file) and any other write that points a foreign key straight
 * at a project id without going through a picker that already filters to live
 * projects — task/purchase bulk-move (`repo/task/crud.ts`'s `moveTasks`,
 * `repo/purchase/crud.ts`'s `movePurchases`) reuse this rather than
 * re-implementing the same live-row check.
 */
export async function assertProjectLive(
  tx: DrizzleTransaction,
  id: ProjectId,
): Promise<void> {
  const live = await tx.query.project.findFirst({
    where: and(eq(project.id, id), notDeleted(project)),
    columns: { id: true },
  });
  if (!live) {
    throw createAppError(
      "PROJECT_NOT_FOUND",
      `Project ${id} does not exist or has been deleted`,
    );
  }
}

/** The chosen parent must exist and be live. */
async function assertParentProjectExists(
  tx: DrizzleTransaction,
  parentId: ProjectId,
): Promise<void> {
  await assertProjectLive(tx, parentId);
}

/**
 * Walk `newParentId`'s ancestor chain (up to `MAX_PROJECT_TREE_DEPTH` hops,
 * defensively) looking for `projectId` — true if setting the parent would
 * make `projectId` its own ancestor. Mirrors
 * repo/location/tree.ts's `wouldCreateParentCycle`.
 */
async function wouldCreateProjectCycle(
  tx: DrizzleTransaction,
  projectId: ProjectId,
  newParentId: ProjectId,
): Promise<boolean> {
  if (projectId === newParentId) return true;

  let currentId: ProjectId | null = newParentId;
  let hops = 0;
  while (currentId && hops < MAX_PROJECT_TREE_DEPTH) {
    if (currentId === projectId) return true;
    const row: { parentProjectId: ProjectId | null } | undefined =
      await tx.query.project.findFirst({
        where: eq(project.id, currentId),
        columns: { parentProjectId: true },
      });
    currentId = row?.parentProjectId ?? null;
    hops++;
  }
  return false;
}

export const createProject = async (
  db: Database,
  data: ProjectCreateInput,
  actor: ActorContext,
): Promise<ProjectOut> => {
  const id = await withTransaction(db, async (tx) => {
    if (data.parentProjectId) {
      await assertParentProjectExists(tx, data.parentProjectId);
    }

    const created = await insertAndReturn(tx, project, {
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      costEstimate: data.costEstimate,
      parentProjectId: data.parentProjectId,
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
  "parentProjectId",
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
    if (data.parentProjectId !== undefined && data.parentProjectId !== null) {
      if (data.parentProjectId === id) {
        throw createAppError(
          "SELF_DEPENDENCY",
          "A project cannot be its own parent.",
        );
      }
      await assertParentProjectExists(tx, data.parentProjectId);
      if (await wouldCreateProjectCycle(tx, id, data.parentProjectId)) {
        throw createAppError(
          "PROJECT_CYCLE",
          "Cannot set parent: would create a circular reference.",
        );
      }
    }

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      costEstimate: data.costEstimate,
      parentProjectId: data.parentProjectId,
      startDate: data.startDate,
      endDate: data.endDate,
      icon: data.icon,
      notes: data.notes,
    });
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
      const blockedByChange = diffUnorderedIdSet(
        beforeBlockedBy ?? [],
        data.blockedByIds,
      );
      if (blockedByChange) {
        changes.blockedByIds = blockedByChange;
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
 * Soft-delete projects. Guards against orphaning live tasks/purchases/child
 * projects (throws `PROJECT_HAS_TASKS` / `PROJECT_HAS_PURCHASES` /
 * `PROJECT_HAS_CHILDREN` — no cascade, a child project stays a live orphan
 * candidate until reparented or deleted itself), then always hard-deletes the
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

    const liveChildren = await tx.query.project.findMany({
      where: and(inArray(project.parentProjectId, ids), notDeleted(project)),
      columns: { parentProjectId: true },
    });
    await assertNoDependents({
      offendingParentIds: liveChildren.map((c) => c.parentProjectId),
      fetchNames: (failedIds) =>
        tx.query.project.findMany({
          where: inArray(project.id, failedIds),
          columns: { name: true },
        }),
      reason: "PROJECT_HAS_CHILDREN",
      message: (count, names) =>
        `Cannot delete ${count} project(s): ${names} still have sub-projects. Delete or reparent them first.`,
    });

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

    // Removal-path invariant: every delete path cleans up its embeddings in-tx.
    await softDeleteEntityEmbeddingsTx(tx, "project", ids);

    const auditEntries = buildCascadeAuditEntries("project", ids, {
      cascadedImages: countBy(cascadedImages, (i) => i.projectId),
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
