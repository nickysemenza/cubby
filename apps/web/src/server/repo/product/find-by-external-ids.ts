import type { ExternalIdInput } from "@cubby/schemas/external-id";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityExternalId, product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type ExternalIdPair = Pick<ExternalIdInput, "source" | "externalId"> &
  Partial<Pick<ExternalIdInput, "kind">>;

export type ProductHit = Pick<
  typeof product.$inferSelect,
  "id" | "shortcode" | "name" | "manufacturer" | "model"
>;

/** A kindless request intentionally matches every kind; typed requests have distinct keys. */
export const externalIdKey = ({ source, externalId, kind }: ExternalIdPair) =>
  `${source}\0${externalId}\0${kind ?? ""}`;

/**
 * Live Products holding each `(source, externalId)` pair, in one statement
 * Optional kinds retain caller-specific identity rules. Several identifiers
 * may point to different Products; callers must review that ambiguity.
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
      kind: entityExternalId.kind,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
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
  for (const pair of pairs) {
    const matching = rows.filter(
      (row) =>
        row.source === pair.source &&
        row.externalId === pair.externalId &&
        (pair.kind === undefined || pair.kind === row.kind),
    );
    const unique = new Map(
      matching.map(({ id, shortcode, name, manufacturer, model }) => [
        id,
        { id, shortcode, name, manufacturer, model },
      ]),
    );
    byPair.set(externalIdKey(pair), [...unique.values()]);
  }
  return byPair;
};
