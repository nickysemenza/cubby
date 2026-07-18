import type { TaskId } from "@cubby/schemas/identifiers";
import type { TaskOut } from "@cubby/schemas/project";

/** Shape of a `task` row loaded with its (nullable) parent `project` name. */
type TaskRow = {
  id: TaskOut["id"];
  name: string;
  status: TaskOut["status"];
  projectId: TaskOut["projectId"];
  dueDate: string | null;
  dueEndDate: string | null;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; deletedAt: Date | null } | null;
};

export const dbTaskToAPI = (
  row: TaskRow,
  blockedByIds: TaskId[],
  blockingIds: TaskId[],
): TaskOut => ({
  id: row.id,
  name: row.name,
  status: row.status,
  projectId: row.projectId,
  dueDate: row.dueDate,
  dueEndDate: row.dueEndDate,
  category: row.category,
  // Backstop against a soft-deleted parent surfacing its name (see the
  // relations.ts note on to-one relations not supporting `where`) — in
  // practice unreachable, since a live task always blocks its project's
  // deletion (see project/crud.ts's PROJECT_HAS_TASKS guard).
  projectName:
    row.project && row.project.deletedAt === null ? row.project.name : null,
  blockedByIds,
  blockingIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
