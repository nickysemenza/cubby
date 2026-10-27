import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";

/**
 * Tickets order dirty marks across all targets. A per-row counter restarts
 * after a delete and reinsert, so a slow drain holding an old number could
 * clear newer work (ABA); a sequence value never repeats.
 */
export const derivedTicket = pgSequence("DerivedTicket");

/**
 * The disposable cache of stored derived values (ADR 0021). Truncating it
 * loses nothing: the drain rebuilds every row from authoritative inputs.
 * `value` is the published value; `sortNumber`/`sortDate`/`sortText` carry
 * the one typed projection lists sort and filter on.
 */
export const derivedValue = pgTable(
  "DerivedValue",
  {
    entityId: uuid("entityId").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    value: jsonb("value"),
    sortNumber: doublePrecision("sortNumber"),
    sortDate: timestamp("sortDate", { mode: "string" }),
    sortText: text("sortText"),
    decidedBy: jsonb("decidedBy"),
    inputHash: text("inputHash"),
    computedAt: timestamp("computedAt", { mode: "date" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.key] }),
    foreignKey({
      name: "DerivedValue_entity_fk",
      columns: [t.entityId, t.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
    index("DerivedValue_kind_key_number_idx").on(t.kind, t.key, t.sortNumber),
    index("DerivedValue_kind_key_date_idx").on(t.kind, t.key, t.sortDate),
    index("DerivedValue_kind_key_text_idx").on(t.kind, t.key, t.sortText),
    // Activity's per-minute publication count reads the last 15 minutes.
    index("DerivedValue_computed_idx").on(t.computedAt),
  ],
);

/**
 * Pending derived work. `target` is `<entity>.<key>` for a record whose value
 * must be recomputed (`ref` is its id), or `<entity>.<key>@<column>` for a
 * fanout mark whose dependents (rows whose `<column>` equals `ref`) the drain
 * expands. Triggers write only the saved row's own marks and its old/new
 * endpoints; they never query dependents.
 */
export const derivedDirty = pgTable(
  "DerivedDirty",
  {
    target: text("target").notNull(),
    ref: uuid("ref").notNull(),
    ticket: bigint("ticket", { mode: "number" })
      .notNull()
      .default(sql`nextval('"DerivedTicket"')`),
    /** 0 = a member edit, 1 = background source or propagation, 2 = reconcile or backfill. */
    priority: integer("priority").notNull().default(0),
    dirtiedAt: timestamp("dirtiedAt", { mode: "date" }).notNull().defaultNow(),
    readyAt: timestamp("readyAt", { mode: "date" }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
  },
  (t) => [
    primaryKey({ columns: [t.target, t.ref] }),
    index("DerivedDirty_ready_idx").on(t.priority, t.readyAt),
  ],
);
