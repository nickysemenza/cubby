import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { taskCompletionSchema, taskStatusSchema } from "@cubby/schemas/project";
import type { TaskFilters } from "@cubby/schemas/project";
import { rawTaskListItemOut } from "@cubby/schemas/work-raw-read";
import { isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  getDb,
  type ListReadIntent,
  relations,
  mapImages,
  brandJoinShortcode,
  resolveLiveJoinShortcode,
  resolveLiveJoinName,
} from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { wantsListGroup } from "~/server/generic/list/repo/list-projection";
import { parseCompleteListRead } from "~/server/generic/list/repo/list-read-adapters";

import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { hydrateTaskInheritanceRows } from "./task-project-inheritance";

// The effective project, subject product and assignee compile from their
// declared `via` paths through the inherited references.
export const taskScaffold = listScaffold("task", task, {
  derived: {
    effectiveTrade: effectiveFieldSql("task", "trade"),
    // Effective due date — `dueEndDate ?? dueDate` — so a ranged task still
    // inside its window isn't treated as overdue, matching the board/stat
    // tiles. A task with both due columns null falls out of any window.
    effectiveDueDate: effectiveTaskDueDateSql(),
    completion: sql`CASE WHEN ${task.status} = ${taskStatusSchema.enum.done}
      THEN ${taskCompletionSchema.enum.done}::text
      ELSE ${taskCompletionSchema.enum.open}::text END`,
    topLevel: isNull(task.parentTaskId),
  },
  scopes: { projectScope: () => projectScaffold },
});

/**
 * The complete WHERE for this entity's list. `getEntityCounts` calls it with
 * `{}` — see repo/dashboard.ts.
 */
export const buildTaskWhere = async (db: Database, filters: TaskFilters) =>
  taskScaffold.where(filters, {
    context: await taskScaffold.context(db, { filters, readIntent: "count" }),
  });

export const taskListRead = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  return taskScaffold.read(
    db,
    { filters, sorts, pagination, readIntent, projection },
    {
      load: (where) => {
        const declared = relations.task.withProject.with;
        const references =
          wantsListGroup(projection, "relations") ||
          wantsListGroup(projection, "derived");
        return getDb(db).query.task.findMany({
          where,
          with: {
            project: references ? declared.project : undefined,
            subjectProduct: references ? declared.subjectProduct : undefined,
            parentTask: references ? declared.parentTask : undefined,
            images: wantsListGroup(projection, "media")
              ? declared.images
              : undefined,
          },
        });
      },
      read: {
        media: true,
        bindings: (bind) => {
          const inherited = bind.batch(
            async ({ rows }) =>
              new Map(
                (await hydrateTaskInheritanceRows(db, rows)).map((row) => [
                  row.id,
                  row,
                ]),
              ),
          );
          const dependencies = bind.batch(({ rows }) =>
            taskDependencyIds(
              db,
              rows.map((row) => row.id),
            ),
          );
          const subtasks = bind.batch(({ rows }) =>
            taskSubtaskCounts(
              db,
              rows.map((row) => row.id),
            ),
          );
          return [
            inherited.fields(
              rawTaskListItemOut.pick({
                assigneeId: true,
                assigneeName: true,
                projectId: true,
                projectName: true,
                subjectProductId: true,
                subjectProductName: true,
                parentTaskId: true,
                parentTaskName: true,
              }),
              (row, loaded) => {
                const value = loaded.get(row.id);
                if (!value) throw new Error("Task inheritance was not loaded");
                return {
                  assigneeId: brandJoinShortcode(
                    "ledgerParty",
                    resolveLiveJoinShortcode(value.assignee ?? null),
                  ),
                  assigneeName: resolveLiveJoinName(value.assignee ?? null),
                  projectId: brandJoinShortcode(
                    "project",
                    resolveLiveJoinShortcode(value.project ?? null),
                  ),
                  projectName: resolveLiveJoinName(value.project ?? null),
                  subjectProductId: brandJoinShortcode(
                    "product",
                    resolveLiveJoinShortcode(value.subjectProduct ?? null),
                  ),
                  subjectProductName: resolveLiveJoinName(
                    value.subjectProduct ?? null,
                  ),
                  parentTaskId: value.parentTask
                    ? parseShortcodeFor("task", value.parentTask.shortcode)
                    : null,
                  parentTaskName: resolveLiveJoinName(value.parentTask ?? null),
                };
              },
            ),
            inherited.fields(
              rawTaskListItemOut.pick({ trade: true, fieldResolutions: true }),
              (row, loaded) => {
                const value = loaded.get(row.id);
                if (!value)
                  throw new Error("Task field resolution was not loaded");
                return {
                  trade: value.trade,
                  fieldResolutions: value.fieldResolutions,
                };
              },
            ),
            dependencies.fields(
              rawTaskListItemOut.pick({
                blockedByIds: true,
                blockingIds: true,
              }),
              (row, loaded) => ({
                blockedByIds: loaded.blockedBy.get(row.id) ?? [],
                blockingIds: loaded.blocking.get(row.id) ?? [],
              }),
            ),
            subtasks.fields(
              rawTaskListItemOut.pick({
                subtaskCount: true,
                doneSubtaskCount: true,
              }),
              (row, loaded) => ({
                subtaskCount: loaded.get(row.id)?.count ?? 0,
                doneSubtaskCount: loaded.get(row.id)?.doneCount ?? 0,
              }),
            ),
            bind(rawTaskListItemOut.pick({ images: true }), (row) => ({
              images: mapImages(
                (row.images ?? []).map((entry) => {
                  if (!("image" in entry))
                    throw new Error("Task media relation was not loaded");
                  return entry;
                }),
              ),
            })),
          ];
        },
      },
    },
  );
};

export const taskList = (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) =>
  parseCompleteListRead(
    rawTaskListItemOut,
    taskListRead(db, filters, sorts, pagination, { kind: "full" }, readIntent),
  );
