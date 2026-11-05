import { workWaitCause, workWaitCauses } from "@cubby/schemas/job";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  boolean,
  index,
  integer,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { sqlEnumConstant } from "./sql-enum";

export { job } from "./generated/entity-table-definitions.gen";

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
 * Fairness state a lane's pulls serialize on. A device pull locks its lane's
 * row, classifies the claim when it admits it, and advances or resets
 * `ownedStreak` in the claim's transaction: concurrent pulls cannot both take
 * Run work at backfill's turn, and a Run finishing later never reclassifies
 * services already counted.
 */
export const jobLaneAdmission = pgTable("JobLaneAdmission", {
  lane: text("lane").primaryKey(),
  ownedStreak: integer("ownedStreak").notNull().default(0),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

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
