import type { EntityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";

/** Rebuildable check outcomes. DataException remains the owner of member waivers. */
export const qualitySnapshot = pgTable(
  "QualitySnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").notNull(),
    rulesVersion: integer("rulesVersion").notNull(),
    checks: jsonb("checks")
      .$type<Record<string, EntityQualityCheckState>>()
      .notNull(),
    computedAt: timestamp("computedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "QualitySnapshot_entity_fk",
      columns: [t.entityId, t.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);
