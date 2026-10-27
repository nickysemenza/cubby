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
 * across drains, so `(target, ref)` identifies an item. Items carry retry
 * state only: the drain Job's lease fences every claimed item, and a
 * publication clears an item only while its ticket is unchanged.
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
  },
  (t) => [
    // The retired automaticFields family must never be marked again (0045).
    check(
      "WorkItem_no_retired_automatic_fields",
      sql`split_part(${t.target}, '@', 1) NOT LIKE '%.automaticFields'`,
    ),
    primaryKey({ columns: [t.target, t.ref] }),
    index("WorkItem_ready_idx").on(t.drain, t.priority, t.readyAt),
  ],
);
