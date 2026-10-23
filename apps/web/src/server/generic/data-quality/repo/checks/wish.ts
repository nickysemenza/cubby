import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { entityLink, product, wish } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const WISH_QUALITY_RULES_VERSION = 1;

type WishQualityRecord = Awaited<
  ReturnType<typeof loadWishQualityRecords>
>[number];

export const wishChecks = defineStoredEntityChecks({
  entity: "wish",
  table: wish,
  rulesVersion: WISH_QUALITY_RULES_VERSION,
  load: loadWishQualityRecords,
  checks: {
    wish_display_image: qualityCheck.hasImage,
    // Once acquired, a wish no longer needs a live candidate product.
    wish_candidate: qualityCheck.when(
      (record: WishQualityRecord) => record.acquiredAt === null,
      qualityCheck.hasRelated((record: WishQualityRecord) => record.candidates),
    ),
  },
});

async function loadWishQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: wish.id,
      shortcode: wish.shortcode,
      acquiredAt: wish.acquiredAt,
      candidates: sql<string[]>`coalesce(
        array_agg(${product.id}) FILTER (WHERE ${product.id} IS NOT NULL),
        ARRAY[]::uuid[]
      )`,
      hasDisplayImage: sql<boolean>`bool_or(${entityDisplayImagePresenceSql("wish", sql`${wish.id}`)})`,
    })
    .from(wish)
    .leftJoin(
      entityLink,
      and(
        eq(entityLink.fromEntityId, wish.id),
        eq(entityLink.kind, "wishCandidate"),
        notDeleted(entityLink),
      ),
    )
    .leftJoin(
      product,
      and(eq(product.id, entityLink.toEntityId), notDeleted(product)),
    )
    .where(and(notDeleted(wish), sql`${wish.id} = ANY(${uuidArrayParam(ids)})`))
    .groupBy(wish.id, wish.shortcode, wish.acquiredAt);
}
