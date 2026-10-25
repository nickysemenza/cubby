import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { SHORTCODE_PREFIX, type ShortcodeType } from "@cubby/shared";
import { type SQL, relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// SAFETY: `SHORTCODE_PREFIX` is the generated registry keyed by exactly the
// `ShortcodeType` union, so its own keys are that union's members.
const identityKinds = Object.keys(SHORTCODE_PREFIX) as ShortcodeType[];

function entityKindCheck(kind: AnyPgColumn): SQL {
  return sql`${kind} IN (${sql.join(
    identityKinds.map((value) => sql`${sql.raw(`'${value}'`)}`),
    sql`, `,
  )})`;
}

/** `CASE kind WHEN 'product' THEN shortcode LIKE 'PRD-%' ... END`. */
function entityPrefixMatches(kind: AnyPgColumn, shortcode: AnyPgColumn): SQL {
  const branches = identityKinds.map(
    (value) =>
      sql`WHEN ${sql.raw(`'${value}'`)} THEN ${shortcode} LIKE ${sql.raw(`'${SHORTCODE_PREFIX[value]}%'`)}`,
  );
  return sql`CASE ${kind} ${sql.join(branches, sql` `)} ELSE false END`;
}

/**
 * One durable identity row per shortcode-bearing entity (ADR 0006). The typed
 * payload tables keep their own `shortcode` and `deletedAt`; this row is what
 * survives a merge or a hard delete, so an old code can still redirect or
 * report a tombstone.
 *
 * Shared transactional repositories create this row before its payload and
 * preserve its tombstone on removal. `finalizeMerge` also records redirects.
 * Rows are never deleted, except Job identities pruned with their execution
 * rows by retention (docs/jobs.md).
 */
export const entityIdentity = pgTable(
  "Entity",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull().$type<ShortcodeType>(),
    /**
     * The complete canonical code. Null only for legacy tombstones the
     * cutover created for history rows whose former code was unrecoverable.
     */
    shortcode: text("shortcode"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    mergedIntoId: uuid("mergedIntoId").references(
      (): AnyPgColumn => entityIdentity.id,
    ),
  },
  (table) => [
    // Whole-table, like every payload's own index: a code is never reused,
    // including the code of a hard-deleted payload that lives only here.
    uniqueIndex("Entity_shortcode_unique").on(table.shortcode),
    // The composite target of every payload's identity FK.
    unique("Entity_id_shortcode_key").on(table.id, table.shortcode),
    // The composite target of kind-checked references (`DataException`,
    // `AuditLog`, search projections): the row must name the right kind.
    unique("Entity_id_kind_key").on(table.id, table.kind),
    index("Entity_mergedIntoId_idx").on(table.mergedIntoId),
    check("Entity_kind_check", entityKindCheck(table.kind)),
    check(
      "Entity_shortcode_prefix_check",
      sql`${table.shortcode} IS NULL OR ${entityPrefixMatches(table.kind, table.shortcode)}`,
    ),
    check(
      "Entity_merge_not_self_check",
      sql`${table.mergedIntoId} IS NULL OR ${table.mergedIntoId} <> ${table.id}`,
    ),
    check(
      "Entity_merged_is_deleted_check",
      sql`${table.mergedIntoId} IS NULL OR ${table.deletedAt} IS NOT NULL`,
    ),
    check(
      "Entity_live_has_shortcode_check",
      sql`${table.deletedAt} IS NOT NULL OR ${table.shortcode} IS NOT NULL`,
    ),
  ],
);

export const entityIdentityRelations = relations(entityIdentity, ({ one }) => ({
  canonical: one(entityIdentity, {
    fields: [entityIdentity.mergedIntoId],
    references: [entityIdentity.id],
    relationName: "entityCanonical",
  }),
}));

/**
 * The composite FK binding a payload row to its identity. Because it also
 * covers `shortcode`, a payload can never disagree with its canonical code,
 * and the code is immutable in practice (an update would orphan the FK).
 */
export const entityIdentityFk = (
  tableName: string,
  table: { id: AnyPgColumn; shortcode: AnyPgColumn },
) =>
  foreignKey({
    name: `${tableName}_entity_identity_fk`,
    columns: [table.id, table.shortcode],
    foreignColumns: [entityIdentity.id, entityIdentity.shortcode],
  });

/**
 * Desired-state cleanup, safe to repeat after historical migrations create
 * identity triggers. Historical migration SQL remains immutable; new writes
 * create identity before payloads and maintain lifecycle in their transaction.
 */
export const entityIdentityDropTriggerSql = (): string => {
  const drops = [...shortcodeEntities].sort().flatMap((kind) => {
    const table = entityManifest[kind].dbTable;
    if (!table) throw new Error(`Shortcode entity ${kind} has no dbTable.`);
    return ["insert", "soft_delete", "delete"].map(
      (event) =>
        `DROP TRIGGER IF EXISTS "Entity_identity_${event}" ON "${table}";`,
    );
  });
  return [
    ...drops,
    'DROP FUNCTION IF EXISTS "entity_identity_on_insert"();',
    'DROP FUNCTION IF EXISTS "entity_identity_on_soft_delete"();',
    'DROP FUNCTION IF EXISTS "entity_identity_on_delete"();',
  ].join("\n");
};
