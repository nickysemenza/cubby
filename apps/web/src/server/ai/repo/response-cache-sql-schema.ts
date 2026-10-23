import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * `value` is client JSON or `chunked:<count>`; `expires_at` is retained but
 * ignored so rows written under the retired 30-day expiry stay readable.
 * Timestamps are epoch milliseconds.
 */
export const responses = sqliteTable("responses", {
  key: text("key").primaryKey(),
  value: text("value"),
  expiresAt: integer("expires_at"),
  claimToken: text("claim_token"),
  leaseExpiresAt: integer("lease_expires_at"),
});

export const responseChunks = sqliteTable(
  "response_chunks",
  {
    key: text("key").notNull(),
    seq: integer("seq").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.seq] })],
);
