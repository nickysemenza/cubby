/**
 * Project CRUD operations.
 *
 * The read path goes through `createEntityReader`, but the write path is
 * hand-rolled (like meal/location): `update` manages the `blockedByIds`
 * replacement set (delete-then-insert `projectDependency` rows) inside the
 * same transaction as the column update, and `delete` guards against
 * orphaning live tasks/expenses before hard-deleting the dependency edges.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type ProjectId,
  type ProjectShortcode,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
import type {
  ProjectCreateInput,
  ProjectOut,
  ProjectUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, or } from "drizzle-orm";
import { countBy } from "es-toolkit";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expense,
  project,
  projectDependency,
  projectImage,
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
  lockAndValidateForDelete,
  notDeleted,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { projectDependencyIds } from "./analytics";
import { hydrateProjectRow } from "./helpers";
import { loadProjectSubtreeRollups, MAX_PROJECT_TREE_DEPTH } from "./subtree";

export const PROJECT_DELETE_EDGE_POLICY = {
  "Project.parentProjectId": {
    code: "block-live-child",
    effect: "block",
    description:
      "A project with live sub-projects can't be deleted — delete or reparent them first.",
  },
  "ProjectDependency.projectId": {
    code: "hard-delete-dependency",
    effect: "hard-delete",
    description:
      "Blocks/blocked-by dependency rows naming the project are removed outright.",
  },
  "ProjectDependency.blockedByProjectId": {
    code: "hard-delete-dependency",
    effect: "hard-delete",
    description:
      "Blocks/blocked-by dependency rows naming the project are removed outright.",
  },
  "Task.projectId": {
    code: "block-live-task",
    effect: "block",
    description:
      "A project with live tasks can't be deleted — delete or reassign them first.",
  },
  "Expense.projectId": {
    code: "block-live-expense",
    effect: "block",
    description:
      "A project with live expenses can't be deleted — delete or reassign them first.",
  },
  "ProjectImage.projectId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the project; the underlying images are not.",
  },
} as const satisfies IncomingEdgePolicy<"project", OperationDisposition>;

/** `projectUpdateData` has no standalone type export — derive it from the input. */
type ProjectUpdateData = ProjectUpdateInput["data"];

const fetchProjectById = (db: Database, id: ProjectId) =>
  getDb(db).query.project.findFirst({
    where: and(eq(project.id, id), notDeleted(project)),
  });

const projectReader = createEntityReader({
  entity: "project",
  fetchById: fetchProjectById,
  fromDB: async (db, row) => {
    // Whole-tree parent/child map + this project's subtree rollup — see
    // subtree.ts's doc comment for why the tree is loaded in full rather than
    // walked with per-row queries.
    const [projectContext, deps] = await Promise.all([
      loadProjectSubtreeRollups(db, [row.id]),
      projectDependencyIds(db, [row.id]),
    ]);

    return hydrateProjectRow(row, projectContext, deps);
  },
  notFoundReason: "PROJECT_NOT_FOUND",
});

export const getProjectByID = (
  db: Database,
  id: ProjectId,
): Promise<ProjectOut> => projectReader.getByID(db, id);

export const getProjectByShortcode = (db: Database, shortcode: string) =>
  projectReader.getByShortcode(db, shortcode);

