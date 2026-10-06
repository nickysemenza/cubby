import { sql } from "drizzle-orm";

import { task } from "~/server/db/schema";
import { effectiveTaskTradeSql } from "~/server/repo/task-project-inheritance";

import { defineEntityChecks } from "../registry";

type Task = typeof task;

// A task inherits its trade from a parent task or project, so the stored
// column alone undercounts. Relational lists rename Task, so evaluate the
// inheritance under an alias local to this subquery.
const effectiveTrade = (t: Task) => sql`(
  SELECT ${effectiveTaskTradeSql("dq_task_trade")} FROM "Task" dq_task_trade
  WHERE dq_task_trade."id" = ${t.id}
)`;

export const taskChecks = defineEntityChecks({
  entity: "task",
  table: task,
  checks: {
    task_due_date: {
      // Due dates are optional (`later` and open-ended work have none); only
      // a recorded end of the due window implies a start that is missing.
      expected: (t: Task) => sql`${t.dueEndDate} IS NOT NULL`,
      missing: (t: Task) => sql`${t.dueDate} IS NULL`,
    },
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
