/**
 * Keys of the Entity identity rows a reconciler resolves a saved reference
 * through (ADR 0029 section 5). A load that resolves an id or shortcode reads
 * the identity row by its row key or its shortcode by an index key, including
 * a miss; every insert, redirect or tombstone of an identity of a fenced kind
 * raises both under the household gate. A shortcode never changes once
 * reserved, so a miss becomes a hit only through an insert.
 */
import { sql } from "drizzle-orm";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import { textArrayParam } from "~/server/db/helpers/array-param";

import { defineReadIndex, type Key } from "./define";
import { indexKey, rowKey } from "./keys";

/** Matches `Entity_shortcode_unique`. */
export const entityShortcodes = defineReadIndex(entityIdentity, {
  name: "entity.shortcode",
  values: (row) => (row.shortcode ? [row.shortcode] : []),
  where: (values) =>
    sql`${entityIdentity.shortcode} = ANY(${textArrayParam(values)})`,
});

/**
 * The kinds whose saved references a reconciler resolves through fenced reads:
 * a Purchase chosen for an Order. Another kind's reference resolves to no
 * Purchase whatever its identity row holds, so its changes raise nothing.
 */
const FENCED_KINDS: ReadonlySet<string> = new Set(["purchase"]);

/** The keys an identity row's insert, redirect or tombstone raises. */
export const identityKeys = (
  rows: readonly { id: string; kind: string; shortcode: string | null }[],
): Key[] =>
  rows.flatMap((row) =>
    FENCED_KINDS.has(row.kind)
      ? [
          rowKey("Entity", row.id),
          ...(row.shortcode
            ? [indexKey(entityShortcodes.name, row.shortcode)]
            : []),
        ]
      : [],
  );
