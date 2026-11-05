import type { RunId } from "@cubby/schemas/identifiers";
import {
  jobState,
  jobWaitReason,
  workWaitCause,
  workWaitCauses,
  type JobPayload,
  type JobState,
  type JobWaitReason,
} from "@cubby/schemas/job";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { run } from "./generated/entity-table-definitions.gen";
import { sqlEnumConstant } from "./sql-enum";

/**
 * Durable background work with no natural owner row. It is not an entity: it has no
 * public code or identity, and nothing links to it.
 */
export const job = pgTable(
  "Job",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").$type<JobState>().notNull().default("queued"),
    runId: uuid("runId")
      .$type<RunId>()
      .references((): AnyPgColumn => run.id, { onDelete: "set null" }),
    waitReason: text("waitReason").$type<JobWaitReason>(),
    waitUntil: timestamp("waitUntil", { mode: "date" }),
    input: jsonb("input").$type<JobPayload>().notNull(),
    cursor: jsonb("cursor").$type<JobPayload>(),
    result: jsonb("result").$type<JobPayload>(),
    generation: integer("generation").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").default(3),
    availableAt: timestamp("availableAt", { mode: "date" })
      .notNull()
      .default(sql`now()`),
    leaseToken: uuid("leaseToken"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
    lastClaimedAt: timestamp("lastClaimedAt", { mode: "date" }),
    error: text("error"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("Job_key_unique").on(table.key),
    index("Job_due_idx").on(table.state, table.availableAt, table.priority),
    index("Job_run_idx").on(table.runId),
    index("Job_kind_claimed_idx").on(table.kind, table.lastClaimedAt),
    index("Job_kind_state_idx").on(table.kind, table.state, table.availableAt),
    check(
      "Job_state_check",
      sql.raw(
        `"state" IN (${jobState.options.map((value) => `'${value}'`).join(", ")})`,
      ),
    ),
    check(
      "Job_kind_retired_check",
      sql`${table.kind} NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup', 'ai.evaluation', 'assessment.correction', 'ai-refresh.activate')`,
    ),
    check(
      "Job_waitReason_check",
      sql`${table.waitReason} IN (${sql.join(
        jobWaitReason.options.map((value) =>
          sqlEnumConstant(jobWaitReason, value),
        ),
        sql`, `,
      )})`,
    ),
    check(
      "Job_attempts_check",
      sql`${table.attempts} >= 0 AND coalesce(${table.maxAttempts}, 1) > 0`,
    ),
  ],
);

/**
 * A source transaction appends its own wake, without a shared mutable revision.
 * A claim acknowledges only captures visible in that transaction; a capture
 * committed later stays pending and makes the Job due again after its pass.
 */
export const jobInvalidationCapture = pgTable(
  "JobInvalidationCapture",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    capturedAt: timestamp("capturedAt", { mode: "date" }).notNull(),
    observed: boolean("observed").notNull().default(false),
  },
  (table) => [
    index("JobInvalidationCapture_pending_idx")
      .on(table.key, table.capturedAt)
      .where(sql`NOT ${table.observed}`),
  ],
);

/**
 * Tickets order work items across all drains. A per-row counter restarts
 * after a delete and reinsert, so a slow drain holding an old number could
 * clear newer work (ABA); a sequence value never repeats.
 */
export const workTicket = pgSequence("WorkTicket");

/**
 * Pending work a drain Job claims in pages (docs/jobs.md#coarse-jobs-and-work-items). `drain` is
 * the owning Job key; `target` names the work family (derived targets are
 * `<entity>.<key>` or `<entity>.<key>@<column>` fanout marks) and is unique
 * across drains, so `(target, ref)` identifies an item. The drain Job's lease
 * fences every claimed item, and publication clears an item only while its
 * ticket is unchanged. Execution columns are observations, valid only for
 * their exact ticket and current live Job lease; they grant no authority.
 */
export const workItem = pgTable(
  "WorkItem",
  {
    drain: text("drain").notNull().default("derived:drain"),
    target: text("target").notNull(),
    ref: uuid("ref").notNull(),
    ticket: bigint("ticket", { mode: "number" })
      .notNull()
      .default(sql`nextval('"WorkTicket"')`),
    /** Lower drains first: 0 = member or Run demand, 1 = background, 2 = reconcile or backfill. */
    priority: integer("priority").notNull().default(0),
    dirtiedAt: timestamp("dirtiedAt", { mode: "date" }).notNull().defaultNow(),
    readyAt: timestamp("readyAt", { mode: "date" }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    executionLeaseToken: uuid("executionLeaseToken"),
    executionTicket: bigint("executionTicket", { mode: "number" }),
    executionStartedAt: timestamp("executionStartedAt", { mode: "date" }),
    reason: text("reason"),
    /** An explicit attempt-free wait; `readyAt` is its deadline and a new ticket clears it. */
    waitCause: text("waitCause", { enum: workWaitCauses }),
    /** Orders the wait's retry cadence, because a wait does not spend `attempts`. */
    waitStartedAt: timestamp("waitStartedAt", { mode: "date" }),
    /** Last dependent enrolled by a paged fanout; a new source ticket restarts it. */
    fanoutAfter: uuid("fanoutAfter"),
  },
  (t) => [
    check(
      "WorkItem_wait_check",
      sql`(${t.waitCause} IS NULL AND ${t.waitStartedAt} IS NULL) OR (${t.waitCause} IN (${sql.join(
        workWaitCauses.map((cause) => sqlEnumConstant(workWaitCause, cause)),
        sql`, `,
      )}) AND ${t.waitCause} IS NOT NULL AND ${t.waitStartedAt} IS NOT NULL)`,
    ),
    // The retired automaticFields family must never be marked again (0045).
    check(
      "WorkItem_no_retired_automatic_fields",
      sql`split_part(${t.target}, '@', 1) NOT LIKE '%.automaticFields'`,
    ),
    // These families moved to their owners' rows: a late write must fail, not strand.
    check(
      "WorkItem_retired_target_check",
      sql`${t.target} NOT IN ('embedding.refresh', 'embedding.cleanup', 'ai.evaluation')`,
    ),
    primaryKey({ columns: [t.target, t.ref] }),
    index("WorkItem_ready_idx").on(t.drain, t.priority, t.readyAt),
    index("WorkItem_target_prefix_idx").on(sql`${t.target} COLLATE "C"`),
  ],
);
