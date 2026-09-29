import { externalIdKind } from "@cubby/schemas/external-id";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import type { Database } from "~/server/db";
import { entityExternalId, product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

const externalIdCollisionKey = (value: {
  source: string;
  kind: string;
  externalId: string;
}) =>
  `${value.source.trim().toLowerCase()}\u0000${value.kind}\u0000${value.externalId}`;

export const findProductExternalIdCollisions = async (
  db: Database,
  input?: {
    source?: string | string[];
    /** Public shortcode of the product the caller intends to write these onto. */
    productId?: ProductShortcode;
    identifiers?: Array<{ source: string; kind: string; externalId: string }>;
  },
) => {
  const selected = input?.source
    ? [input.source].flat().map((source) => source.trim().toLowerCase())
    : undefined;
  const identifiers = input?.identifiers?.map((identifier) => ({
    ...identifier,
    source: identifier.source.trim().toLowerCase(),
  }));
  const rows = await getDb(db)
    .select({
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
      productId: product.id,
      productShortcode: product.shortcode,
      productName: product.name,
    })
    .from(entityExternalId)
    .innerJoin(
      product,
      and(eq(product.id, entityExternalId.entityId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(entityExternalId),
        selected && selected.length > 0
          ? inArray(entityExternalId.source, selected)
          : identifiers && identifiers.length > 0
            ? or(
                ...identifiers.map((identifier) =>
                  and(
                    eq(entityExternalId.source, identifier.source),
                    sql`${entityExternalId.kind} = ${identifier.kind}`,
                    eq(entityExternalId.externalId, identifier.externalId),
                  ),
                ),
              )
            : undefined,
      ),
    );
  const grouped = groupBy(rows, externalIdCollisionKey);
  const items = Object.entries(grouped).flatMap(([, matches]) => {
    const first = matches[0];
    if (!first || matches.length <= 1) return [];
    return [
      {
        source: first.source.trim().toLowerCase(),
        kind: externalIdKind.parse(first.kind),
        externalId: first.externalId,
        products: matches.map((row) => ({
          id: parseShortcodeFor("product", row.productShortcode),
          name: row.productName,
        })),
      },
    ];
  });
  return {
    items,
    results: (identifiers ?? []).map((identifier) => {
      const matches = grouped[externalIdCollisionKey(identifier)] ?? [];
      // Without `productId`, `unique` can only mean "exactly one live owner,
      // whoever that is" — which reads as a clean pass even when the id sits on
      // a DIFFERENT product. With it, say which.
      const sole = matches.length === 1 ? matches[0] : undefined;
      return {
        ...identifier,
        status:
          matches.length === 0
            ? ("missing" as const)
            : sole
              ? input?.productId === undefined
                ? ("unique" as const)
                : sole.productShortcode === input.productId
                  ? ("owned_by_this" as const)
                  : ("owned_by_other" as const)
              : ("collision" as const),
        products: matches.map((row) => ({
          id: parseShortcodeFor("product", row.productShortcode),
          name: row.productName,
        })),
      };
    }),
  };
};
