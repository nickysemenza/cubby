import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { taskCompletionSchema, taskStatusSchema } from "@cubby/schemas/project";
import { rawTaskListItemOut } from "@cubby/schemas/work-raw-read";
import { inArray, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  brandJoinShortcode,
  databaseForTransaction,
  isTransaction,
  mapImages,
  relations,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
  unwrapDb,
} from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { taskSearch } from "~/server/domains/task/repo/search-read-task";
import { listScaffold } from "~/server/generic/list/repo/list";

import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import { hydrateTaskInheritanceRows } from "./task-project-inheritance";

// The inheritance and edge readers take a Database; a record read inside a
// write sees the transaction's rows.
const readDatabase = (db: Database | DrizzleTransaction): Database =>
  isTransaction(db) ? databaseForTransaction(db) : db;

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
  read: {
    search: taskSearch,
    media: true,
    bindings: (bind) => {
      const declared = relations.task.withProject.with;
      const related = bind.ids(
        async ({ db, ids }) =>
          new Map(
            (ids.length === 0
              ? []
              : await unwrapDb(db).query.task.findMany({
                  where: inArray(
                    task.id,
                    ids.map((id) => parseEntityId("task", id)),
                  ),
                  columns: { id: true },
                  with: {
                    parentTask: declared.parentTask,
                    images: declared.images,
                  },
                })
            ).map((row) => [row.id, row]),
          ),
      );
      const inherited = bind.batch(
        async ({ db, rows }) =>
          new Map(
            (await hydrateTaskInheritanceRows(readDatabase(db), rows)).map(
              (row) => [row.id, row],
            ),
          ),
      );
      const dependencies = bind.batch(({ db, rows }) =>
        taskDependencyIds(
          readDatabase(db),
          rows.map((row) => row.id),
        ),
      );
      const subtasks = bind.batch(({ db, rows }) =>
        taskSubtaskCounts(
          readDatabase(db),
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
            };
          },
        ),
        related.fields(
          rawTaskListItemOut.pick({ parentTaskId: true, parentTaskName: true }),
          (row, loaded) => {
            const parent = loaded.get(row.id)?.parentTask ?? null;
            return {
              parentTaskId: parent
                ? parseShortcodeFor("task", parent.shortcode)
                : null,
              parentTaskName: resolveLiveJoinName(parent),
            };
          },
        ),
        inherited.fields(
          rawTaskListItemOut.pick({ trade: true, fieldResolutions: true }),
          (row, loaded) => {
            const value = loaded.get(row.id);
            if (!value) throw new Error("Task field resolution was not loaded");
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
        related.fields(
          rawTaskListItemOut.pick({ images: true }),
          (row, loaded) => ({
            images: mapImages(loaded.get(row.id)?.images ?? []),
          }),
        ),
      ];
    },
  },
});
