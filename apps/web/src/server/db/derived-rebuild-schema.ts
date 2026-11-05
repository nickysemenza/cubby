import {
  boolean,
  doublePrecision,
  integer,
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
  finishedAt: timestamp("finishedAt", { mode: "date" }),
  token: uuid("token"),
  leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
  failures: integer("failures").notNull().default(0),
  error: text("error"),
  durationsMs: doublePrecision("durationsMs").array().notNull().default([]),
});