/**
 * The referenced project must exist and be live. Guards `parentProjectId`
 * writes (this file) and any other write that points a foreign key straight
 * at a project id without going through a picker that already filters to live
 * projects — task/expense bulk-move (`repo/task/crud.ts`'s `moveTasks`,
 * `repo/expense/crud.ts`'s `moveExpenses`) reuse this rather than
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
): Promise<{ output: ProjectOut; entityId: ProjectId }> => {
  const id = await withTransaction(db, async (tx) => {
    // Resolving THROUGH a LIVE-only lookup is the "exists and is live" check
    // itself — an FK proves the parent row exists, not that it's live.
    let parentProjectId: ProjectId | null = null;
    if (data.parentProjectId) {
      const resolved = await resolveLiveShortcode(
        tx,
        data.parentProjectId,
        "project",
      );
      if (!resolved) {
        throw createAppError(
          "PROJECT_NOT_FOUND",
          `Project ${data.parentProjectId} does not exist or has been deleted`,
        );
      }
      parentProjectId = unsafeProjectId(resolved);
    }

    const created = await insertWithShortcode(tx, "project", {
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      costEstimate: data.costEstimate,
      parentProjectId,
      startDate: data.startDate,
      endDate: data.endDate,
      icon: data.icon,
      notes: data.notes,
      googleDriveFolderUrl: data.googleDriveFolderUrl,
      notionPageUrl: data.notionPageUrl,
    });
    await logAuditEntry(tx, actor, {
      entityType: "project",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getProjectByID(db, id), entityId: id };
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
  "googleDriveFolderUrl",
  "notionPageUrl",
] as const;

export const updateProject = async (
  db: Database,
  shortcode: ProjectShortcode,
  data: ProjectUpdateData,
  actor: ActorContext,
): Promise<{ output: ProjectOut; entityId: ProjectId }> => {
  const resolvedId = await resolveLiveShortcode(db, shortcode, "project");
  if (!resolvedId) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${shortcode} not found`);
  }
  const id = unsafeProjectId(resolvedId);

  const before = await fetchProjectById(db, id);
  if (!before) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${id} not found`);
  }
  const beforeBlockedBy =
    data.blockedByIds !== undefined
      ? ((await projectDependencyIds(db, [id])).blockedBy.get(id) ?? [])
      : undefined;

  await withTransaction(db, async (tx) => {
    let parentProjectId: ProjectId | null | undefined;
    if (data.parentProjectId !== undefined && data.parentProjectId !== null) {
      const resolvedParent = await resolveLiveShortcode(
        tx,
        data.parentProjectId,
        "project",
      );
      if (!resolvedParent) {
        throw createAppError(
          "PROJECT_NOT_FOUND",
          `Project ${data.parentProjectId} does not exist or has been deleted`,
        );
      }
      parentProjectId = unsafeProjectId(resolvedParent);
      if (parentProjectId === id) {
        throw createAppError(
          "SELF_DEPENDENCY",
          "A project cannot be its own parent.",
        );
      }
      if (await wouldCreateProjectCycle(tx, id, parentProjectId)) {
        throw createAppError(
          "PROJECT_CYCLE",
          "Cannot set parent: would create a circular reference.",
        );
      }
    } else if (data.parentProjectId === null) {
      parentProjectId = null;
    }

    // Full-replacement set: resolve every requested shortcode to a live uuid
    // up front — `replaceDependencyEdges`'s own not-found check operates on
    // the FK column, so it can't be handed a shortcode.
    let resolvedBlockedByIds: ProjectId[] | undefined;
    if (data.blockedByIds !== undefined) {
      const resolved = await resolveLiveShortcodes(
        tx,
        data.blockedByIds,
        "project",
      );
      const missing = data.blockedByIds.filter((code) => !resolved.has(code));
      if (missing.length > 0) {
        throw createAppError(
          "PROJECT_NOT_FOUND",
          `Project(s) not found: ${missing.join(", ")}`,
        );
      }
      resolvedBlockedByIds = data.blockedByIds.map((code) =>
        unsafeProjectId(resolved.get(code) ?? ""),
      );
    }

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      costEstimate: data.costEstimate,
      parentProjectId,
      startDate: data.startDate,
      endDate: data.endDate,
      icon: data.icon,
      notes: data.notes,
      googleDriveFolderUrl: data.googleDriveFolderUrl,
      notionPageUrl: data.notionPageUrl,
    });
    const updated = await updateLiveAndReturn(tx, project, updateValues, id);

    // Full-replacement set: clear this project's blocked-by edges and insert
    // the new ones, all inside the same transaction as the column update.
    if (resolvedBlockedByIds !== undefined) {
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
        resolvedBlockedByIds,
      );
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {
      ...(computeChanges(before, updated, [...AUDIT_FIELDS]) ?? {}),
    };
    if (resolvedBlockedByIds !== undefined) {
      const blockedByChange = diffUnorderedIdSet(
        beforeBlockedBy ?? [],
        resolvedBlockedByIds,
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

  return { output: await getProjectByID(db, id), entityId: id };
};

/** Either a checked-out transaction or a plain client — reads work the same on both. */
type ProjectQueryClient = DrizzleClient | DrizzleTransaction;

/**
 * Live sub-projects of `ids`, keyed by `parentProjectId`. Shared by
 * `deleteProjects`' PROJECT_HAS_CHILDREN guard and
 * `previewDeleteProjects`' blocker count, so the two predicates can't drift.
 */
const fetchLiveChildProjects = (dbc: ProjectQueryClient, ids: ProjectId[]) =>
  dbc.query.project.findMany({
    where: and(inArray(project.parentProjectId, ids), notDeleted(project)),
    columns: { parentProjectId: true },
  });

/**
 * Live tasks under `ids`. Shared by `deleteProjects`' PROJECT_HAS_TASKS guard
 * and `previewDeleteProjects`' blocker count.
 */
const fetchLiveProjectTasks = (dbc: ProjectQueryClient, ids: ProjectId[]) =>
  dbc.query.task.findMany({
    where: and(inArray(task.projectId, ids), notDeleted(task)),
    columns: { projectId: true },
  });

/**
 * Live expenses under `ids`. Shared by `deleteProjects`' PROJECT_HAS_EXPENSES
 * guard and `previewDeleteProjects`' blocker count.
 */
const fetchLiveProjectExpenses = (dbc: ProjectQueryClient, ids: ProjectId[]) =>
  dbc.query.expense.findMany({
    where: and(inArray(expense.projectId, ids), notDeleted(expense)),
    columns: { projectId: true },
  });

/**
 * Soft-delete projects. Guards against orphaning live tasks/expenses/child
 * projects (throws `PROJECT_HAS_TASKS` / `PROJECT_HAS_EXPENSES` /
 * `PROJECT_HAS_CHILDREN` — no cascade, a child project stays a live orphan
 * candidate until reparented or deleted itself), then always hard-deletes the
 * project's dependency edges in both directions — a `projectDependency` row
 * carries no meaning once either endpoint is gone, so it isn't soft-deleted —
 * and soft-deletes the project's images (mirrors product delete's
 * productImage cascade).
 */
