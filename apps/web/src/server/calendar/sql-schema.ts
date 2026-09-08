import {
  integer,
  sqliteTable,
  text,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

import type { CalDavCollection } from "./caldav-types";

export const calendarMeta = sqliteTable("calendar_meta", {
  id: integer("id").primaryKey(),
  token: text("token"),
  generation: integer("generation").notNull().default(0),
  generatedAt: text("generated_at"),
  origin: text("origin"),
  dirtyReason: text("dirty_reason"),
  dirtySequence: integer("dirty_sequence").notNull().default(0),
});
export const calendarResources = sqliteTable(
  "calendar_resources",
  {
    generation: integer("generation").notNull(),
    collection: text("collection").$type<CalDavCollection>().notNull(),
    filename: text("filename").notNull(),
    uid: text("uid").notNull(),
    shortcode: text("shortcode").notNull(),
    body: text("body").notNull(),
    etag: text("etag").notNull(),
    start: text("start").notNull(),
    end: text("end").notNull(),
    projection: text("projection").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.generation, table.collection, table.filename],
    }),
    uniqueIndex("calendar_resource_uid").on(table.generation, table.uid),
    uniqueIndex("calendar_resource_entity").on(
      table.generation,
      table.shortcode,
    ),
    index("calendar_resource_dates").on(
      table.generation,
      table.collection,
      table.start,
      table.end,
    ),
  ],
);
export const calendarDocuments = sqliteTable("calendar_documents", {
  feed: text("feed").primaryKey(),
  body: text("body").notNull(),
  etag: text("etag").notNull(),
  generatedAt: text("generated_at").notNull(),
  revision: integer("revision").notNull(),
  itemCount: integer("item_count").notNull(),
});
export const calendarCredentials = sqliteTable("calendar_credentials", {
  owner: text("owner").primaryKey(),
  username: text("username").notNull().unique(),
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull(),
});
export const calendarPending = sqliteTable("calendar_pending", {
  operationId: text("operation_id").primaryKey(),
  fingerprint: text("fingerprint").notNull().unique(),
  payload: text("payload").notNull(),
  origin: text("origin").notNull(),
});
