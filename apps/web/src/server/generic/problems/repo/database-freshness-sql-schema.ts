import { sql } from "drizzle-orm";
import { check, integer, real, sqliteTable } from "drizzle-orm/sqlite-core";

export const freshness = sqliteTable(
  "freshness",
  {
    id: integer("id").primaryKey(),
    lastWriteAt: real("last_write_at").notNull(),
  },
  (table) => [check("freshness_singleton", sql`${table.id} = 1`)],
);
