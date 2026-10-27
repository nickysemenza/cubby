import { sql } from "drizzle-orm";

import { taskDueDatePrecedence } from "~/lib/task-dates";
import { task } from "~/server/db/retained-tables";

/** SQL counterpart of `effectiveTaskDueDate` for repository predicates. */

// Without an alias, column objects let relational queries rewrite the table alias.
export const effectiveTaskDueDateSql = (alias?: string) => {
  const columns = { end: task.dueEndDate, start: task.dueDate } as const;
  return sql`coalesce(${sql.join(
    taskDueDatePrecedence.map((key) =>
      alias
        ? sql`${sql.identifier(alias)}.${sql.identifier(columns[key].name)}`
        : sql`${columns[key]}`,
    ),
    sql`, `,
  )})`;
};

/**
 * Shape of a `task` row loaded with its (nullable) parent `project` name and
 * (nullable) parent `task` name. `parentTask` is optional — call sites that
 * don't load the relation (e.g. actionable.ts's batch fetch) just get a null
 * `parentTaskName`, which is correct there since subtask rows never surface.
 */
