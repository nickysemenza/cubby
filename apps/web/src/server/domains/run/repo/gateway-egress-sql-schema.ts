import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Timestamps are epoch milliseconds.
export const starts = sqliteTable(
  "starts",
  {
    bucket: text("bucket").notNull(),
    started: integer("started").notNull(),
  },
  (table) => [index("starts_time").on(table.started)],
);

export const permits = sqliteTable("permits", {
  token: text("token").primaryKey(),
  bucket: text("bucket").notNull(),
  deadline: integer("deadline").notNull(),
});

export const cooldowns = sqliteTable("cooldowns", {
  bucket: text("bucket").primaryKey(),
  untilMs: integer("until_ms").notNull(),
});

// A provider credit refusal (ADR 0017) refuses credit admission until
// `until_ms`, except one probe per six-hour window; `probe_window` is the
// start of the window whose probe is spent.
export const creditRefusals = sqliteTable("credit_refusals", {
  bucket: text("bucket").primaryKey(),
  untilMs: integer("until_ms").notNull(),
  reason: text("reason").notNull(),
  probeWindow: integer("probe_window").notNull(),
});

// Bumped by every reset and every recorded refusal. A credit response is
// observed only under the epoch its request was admitted in, so a request in
// flight across a reset cannot re-record the refusal it cleared, and an older
// success cannot clear a newer refusal.
export const creditEpochs = sqliteTable("credit_epochs", {
  bucket: text("bucket").primaryKey(),
  epoch: integer("epoch").notNull(),
});
