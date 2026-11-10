import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Published whole-population list summaries: totals and evidence metrics for
 * one entity's filtered population. Rebuildable from the records, so a
 * publication replaces its row; pages read it instead of recomputing the
 * catalog per request.
 */
export const listSummary = pgTable(
  "ListSummary",
  {
    entity: text("entity").notNull(),
    /** Hash of the population inputs: filters, scope and reader. */
    key: text("key").notNull(),
    /** `{ totals, metrics }` as the live read returns them. */
    summary: jsonb("summary").notNull(),
    /** The instant the summary's reads began. */
    publishedAt: timestamp("publishedAt", { mode: "date" }).notNull(),
    /** The latest member write this summary has not read. */
    dirtyAt: timestamp("dirtyAt", { mode: "date" }),
  },
  (t) => [
    primaryKey({ columns: [t.entity, t.key] }),
    index("ListSummary_publishedAt_idx").on(t.publishedAt),
  ],
);
