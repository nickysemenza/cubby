import type { RunId } from "@cubby/schemas/identifiers";
import { jobState, type JobPayload, type JobState } from "@cubby/schemas/job";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { run } from "./generated/entity-table-definitions.gen";
import { baseTimestamps, pkUuid } from "./schema-primitives";
import { sqlEnumConstant } from "./sql-enum";

/** Execution state belongs here; domain rows retain facts and external receipts. */
export const job = pgTable(
  "Job",
  {
    id: pkUuid(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    runId: uuid("runId")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    input: jsonb("input").$type<JobPayload>().notNull(),
    state: text("state").$type<JobState>().notNull().default("queued"),
    generation: integer("generation").notNull().default(1),
    cursor: jsonb("cursor").$type<JobPayload>(),
    result: jsonb("result").$type<JobPayload>(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    availableAt: timestamp("availableAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("leaseToken"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
    error: text("error"),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("Job_key_unique").on(table.key),
    index("Job_due_idx").on(table.state, table.availableAt, table.priority),
    index("Job_run_idx").on(table.runId),
    check(
      "Job_state_check",
      sql`${table.state} IN (${sql.join(
        jobState.options.map((state) => sqlEnumConstant(jobState, state)),
        sql`,`,
      )})`,
    ),
    check(
      "Job_attempts_check",
      sql`${table.attempts} >= 0 AND ${table.maxAttempts} > 0`,
    ),
  ],
);
