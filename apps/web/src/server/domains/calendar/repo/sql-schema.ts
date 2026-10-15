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
  refreshFailedAt: text("refresh_failed_at"),
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
// Durable identities are independent of replaceable publication generations.
export const calendarIdentities = sqliteTable(
  "calendar_identities",
  {
    shortcode: text("shortcode").primaryKey(),
    entity: text("entity").$type<"task" | "meal">().notNull(),
    filename: text("filename").notNull(),
    uid: text("uid").notNull().unique(),
  },
  (table) => [
    uniqueIndex("calendar_identity_path").on(table.entity, table.filename),
  ],
);

// A marker blocks an uncertain resource; it contains no replayable mutation.
export const calendarUncertainWrites = sqliteTable(
  "calendar_uncertain_writes",
  {
    entity: text("entity").$type<"task" | "meal">().notNull(),
    collection: text("collection").$type<CalDavCollection>().notNull(),
    filename: text("filename").notNull(),
    uid: text("uid").notNull().unique(),
    shortcode: text("shortcode"),
    startedAt: text("started_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.entity, table.filename] })],
);
