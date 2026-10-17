import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  taskCompletionSchema,
  taskListItemOut,
  taskStatusSchema,
} from "@cubby/schemas/project";
import type { TaskFilters } from "@cubby/schemas/project";
import { and, isNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { projectListRows } from "~/entity/model/list-read-schema";
import type { Database } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  relations,
  uuidArrayParam,
} from "~/server/db/helpers";
import { product, task } from "~/server/db/schema";
import { matchingEmbeddedProjectIds } from "~/server/domains/project/repo/dashboard-shared";
import {
  dbTaskToAPI,
  effectiveTaskDueDateSql,
} from "~/server/domains/task/repo/helpers";
import { withDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  loadListGroup,
  wantsListGroup,
} from "~/server/generic/list/repo/list-projection";
import { parseCompleteListRead } from "~/server/generic/list/repo/list-read-adapters";

import { taskDependencyIds, taskSubtaskCounts } from "./crud";
import {
  effectiveTaskTradeSql,
  hydrateTaskInheritanceRows,
} from "./task-project-inheritance";

const qb = new QueryBuilder();

// The effective project, subject product and assignee compile from their
// declared `via` paths through the inherited references.
const taskScaffold = listScaffold("task", task, {
  derived: {
    effectiveTrade: effectiveTaskTradeSql(),
    // Effective due date — `dueEndDate ?? dueDate` — so a ranged task still
    // inside its window isn't treated as overdue, matching the board/stat
    // tiles. A task with both due columns null falls out of any window.
    effectiveDueDate: effectiveTaskDueDateSql(),
    completion: sql`CASE WHEN ${task.status} = ${taskStatusSchema.enum.done}
      THEN ${taskCompletionSchema.enum.done}::text
      ELSE ${taskCompletionSchema.enum.open}::text END`,
    topLevel: isNull(task.parentTaskId),
    search: (term) =>
      or(
        formatSearchTerm(task.name, term),
        sql`${effectiveFieldSql("task", "subjectProductId")} IN ${qb
          .select({ id: product.id })
          .from(product)
          .where(
            and(notDeleted(product), formatSearchTerm(product.name, term)),
          )}`,
      ),
  },
});

/**
 * The complete WHERE for this entity's list. `getEntityCounts` calls it with
 * `{}` — see repo/dashboard.ts. `projectScope` is a project page's embedded
 * scope (the projects its own filters select), not a list filter.
 */
export const buildTaskWhere = async (db: Database, filters: TaskFilters) => {
  const scopedProjectIds = filters.projectScope
    ? await matchingEmbeddedProjectIds(db, filters.projectScope)
    : null;
  return and(
    taskScaffold.where(filters),
    scopedProjectIds
      ? scopedProjectIds.length > 0
        ? sql`${effectiveFieldSql("task", "projectId")} = ANY(${uuidArrayParam(scopedProjectIds)})`
        : sql`false`
      : undefined,
  );
};

export const taskListRead = async (
  db: Database,
  filters: TaskFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const whereClause = await buildTaskWhere(db, filters);
  return taskScaffold.list(
    db,
    { filters, sorts, pagination, readIntent, projection },
    {
      where: whereClause,
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
      hydrate: async (rows) => {
        if (projection.kind === "base")
          return projectListRows(
            "task",
            rows.map((row) => ({ ...row, id: row.shortcode })),
            projection,
          );
        const ids = rows.map((r) => r.id);
        const [deps, subtaskCounts, dataQualities, hydratedRows] =
          await Promise.all([
            loadListGroup(projection, "relations", () =>
              taskDependencyIds(db, ids),
            ),
            loadListGroup(projection, "derived", () =>
              taskSubtaskCounts(db, ids),
            ),
            loadListGroup(projection, "quality", () =>
              loadDataQualities(db, "task", ids),
            ),
            loadListGroup(projection, ["relations", "derived"], () =>
              hydrateTaskInheritanceRows(db, rows),
            ),
          ]);
        const mapRow = (row: (typeof rows)[number]) => {
          const counts = subtaskCounts?.get(row.id);
          return dbTaskToAPI(
            {
              ...row,
              project: row.project ?? null,
              subjectProduct: row.subjectProduct ?? null,
              images:
                row.images?.map((image) => {
                  if (!("image" in image))
                    throw new Error("Task media relation was not loaded");
                  return image;
                }) ?? [],
            },
            deps?.blockedBy.get(row.id) ?? [],
            deps?.blocking.get(row.id) ?? [],
            counts?.count ?? 0,
            counts?.doneCount ?? 0,
            // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
            dataQualities?.get(row.id),
          );
        };
        const selectedRows = hydratedRows ?? rows;
        const mapped = wantsListGroup(projection, "media")
          ? await withDisplayImages(db, "task", selectedRows, mapRow)
          : selectedRows.map(mapRow);
        return projectListRows("task", mapped, projection);
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
    taskListItemOut,
    taskListRead(db, filters, sorts, pagination, { kind: "full" }, readIntent),
  );
