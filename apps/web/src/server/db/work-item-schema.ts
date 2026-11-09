import type { ProjectAttentionReport } from "@cubby/schemas/project";
import type { IncompleteWorkDiagnosticSource } from "@cubby/schemas/work-diagnostic-facts";
import {
  boolean,
  date,
  doublePrecision,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The household's published Work queue rows: the composed sources' union,
 * deferrals applied and owners routed. Rebuildable from its sources, so a
 * publication replaces every row; filters, counts and paging apply on read.
 */
export const workItem = pgTable(
  "WorkItem",
  {
    key: text("key").notNull(),
    /** Missing-input rows report coverage; they are never actionable. */
    inputIncomplete: boolean("inputIncomplete").notNull(),
    source: text("source").notNull(),
    entity: text("entity"),
    id: text("id"),
    name: text("name").notNull(),
    family: text("family").notNull(),
    executor: text("executor").notNull(),
    reason: text("reason").notNull(),
    reasonKeys: text("reasonKeys").array().notNull(),
    owners: uuid("owners").array().notNull(),
    exclusiveOwner: uuid("exclusiveOwner"),
    shared: boolean("shared").notNull(),
    amount: doublePrecision("amount"),
    date: date("date", { mode: "string" }),
    /** Routing resolved at publication: member shortcodes, section key, label. */
    ownerCodes: text("ownerCodes").array().notNull(),
    ownerKey: text("ownerKey"),
    ownerLabel: text("ownerLabel"),
  },
  (t) => [primaryKey({ columns: [t.key, t.inputIncomplete] })],
);

export type WorkPublicationMeta = {
  incompleteProjectIds: ProjectAttentionReport["incompleteProjectIds"];
  incompleteDiagnosticSources: IncompleteWorkDiagnosticSource[];
  /** Global input warnings: `{source, family, executor, message}`. */
  coverage: {
    source: string;
    family: string;
    executor: string;
    message: string;
  }[];
};

/** The single publication: when its rows were read, and what made it stale. */
export const workPublication = pgTable("WorkPublication", {
  id: smallint("id").primaryKey(),
  /** The snapshot instant the published rows reflect. */
  publishedAt: timestamp("publishedAt", { mode: "date" }),
  /** The latest member write a publication has not yet read. */
  dirtyAt: timestamp("dirtyAt", { mode: "date" }),
  /** The last failed publish attempt, cleared by a success; backs off retries. */
  attemptedAt: timestamp("attemptedAt", { mode: "date" }),
  /** That failed attempt's raw error. */
  error: text("error"),
  meta: jsonb("meta").$type<WorkPublicationMeta>(),
});
