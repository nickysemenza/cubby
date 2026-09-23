import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { SHORTCODE_PREFIX, type ShortcodeType } from "@cubby/shared";
import { type SQL, sql } from "drizzle-orm";
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
 * Rows are written only by the database triggers below
 * (insert, soft delete, hard delete of a payload row) and by `finalizeMerge`
 * (`mergedIntoId`). Rows are never deleted.
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
 * The database-side half of entity identity (ADR 0006): triggers on every
 * shortcode table keep `Entity` in step with its typed payload, so no write
 * path — repository, workflow, cutover script, or test fixture — can create,
 * soft-delete, or hard-delete an entity without its identity row following.
 *
 * `drizzle-kit push` does not manage triggers, so every place that builds a
 * database from `schema.ts` applies these statements afterwards: the
 * IntegreSQL template (`tooling/test-setup.ts`) and the local dev push
 * (`tooling/dev-db-push.ts`). Production already has the triggers; a new
 * shortcode entity needs its trigger installed before writes begin.
 * It lives beside the table so `tooling/test-setup.ts`, which may only load
 * the schema modules eagerly, can reach it through `schema.ts`.
 *
 * Trigger names start with an uppercase `E` on purpose. Postgres fires same-
 * event triggers in name order, internal FK checks included
 * (`RI_ConstraintTrigger_*`). The insert trigger must run before the payload's
 * own identity FK is checked, so its name must sort before `R`.
 */
const ENTITY_IDENTITY_FUNCTIONS = `CREATE OR REPLACE FUNCTION "entity_identity_on_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
  VALUES (NEW."id", TG_ARGV[0], NEW."shortcode", NEW."createdAt", NEW."deletedAt");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_soft_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity" SET "deletedAt" = NEW."deletedAt" WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity"
  SET "deletedAt" = COALESCE("deletedAt", OLD."deletedAt", now())
  WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$;`;

// Resolved from the manifest rather than the generated table map so the
// tooling scripts that install these (plain `tsx`, no path aliases) can load
// this module.
const identityTables = (): { kind: string; table: string }[] =>
  [...shortcodeEntities].sort().map((kind) => {
    const table = entityManifest[kind].dbTable;
    if (!table) throw new Error(`Shortcode entity ${kind} has no dbTable.`);
    return { kind, table };
  });

const tableTriggers = ({
  kind,
  table,
}: {
  kind: string;
  table: string;
}) => `CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "${table}"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('${kind}');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "${table}"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "${table}"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();`;

/** Every function and trigger, idempotent, as one script. */
export const entityIdentityTriggerSql = (): string =>
  [ENTITY_IDENTITY_FUNCTIONS, ...identityTables().map(tableTriggers)].join(
    "\n\n",
  );

interface SqlExecutor {
  execute(query: SQL): Promise<object>;
}

/** Install the identity triggers after a `drizzle-kit push`. */
export async function installEntityIdentityTriggers(
  db: SqlExecutor,
): Promise<void> {
  await db.execute(sql.raw(entityIdentityTriggerSql()));
}
