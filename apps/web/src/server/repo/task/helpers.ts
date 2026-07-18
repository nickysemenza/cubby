import type { TaskId } from "@cubby/schemas/identifiers";
import type { TaskOut } from "@cubby/schemas/project";
import { resolveLiveJoinName } from "~/server/repo/database-helpers";

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
  // In practice unreachable, since a live task always blocks its project's
  // deletion (see project/crud.ts's PROJECT_HAS_TASKS guard) — but
  // resolveLiveJoinName still backstops a soft-deleted parent's name leaking.
  projectName: resolveLiveJoinName(row.project),
  blockedByIds,
  blockingIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
