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
import { projectCreateInput } from "@cubby/schemas/project";
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
import { normalizeRecordEmoji } from "~/server/repo/entity-emoji";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getTasksByIDs } from "~/server/repo/task/crud";

import { getProjectByID } from "./crud";
import { setProjectExternalUrls } from "./external-links";

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
  const projectInput = projectCreateInput.parse(
    normalizeRecordEmoji("project", input.project),
  );

  const { projectId, taskIds } = await withTransaction(db, async (tx) => {
    let parentProjectId: ProjectId | null = null;
    if (projectInput.parentProjectId) {
      parentProjectId = await resolveOrThrow(
        tx,
        "project",
        projectInput.parentProjectId,
      );
    }

    const created = await insertWithShortcode(tx, "project", {
      name: projectInput.name,
      status: projectInput.status,
      kind: projectInput.kind,
      locations: projectInput.locations,
      locationsMode:
        projectInput.locationsMode ??
        (projectInput.locations.length ? "explicit" : "inherit"),
      defaultTrade: projectInput.defaultTrade,
      costEstimate: projectInput.costEstimate,
      parentProjectId,
      startDate: projectInput.startDate,
      endDate: projectInput.endDate,
      emoji: projectInput.emoji ?? null,
      notes: projectInput.notes,
    });
    await setProjectExternalUrls(tx, created.id, {
      googleDriveFolderUrl: projectInput.googleDriveFolderUrl,
      notionPageUrl: projectInput.notionPageUrl,
    });
    await logAuditEntry(tx, actor, {
      entityKind: "project",
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
            entityKind: "task",
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
