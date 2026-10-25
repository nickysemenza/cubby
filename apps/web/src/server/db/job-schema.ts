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
  bigint,
  boolean,
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
    /** The `JobInvalidation` revision the current pass started from; claims own it. */
    observedRevision: bigint("observedRevision", { mode: "number" }),
    error: text("error"),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("Job_key_unique").on(table.key),
    index("Job_due_idx").on(table.state, table.availableAt, table.priority),
    index("Job_run_idx").on(table.runId),
    index("Job_subject_idx").on(table.subjectKind, table.subjectId),
    index("Job_kind_claimed_idx").on(table.kind, table.lastClaimedAt),
    // Device pulls, lane counts, the watchdog and retention select by kind and state.
    index("Job_kind_state_idx").on(table.kind, table.state, table.availableAt),
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

/**
 * Durable source invalidation of a long-lived Job, kept apart from its
 * execution row: captures bump `revision` here and never write `Job`, and
 * claims, renewals and publication never write this row. A Job whose
 * `observedRevision` trails it is due; `restartsPass` says whether a moved
 * revision restarts a pass in progress or waits for it to finish.
 */
export const jobInvalidation = pgTable("JobInvalidation", {
  key: text("key").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  restartsPass: boolean("restartsPass").notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});
