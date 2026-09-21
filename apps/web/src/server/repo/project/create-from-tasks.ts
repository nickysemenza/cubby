/**
 * Inbox → project promotion: create a new project and move the given tasks
 * onto it in one transaction — see `createProjectFromTasksInput`/`Out` in
 * `@cubby/schemas/project` and `project.createFromTasks` (routers/project.ts).
 * Neither side persists if the other fails (plain `withTransaction` rollback).
 *
 * Deliberately does NOT call `createProject` (which starts its own top-level
 * `withTransaction`) — the create + move happen inline against the same `tx`.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { ProjectId, TaskId } from "@cubby/schemas/identifiers";
import type {
  CreateProjectFromTasksInput,
  CreateProjectFromTasksOut,
} from "@cubby/schemas/project";
import { and, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { task } from "~/server/db/schema";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getTasksByIDs } from "~/server/repo/task";

import { getProjectByID } from "./crud";

export async function createProjectFromTasks(
  db: Database,
  input: CreateProjectFromTasksInput,
  actor: ActorContext,
): Promise<{
  output: CreateProjectFromTasksOut;
  projectEntityId: ProjectId;
  taskEntityIds: TaskId[];
}> {
  // Resolved live-only up front — the same "resolving IS the liveness check"
  // pattern as `createProject`.
  const taskIdsUuid = await resolveAllOrThrow(db, "task", input.taskIds);

  const { projectId, taskIds } = await withTransaction(db, async (tx) => {
    let parentProjectId: ProjectId | null = null;
    if (input.project.parentProjectId) {
      parentProjectId = await resolveOrThrow(
        tx,
        "project",
        input.project.parentProjectId,
      );
    }

    const created = await insertWithShortcode(tx, "project", {
      name: input.project.name,
      status: input.project.status,
      kind: input.project.kind,
      locations: input.project.locations,
      locationsMode:
        input.project.locationsMode ??
        (input.project.locations.length ? "explicit" : "inherit"),
      defaultTrade: input.project.defaultTrade,
      costEstimate: input.project.costEstimate,
      parentProjectId,
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
      where: and(inArray(task.id, taskIdsUuid), notDeleted(task)),
      columns: { id: true, projectId: true },
    });

    if (before.length > 0) {
      await tx
        .update(task)
        .set({ projectId: created.id, projectMode: "explicit" })
        .where(and(inArray(task.id, taskIdsUuid), notDeleted(task)));

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

  return {
    output: { project: projectOut, tasks },
    projectEntityId: projectId,
    taskEntityIds: taskIds,
  };
}
