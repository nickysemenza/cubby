import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityExternalId, product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export interface ExternalIdPair {
  source: string;
  externalId: string;
}

export interface ProductHit {
  id: ProductId;
  shortcode: string;
}

/** The map key for a pair; NUL cannot occur in either part. */
export const externalIdKey = ({ source, externalId }: ExternalIdPair) =>
  `${source}\0${externalId}`;

/**
 * Live Products holding each `(source, externalId)` pair, in one statement
 * whatever the kind (ASIN, retailer SKU, ...). The unique index lets a pair
 * name at most one live Product; the value is a list only so a caller never
 * has to assume that.
 */
export const findProductsByExternalIds = async (
  db: Database | DrizzleTransaction,
  pairs: readonly ExternalIdPair[],
): Promise<Map<string, ProductHit[]>> => {
  const byPair = new Map<string, ProductHit[]>();
  if (pairs.length === 0) return byPair;
  const rows = await unwrapDb(db)
    .select({
      source: entityExternalId.source,
      externalId: entityExternalId.externalId,
      id: product.id,
      shortcode: product.shortcode,
    })
    .from(entityExternalId)
    .innerJoin(
      product,
      and(eq(product.id, entityExternalId.entityId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(entityExternalId),
        sql`(${entityExternalId.source}, ${entityExternalId.externalId}) IN (${sql.join(
          pairs.map((pair) => sql`(${pair.source}, ${pair.externalId})`),
          sql`, `,
        )})`,
      ),
    );
  for (const row of rows) {
    const key = externalIdKey(row);
    byPair.set(key, [
      ...(byPair.get(key) ?? []),
      { id: row.id, shortcode: row.shortcode },
    ]);
  }
  return byPair;
};
