import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import type { Database } from "~/server/db/database";
import { entityExternalId } from "~/server/db/external-identifier-tables";
import { product } from "~/server/db/generated/identity-storage-tables.gen";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

const externalIdKey = (value: {
  source: string;
  kind: string;
  externalId: string;
}) =>
  `${value.source.trim().toLowerCase()}\u0000${value.kind}\u0000${value.externalId}`;

/**
 * Who owns each exact (source, kind, externalId), in request order. The live
 * unique index guarantees at most one live owner per identifier.
 */
export const findProductExternalIdCollisions = async (
  db: Database,
  input: {
    /** Public shortcode of the product the caller intends to write these onto. */
    productId?: ProductShortcode;
    identifiers: Array<{ source: string; kind: string; externalId: string }>;
  },
) => {
  const identifiers = input.identifiers.map((identifier) => ({
    ...identifier,
    source: identifier.source.trim().toLowerCase(),
  }));
  const wanted = requestedRows(
    identifiers,
    { source: "text", kind: "text", externalId: "text" },
    "wanted",
  );
  const rows = await repositoryQueries(db)
    .select({
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
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
        sql`EXISTS (SELECT 1 FROM ${wanted.from} WHERE wanted.source = ${entityExternalId.source} AND wanted.kind = ${entityExternalId.kind} AND wanted."externalId" = ${entityExternalId.externalId})`,
      ),
    );
  const owners = groupBy(rows, externalIdKey);
  return {
    results: identifiers.map((identifier) => {
      const owner = owners[externalIdKey(identifier)]?.[0];
      // Without `productId`, `unique` can only mean "one live owner, whoever
      // that is" — which reads as a clean pass even when the id sits on a
      // DIFFERENT product. With it, say which.
      return {
        ...identifier,
        status: !owner
          ? ("missing" as const)
          : input.productId === undefined
            ? ("unique" as const)
            : owner.productShortcode === input.productId
              ? ("owned_by_this" as const)
              : ("owned_by_other" as const),
        products: owner
          ? [
              {
                id: parseShortcodeFor("product", owner.productShortcode),
                name: owner.productName,
              },
            ]
          : [],
      };
    }),
  };
};
