import {
  EXTERNAL_ID_KINDS,
  type EntityExternalIdKind,
} from "@cubby/schemas/external-id";

/**
 * The `EntityExternalId` CHECK bodies, rendered from `EXTERNAL_ID_KINDS` so a
 * new identifier kind changes one declaration. Plain SQL over the table's own
 * quoted column names; `schema.ts` wraps each in `sql.raw`.
 */

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// SAFETY: Object.keys of a const literal returns exactly its declared keys.
const kinds = Object.keys(EXTERNAL_ID_KINDS) as EntityExternalIdKind[];

/** `(entityKind, kind)` names a declared identifier kind on an entity it may attach to. */
export const externalIdKindCheckSql = (): string =>
  `("entityKind", "kind") IN (${kinds
    .flatMap((kind) =>
      EXTERNAL_ID_KINDS[kind].entities.map(
        (entity) => `(${literal(entity)}, ${literal(kind)})`,
      ),
    )
    .join(", ")})`;

/**
 * `isPrimary` is set exactly on kinds with a primary slot. Settlement
 * references have none: one charge can carry several order ids.
 */
export const externalIdPrimaryCheckSql = (): string =>
  `CASE WHEN "kind" IN (${kinds
    .filter((kind) => EXTERNAL_ID_KINDS[kind].primarySlot)
    .map(literal)
    .join(", ")}) THEN "isPrimary" IS NOT NULL ELSE "isPrimary" IS NULL END`;