export const deleteProjects = async (
  db: Database,
  shortcodes: ProjectShortcode[],
  actor: ActorContext,
): Promise<void> => {
  if (shortcodes.length === 0) return;

  const resolved = await resolveLiveShortcodes(db, shortcodes, "project");
  const missing = shortcodes.filter((code) => !resolved.has(code));
  if (missing.length > 0) {
    throw createAppError(
      "PROJECT_NOT_FOUND",
      `Projects not found or already deleted: ${missing.join(", ")}`,
    );
  }
  const ids = shortcodes.map((code) => unsafeProjectId(resolved.get(code) ?? ""));

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, project, ids, "Project");

    const liveChildren = await fetchLiveChildProjects(tx, ids);
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

    const liveTasks = await fetchLiveProjectTasks(tx, ids);
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

    const liveExpenses = await fetchLiveProjectExpenses(tx, ids);
    await assertNoDependents({
      offendingParentIds: liveExpenses.map((p) => p.projectId),
      fetchNames: (failedIds) =>
        tx.query.project.findMany({
          where: inArray(project.id, failedIds),
          columns: { name: true },
        }),
      reason: "PROJECT_HAS_EXPENSES",
      message: (count, names) =>
        `Cannot delete ${count} project(s): ${names} still have expenses. Delete or reassign them first.`,
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

/**
 * What `deleteProjects` would do to the given projects, without doing it.
 *
 * Reads the SAME `PROJECT_DELETE_EDGE_POLICY` and the same
 * `fetchLiveChildProjects`/`fetchLiveProjectTasks`/`fetchLiveProjectExpenses`
 * predicates the mutation's guards use, so the preview can't claim a delete
 * will succeed that those guards then refuse. `ProjectDependency`'s two edges
 * are counted with `includeDeleted: true` — it's one of the two hard-delete-
 * only source tables in the schema (no `deletedAt` column), so the default
 * `notDeleted` filter would throw.
 *
 * Advisory only. `deleteProjects` still re-runs every check inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteProjects = async (
  db: Database,
  ids: ProjectId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const dbClient = getDb(db);

  const [liveChildren, liveTasks, liveExpenses] = await Promise.all([
    fetchLiveChildProjects(dbClient, ids),
    fetchLiveProjectTasks(dbClient, ids),
    fetchLiveProjectExpenses(dbClient, ids),
  ]);

  const childrenByTarget: Record<string, number> = {};
  for (const { parentProjectId } of liveChildren) {
    if (parentProjectId) {
      childrenByTarget[parentProjectId] =
        (childrenByTarget[parentProjectId] ?? 0) + 1;
    }
  }
  const tasksByTarget: Record<string, number> = {};
  for (const { projectId } of liveTasks) {
    if (projectId)
      tasksByTarget[projectId] = (tasksByTarget[projectId] ?? 0) + 1;
  }
  const expensesByTarget: Record<string, number> = {};
  for (const { projectId } of liveExpenses) {
    if (projectId)
      expensesByTarget[projectId] = (expensesByTarget[projectId] ?? 0) + 1;
  }

  const blockers = present([
    impact({
      disposition: PROJECT_DELETE_EDGE_POLICY["Project.parentProjectId"],
      edgeKey: "Project.parentProjectId",
      label: "sub-projects",
      byTargetId: childrenByTarget,
    }),
    impact({
      disposition: PROJECT_DELETE_EDGE_POLICY["Task.projectId"],
      edgeKey: "Task.projectId",
      label: "tasks",
      byTargetId: tasksByTarget,
    }),
    impact({
      disposition: PROJECT_DELETE_EDGE_POLICY["Expense.projectId"],
      edgeKey: "Expense.projectId",
      label: "expenses",
      byTargetId: expensesByTarget,
    }),
  ]);

  const changes = present([
    impact({
      disposition: PROJECT_DELETE_EDGE_POLICY["ProjectDependency.projectId"],
      edgeKey: "ProjectDependency.projectId",
      label: "dependency edges (blocking others)",
      byTargetId: await countByTarget(
        dbClient,
        projectDependency,
        projectDependency.projectId,
        ids,
        { includeDeleted: true },
      ),
    }),
    impact({
      disposition:
        PROJECT_DELETE_EDGE_POLICY["ProjectDependency.blockedByProjectId"],
      edgeKey: "ProjectDependency.blockedByProjectId",
      label: "dependency edges (blocked by others)",
      byTargetId: await countByTarget(
        dbClient,
        projectDependency,
        projectDependency.blockedByProjectId,
        ids,
        { includeDeleted: true },
      ),
    }),
    impact({
      disposition: PROJECT_DELETE_EDGE_POLICY["ProjectImage.projectId"],
      edgeKey: "ProjectImage.projectId",
      label: "images",
      byTargetId: await countByTarget(
        dbClient,
        projectImage,
        projectImage.projectId,
        ids,
      ),
    }),
  ]);

  return { blockers, changes };
};
