import type { RunId } from "@cubby/schemas/identifiers";
import {
  jobState,
  jobWaitReason,
  type JobWaitReason,
  type JobPayload,
  type JobState,
} from "@cubby/schemas/job";
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
    subjectKind: text("subjectKind"),
    subjectId: text("subjectId"),
    waitReason: text("waitReason").$type<JobWaitReason>(),
    waitUntil: timestamp("waitUntil", { mode: "date" }),
    input: jsonb("input").$type<JobPayload>().notNull(),
    state: text("state").$type<JobState>().notNull().default("queued"),
    generation: integer("generation").notNull().default(1),
    cursor: jsonb("cursor").$type<JobPayload>(),
    result: jsonb("result").$type<JobPayload>(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    recoveryTimeoutMs: integer("recoveryTimeoutMs"),
    lastUsefulProgressAt: timestamp("lastUsefulProgressAt", { mode: "date" }),
    availableAt: timestamp("availableAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("leaseToken"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
    /** Set by each claim; the fair drain serves the least recently claimed kind first. */
    lastClaimedAt: timestamp("lastClaimedAt", { mode: "date" }),
    error: text("error"),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("Job_key_unique").on(table.key),
    index("Job_due_idx").on(table.state, table.availableAt, table.priority),
    index("Job_run_idx").on(table.runId),
    index("Job_subject_idx").on(table.subjectKind, table.subjectId),
    index("Job_kind_claimed_idx").on(table.kind, table.lastClaimedAt),
    check(
      "Job_waitReason_check",
      sql`${table.waitReason} IN (${sql.join(
        jobWaitReason.options.map((reason) =>
          sqlEnumConstant(jobWaitReason, reason),
        ),
        sql`,`,
      )})`,
    ),
    check(
      "Job_subject_check",
      sql`(${table.subjectKind} IS NULL) = (${table.subjectId} IS NULL)`,
    ),
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
