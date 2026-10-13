import type { DataQuality } from "@cubby/schemas/data-quality";
import type {
  LedgerPartyId,
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
  brandJoinShortcode,
} from "~/server/repo/database-helpers";

/** SQL counterpart of `effectiveTaskDueDate` for repository predicates. */

export const effectiveTaskDueDateSql = () =>
  sql`coalesce(${task.dueEndDate}, ${task.dueDate})`;

/**
 * Shape of a `task` row loaded with its (nullable) parent `project` name and
 * (nullable) parent `task` name. `parentTask` is optional — call sites that
 * don't load the relation (e.g. actionable.ts's batch fetch) just get a null
 * `parentTaskName`, which is correct there since subtask rows never surface.
 */
type TaskRow<T extends TaskOut["trade"] | null = TaskOut["trade"]> = {
  id: TaskId;
  shortcode: string;
  name: string;
  status: TaskOut["status"];
  assigneeId: LedgerPartyId | null;
  assignee?: { name: string; shortcode: string; deletedAt: Date | null } | null;
  projectId: ProjectId | null;
  subjectProductId: ProductId | null;
  parentTaskId: TaskId | null;
  dueDate: string | null;
  dueEndDate: string | null;
  trade: T;
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

export const dbTaskToAPI = <
  Q extends DataQuality | undefined,
  T extends TaskOut["trade"] | null,
>(
  row: TaskRow<T>,
  blockedByIds: TaskShortcode[],
  blockingIds: TaskShortcode[],
  subtaskCount: number,
  doneSubtaskCount: number,
  dataQuality: Q,
): Omit<TaskOut, "dataQuality" | "trade"> & { dataQuality: Q; trade: T } => ({
  id: parseShortcodeFor("task", row.shortcode),
  assigneeId: brandJoinShortcode(
    "ledgerParty",
    resolveLiveJoinShortcode(row.assignee ?? null),
  ),
  assigneeName: resolveLiveJoinName(row.assignee ?? null),
  name: row.name,
  status: row.status,
  // Resolved through the join rather than the raw FK column — the permanent
  // public identity, same "shortcode never dies" reasoning as
  // `purchaseOut.vendorId`. `projectName` stays separately gated on the
  // parent's own liveness via `resolveLiveJoinName`.
  projectId: brandJoinShortcode(
    "project",
    resolveLiveJoinShortcode(row.project),
  ),
  subjectProductId: brandJoinShortcode(
    "product",
    resolveLiveJoinShortcode(row.subjectProduct),
  ),
  parentTaskId: row.parentTask
    ? parseShortcodeFor("task", row.parentTask.shortcode)
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
  dataQuality,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
