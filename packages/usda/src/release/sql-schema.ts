import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const releaseState = sqliteTable(
  "release_state",
  {
    id: integer("id").primaryKey(),
    release: text("release").notNull(),
    state: text("state", { enum: ["loading", "ready", "failed"] }).notNull(),
    manifest: text("manifest"),
    next_shard: integer("next_shard").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    started_at: text("started_at").notNull(),
    ready_at: text("ready_at"),
  },
  (table) => [check("release_state_singleton", sql`${table.id} = 1`)],
);

export const food = sqliteTable(
  "food",
  {
    fdc_id: integer("fdc_id").primaryKey(),
    data_type: text("data_type").notNull(),
    description: text("description").notNull(),
    barcode_key: text("barcode_key"),
    ndb_number: integer("ndb_number"),
    summary: text("summary").notNull(),
  },
  (table) => [
    index("food_barcode_key").on(table.barcode_key),
    index("food_ndb_number").on(table.ndb_number),
    index("food_description").on(table.description),
    index("food_data_type").on(table.data_type, table.description),
  ],
);

// WITHOUT ROWID is retained in the baseline SQL; Drizzle Kit has no declaration
// for that physical layout. Its primary key and value encoding stay unchanged.
export const foodAlias = sqliteTable("food_alias", {
  fdc_id: integer("fdc_id").primaryKey(),
  current_fdc_id: integer("current_fdc_id").notNull(),
});
