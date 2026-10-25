import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export { job } from "./generated/entity-table-definitions.gen";

/** Stable invalidation policy; capture writers never update this row. */
export const jobInvalidation = pgTable("JobInvalidation", {
  key: text("key").primaryKey(),
  restartsPass: boolean("restartsPass").notNull(),
});

/**
 * A source transaction appends its own input, without a shared mutable revision.
 * A fresh claim acknowledges only captures visible in that transaction; a
 * capture committed later remains pending even if it started earlier.
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
