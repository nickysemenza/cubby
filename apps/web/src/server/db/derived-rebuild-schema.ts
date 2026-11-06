import type { WorkActivity } from "@cubby/schemas/job";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const DERIVED_REBUILD_KEY = "deterministic";
export const DERIVED_REBUILD_LEASE_SECONDS = 120;

/** One resumable deterministic pass, never per-record execution state. */
export const derivedRebuild = pgTable("DerivedRebuild", {
  key: text("key").primaryKey(),
  running: boolean("running").notNull().default(false),
  target: text("target"),
  afterId: uuid("afterId"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  startedAt: timestamp("startedAt", { mode: "date" }),
  lastMovementAt: timestamp("lastMovementAt", { mode: "date" }),
  cleanAt: timestamp("cleanAt", { mode: "date" }),
  pages: integer("pages").notNull().default(0),
  processedRecords: integer("processedRecords").notNull().default(0),
  failedPages: integer("failedPages").notNull().default(0),
  history: jsonb("history")
    .$type<WorkActivity["rebuild"]["history"]>()
    .notNull()
    .default([]),
  finishedAt: timestamp("finishedAt", { mode: "date" }),
  token: uuid("token"),
  leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
  failures: integer("failures").notNull().default(0),
  cursorAttempts: integer("cursorAttempts").notNull().default(0),
  passFailures: integer("passFailures").notNull().default(0),
  error: text("error"),
  durationsMs: doublePrecision("durationsMs").array().notNull().default([]),
});
