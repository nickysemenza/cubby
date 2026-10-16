import type { ShortcodeType } from "@cubby/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  foreignKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";

export const baseTimestamps = () => ({
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export const softDeletedAt = () => ({
  deletedAt: timestamp("deletedAt", { mode: "date" }),
});
export const pkUuid = <T extends string = string>() =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .$type<T>();

const entityIdColumn = () => uuid("entityId");
const entityKindColumn = <K extends string>() => text("entityKind").$type<K>();

interface EntityRefOptions<K extends string> {
  nullable: boolean;
  /** Type-level narrowing of `entityKind`; the table's own CHECK enforces it. */
  kinds?: readonly K[];
}
interface RequiredEntityRef<K extends string> {
  entityId: ReturnType<ReturnType<typeof entityIdColumn>["notNull"]>;
  entityKind: ReturnType<ReturnType<typeof entityKindColumn<K>>["notNull"]>;
}
interface NullableEntityRef<K extends string> {
  entityId: ReturnType<typeof entityIdColumn>;
  entityKind: ReturnType<typeof entityKindColumn<K>>;
}

/**
 * The one shape of "a column that points at any entity": `entityId`
 * (`Entity.id`) plus the `entityKind` stored beside it. Every such table binds
 * the pair to `Entity(id, kind)` with `entityRefFk`, so a row cannot name an
 * entity of a kind it is not. A nullable ref (an AI call with no subject)
 * passes the composite FK by MATCH SIMPLE while either half is null.
 */
export function entityRef<K extends string = ShortcodeType>(
  options: EntityRefOptions<K> & { nullable: false },
): RequiredEntityRef<K>;
export function entityRef<K extends string = ShortcodeType>(
  options: EntityRefOptions<K> & { nullable: true },
): NullableEntityRef<K>;
export function entityRef<K extends string>(
  options: EntityRefOptions<K>,
): RequiredEntityRef<K> | NullableEntityRef<K> {
  return options.nullable
    ? { entityId: entityIdColumn(), entityKind: entityKindColumn<K>() }
    : {
        entityId: entityIdColumn().notNull(),
        entityKind: entityKindColumn<K>().notNull(),
      };
}

/** The composite-FK half of `entityRef`; each table keeps its own name. */
export const entityRefFk = (
  name: string,
  table: { entityId: AnyPgColumn; entityKind: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [table.entityId, table.entityKind],
    foreignColumns: [entityIdentity.id, entityIdentity.kind],
  });
