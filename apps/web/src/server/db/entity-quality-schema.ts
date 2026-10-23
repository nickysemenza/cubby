import type { ScoredEntity } from "@cubby/schemas/data-quality";
import {
  entityQualityCheckState,
  type EntityQualityCheckState,
} from "@cubby/schemas/data-quality-shape";
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";

/** Derived metadata about an identity, not a navigable entity relationship. */
export const entityQuality = pgTable(
  "EntityQuality",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").notNull().$type<ScoredEntity>(),
    score: doublePrecision("score"),
    rulesVersion: integer("rulesVersion").notNull(),
    computedAt: timestamp("computedAt", { mode: "date" }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "EntityQuality_entity_fk",
      columns: [t.entityId, t.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }),
  ],
);

/** Same identity owner as EntityQuality; both rows are retired together. */
export const entityQualityCheck = pgTable(
  "EntityQualityCheck",
  {
    entityId: uuid("entityId").notNull(),
    kind: text("kind").notNull().$type<ScoredEntity>(),
    checkKey: text("checkKey").notNull(),
    state: text("state").notNull().$type<EntityQualityCheckState>(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.checkKey] }),
    foreignKey({
      name: "EntityQualityCheck_entity_fk",
      columns: [t.entityId, t.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }),
    index("EntityQualityCheck_kind_check_state_idx").on(
      t.kind,
      t.checkKey,
      t.state,
    ),
    check(
      "EntityQualityCheck_state_check",
      sql`${t.state} IN (${sql.join(
        entityQualityCheckState.options.map((v) =>
          sqlEnumConstant(entityQualityCheckState, v),
        ),
        sql`, `,
      )})`,
    ),
  ],
);
