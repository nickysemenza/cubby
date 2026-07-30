/**
 * Inbox → project promotion: create a new project and move the given tasks
 * onto it in one transaction — see `createProjectFromTasksInput`/`Out` in
 * `@cubby/schemas/project` and `project.createFromTasks` (routers/project.ts).
 * Neither side persists if the other fails (plain `withTransaction` rollback).
 *
 * Deliberately does NOT call `createProject`/`moveTasks` (both start their own
 * top-level `withTransaction`) — the create + move happen inline against the
 * same `tx`, mirroring `moveTasks`' own column-write shape one level down.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type {
  CreateProjectFromTasksInput,
  CreateProjectFromTasksOut,
} from "@cubby/schemas/project";
import { and, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import { project, task } from "~/server/db/schema";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  insertAndReturn,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getTasksByIDs } from "~/server/repo/task";
import { assertProjectLive, getProjectByID } from "./crud";

export async function createProjectFromTasks(
  db: Database,
  input: CreateProjectFromTasksInput,
  actor: ActorContext,
): Promise<CreateProjectFromTasksOut> {
  const { projectId, taskIds } = await withTransaction(db, async (tx) => {
    if (input.project.parentProjectId) {
      await assertProjectLive(tx, input.project.parentProjectId);
    }

    const created = await insertAndReturn(tx, project, {
      name: input.project.name,
      status: input.project.status,
      kind: input.project.kind,
      locations: input.project.locations,
      costEstimate: input.project.costEstimate,
      parentProjectId: input.project.parentProjectId,
      startDate: input.project.startDate,
      endDate: input.project.endDate,
      icon: input.project.icon,
      notes: input.project.notes,
      googleDriveFolderUrl: input.project.googleDriveFolderUrl,
      notionPageUrl: input.project.notionPageUrl,
    });
    await logAuditEntry(tx, actor, {
      entityType: "project",
      entityId: created.id,
      action: "create",
    });

    const before = await tx.query.task.findMany({
      where: and(inArray(task.id, input.taskIds), notDeleted(task)),
      columns: { id: true, projectId: true },
    });

    if (before.length > 0) {
      await tx
        .update(task)
        .set({ projectId: created.id })
        .where(and(inArray(task.id, input.taskIds), notDeleted(task)));

      const auditEntries: AuditEntryInput[] = [];
      for (const row of before) {
        const changes = computeChanges(
          row,
          { id: row.id, projectId: created.id },
          ["projectId"],
        );
        if (changes) {
          auditEntries.push({
            entityType: "task",
            entityId: row.id,
            action: "update",
            changes,
          });
        }
      }
      await logAuditEntries(tx, actor, auditEntries);
    }

    return { projectId: created.id, taskIds: before.map((row) => row.id) };
  });

  const [projectOut, tasks] = await Promise.all([
    getProjectByID(db, projectId),
    getTasksByIDs(db, taskIds),
  ]);

  return { project: projectOut, tasks };
}
