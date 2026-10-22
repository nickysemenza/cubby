import { sql } from "drizzle-orm";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { task } from "~/server/db/schema";
import { defineEntityChecks } from "~/server/generic/data-quality/repo/registry";

type Task = typeof task;

// A task inherits its trade from an ancestor task or project, so the stored
// column alone undercounts. Relational lists rename Task, so read it by id.
const effectiveTrade = (t: Task) =>
  effectiveFieldSql("task", "trade", { id: sql`${t.id}` });

export const taskChecks = defineEntityChecks({
  entity: "task",
  table: task,
  checks: {
    task_due_range: {
      expected: (t: Task) =>
        sql`${t.dueDate} IS NOT NULL AND ${t.dueEndDate} IS NOT NULL`,
      missing: (t: Task) => sql`${t.dueEndDate} < ${t.dueDate}`,
    },
    task_trade: {
      missing: (t: Task) => sql`${effectiveTrade(t)} IS NULL`,
    },
  },
});
