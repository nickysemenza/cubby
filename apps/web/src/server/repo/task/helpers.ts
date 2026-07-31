import {
  type TaskId,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import type { TaskOut } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import { task } from "~/server/db/schema";
import {
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";

/** SQL counterpart of `effectiveTaskDueDate` for repository predicates. */

/** Brand a resolved join shortcode, preserving null for an absent/deleted parent. */
const toProductShortcode = (code: string | null) =>
  code === null ? null : unsafeProductShortcode(code);

const toProjectShortcode = (code: string | null) =>
  code === null ? null : unsafeProjectShortcode(code);

export const effectiveTaskDueDateSql = () =>
  sql`coalesce(${task.dueEndDate}, ${task.dueDate})`;

/**
 * Shape of a `task` row loaded with its (nullable) parent `project` name and
 * (nullable) parent `task` name. `parentTask` is optional — call sites that
 * don't load the relation (e.g. actionable.ts's batch fetch) just get a null
 * `parentTaskName`, which is correct there since subtask rows never surface.
 */
type TaskRow = {
  id: TaskOut["id"];
  shortcode: string;
  name: string;
  status: TaskOut["status"];
  projectId: TaskOut["projectId"];
  subjectProductId: TaskOut["subjectProductId"];
  parentTaskId: TaskOut["parentTaskId"];
  dueDate: string | null;
  dueEndDate: string | null;
  trade: TaskOut["trade"];
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; shortcode: string; deletedAt: Date | null } | null;
  subjectProduct: {
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  } | null;
  parentTask?: { name: string; deletedAt: Date | null } | null;
};

export const dbTaskToAPI = (
  row: TaskRow,
  blockedByIds: TaskId[],
  blockingIds: TaskId[],
  subtaskCount = 0,
  doneSubtaskCount = 0,
): TaskOut => ({
  id: row.id,
  shortcode: unsafeTaskShortcode(row.shortcode),
  name: row.name,
  status: row.status,
  projectId: row.projectId,
  subjectProductId: row.subjectProductId,
  parentTaskId: row.parentTaskId,
  dueDate: row.dueDate,
  dueEndDate: row.dueEndDate,
  trade: row.trade,
  sortOrder: row.sortOrder,
  // In practice unreachable, since a live task always blocks its project's
  // deletion (see project/crud.ts's PROJECT_HAS_TASKS guard) — but
  // resolveLiveJoinName still backstops a soft-deleted parent's name leaking.
  projectName: resolveLiveJoinName(row.project),
  projectShortcode: toProjectShortcode(resolveLiveJoinShortcode(row.project)),
  subjectProductName: resolveLiveJoinName(row.subjectProduct),
  subjectProductShortcode: toProductShortcode(
    resolveLiveJoinShortcode(row.subjectProduct),
  ),
  parentTaskName: row.parentTask ? resolveLiveJoinName(row.parentTask) : null,
  blockedByIds,
  blockingIds,
  subtaskCount,
  doneSubtaskCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
