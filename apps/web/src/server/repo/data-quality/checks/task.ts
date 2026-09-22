import { sql } from "drizzle-orm";

import { task } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Task = typeof task;

export const taskChecks = defineEntityChecks({
  entity: "task",
  table: task,
  checks: {
    task_due_date: {
      // `done` is the only terminal task status (`taskStatusValues`,
      // task-fields.ts) — every other status still expects a due date.
      expected: (t: Task) => sql`${t.status} <> 'done'`,
      missing: (t: Task) => sql`${t.dueDate} IS NULL`,
    },
    task_trade: {
      missing: (t: Task) => sql`${t.trade} IS NULL`,
    },
  },
});
