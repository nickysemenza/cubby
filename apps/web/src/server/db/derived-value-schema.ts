import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";

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
    check(
      "DerivedValue_no_retired_automatic_fields",
      sql`${t.key} <> 'automaticFields'`,
    ),
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
