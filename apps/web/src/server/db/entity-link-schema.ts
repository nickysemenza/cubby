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

/** Endpoint liveness is checked by the shared transactional link writer. */
export const entityLinkDropLivenessTriggerSql = (): string => `
DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
DROP FUNCTION IF EXISTS "entity_link_require_live_endpoints"();`;
