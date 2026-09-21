import type {
  ProductId,
  ProjectId,
  TaskId,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { TaskOut } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";

import { task } from "~/server/db/schema";
import {
  mapImages,
  type MappableImageRecord,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";

/** SQL counterpart of `effectiveTaskDueDate` for repository predicates. */

/** Brand a resolved join shortcode, preserving null for an absent/deleted parent. */
const toProductShortcode = (code: string | null) =>
  code === null ? null : parseShortcodeFor("product", code);

const toProjectShortcode = (code: string | null) =>
  code === null ? null : parseShortcodeFor("project", code);

const toTaskShortcode = (code: string | null) =>
  code === null ? null : parseShortcodeFor("task", code);

export const effectiveTaskDueDateSql = () =>
  sql`coalesce(${task.dueEndDate}, ${task.dueDate})`;

/**
 * Shape of a `task` row loaded with its (nullable) parent `project` name and
 * (nullable) parent `task` name. `parentTask` is optional — call sites that
 * don't load the relation (e.g. actionable.ts's batch fetch) just get a null
 * `parentTaskName`, which is correct there since subtask rows never surface.
 */
type TaskRow = {
  id: TaskId;
  shortcode: string;
  name: string;
  status: TaskOut["status"];
  projectId: ProjectId | null;
  subjectProductId: ProductId | null;
  parentTaskId: TaskId | null;
  dueDate: string | null;
  dueEndDate: string | null;
  trade: TaskOut["trade"];
  fieldResolutions?: TaskOut["fieldResolutions"];
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; shortcode: string; deletedAt: Date | null } | null;
  subjectProduct: {
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  } | null;
  parentTask?: {
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  } | null;
  images: Array<{ image: MappableImageRecord; deletedAt: Date | null }>;
};

export const dbTaskToAPI = (
  row: TaskRow,
  blockedByIds: TaskShortcode[],
  blockingIds: TaskShortcode[],
  subtaskCount = 0,
  doneSubtaskCount = 0,
): TaskOut => ({
  id: parseShortcodeFor("task", row.shortcode),
  name: row.name,
  status: row.status,
  // Resolved through the join rather than the raw FK column — the permanent
  // public identity, same "shortcode never dies" reasoning as
  // `purchaseOut.vendorId`. `projectName` stays separately gated on the
  // parent's own liveness via `resolveLiveJoinName`.
  projectId: toProjectShortcode(resolveLiveJoinShortcode(row.project)),
  subjectProductId: toProductShortcode(
    resolveLiveJoinShortcode(row.subjectProduct),
  ),
  parentTaskId: row.parentTask
    ? toTaskShortcode(row.parentTask.shortcode)
    : null,
  dueDate: row.dueDate,
  dueEndDate: row.dueEndDate,
  trade: row.trade,
  fieldResolutions: row.fieldResolutions,
  sortOrder: row.sortOrder,
  // In practice unreachable, since a live task always blocks its project's
  // deletion (see project/crud.ts's PROJECT_HAS_TASKS guard) — but
  // resolveLiveJoinName still backstops a soft-deleted parent's name leaking.
  projectName: resolveLiveJoinName(row.project),
  subjectProductName: resolveLiveJoinName(row.subjectProduct),
  parentTaskName: row.parentTask ? resolveLiveJoinName(row.parentTask) : null,
  blockedByIds,
  blockingIds,
  subtaskCount,
  doneSubtaskCount,
  images: mapImages(row.images),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
