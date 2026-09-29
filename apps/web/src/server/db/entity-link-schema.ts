import {
  ENTITY_LINK_KINDS,
  entityLinkKinds,
  type EntityLinkKind,
} from "@cubby/schemas/entity-links";

/**
 * The `EntityLink` CHECK bodies, rendered from `ENTITY_LINK_KINDS` so a new
 * link kind changes one declaration. Plain SQL over the table's own quoted
 * column names: `schema.ts` wraps each in `sql.raw` for drizzle `check()`,
 * and the same strings are what Postgres stores, so `db:check` diffs them.
 */

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const kindList = (kinds: readonly EntityLinkKind[]): string =>
  kinds.map(literal).join(", ");

/** `(kind, fromKind, toKind)` names a declared link kind and its endpoint kinds. */
export const entityLinkKindCheckSql = (): string =>
  `("kind", "fromKind", "toKind") IN (${entityLinkKinds
    .map((kind) => {
      const { from, to } = ENTITY_LINK_KINDS[kind];
      return `(${literal(kind)}, ${literal(from)}, ${literal(to)})`;
    })
    .join(", ")})`;

/** A quantity is required (≥ 1) exactly on kinds that declare one, else NULL. */
export const entityLinkQuantityCheckSql = (): string => {
  const counted = entityLinkKinds.filter(
    (kind) => ENTITY_LINK_KINDS[kind].quantity,
  );
  if (counted.length === 0) return `"quantity" IS NULL`;
  return `CASE WHEN "kind" IN (${kindList(counted)}) THEN "quantity" IS NOT NULL AND "quantity" >= 1 ELSE "quantity" IS NULL END`;
};

/** Kinds that forbid a self-link refuse `fromEntityId = toEntityId`. */
export const entityLinkNoSelfCheckSql = (): string => {
  const noSelf = entityLinkKinds.filter(
    (kind) => ENTITY_LINK_KINDS[kind].forbidSelfLink,
  );
  if (noSelf.length === 0) return "true";
  return `"kind" NOT IN (${kindList(noSelf)}) OR "fromEntityId" <> "toEntityId"`;
};

/**
 * A live link may not name a deleted endpoint. Row CHECKs cannot read
 * `Entity`, so this is a constraint trigger (derived DDL): it fires on every
 * insert or update that leaves the link live, and refuses when either
 * endpoint's identity row is soft-deleted. Soft-deleting the link itself
 * (setting `deletedAt`) never fires it, which is how a removal detaches links
 * before tombstoning the entity. Postgres has no `CREATE OR REPLACE` for a
 * constraint trigger, so drop-and-create keeps the script idempotent.
 */
export const entityLinkLivenessTriggerSql =
  (): string => `CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();`;
