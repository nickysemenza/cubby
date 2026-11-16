import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { entityLink } from "~/server/db/schema";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import { lookupProductIdentifierSources } from "~/server/domains/product/repo/product-identifier-source";
import {
  acceptedOrderPurchasesSql,
  acceptedOrderLinesSql,
} from "~/server/domains/purchase-import/repo/accepted-order-read";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

const log = createLogger("product-identity-claims");

export const retainedProductIdentifierClaim = z.object({
  productId: z.uuid(),
  source: z.string(),
  kind: z.string(),
  value: z.string(),
  sourceOrderId: z.uuid(),
  sourceClaimId: z.uuid(),
  bindingId: z.uuid(),
  lineIndex: z.number().int().nonnegative(),
  originalChecksum: z.string(),
  acceptedChecksum: z.string(),
  originalExternalKey: z.string(),
  productUrl: z.string().nullable(),
  exactVariant: z.boolean().default(false),
  variant: z
    .object({
      color: z.string().nullable(),
      size: z.string().nullable(),
      pack: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
const receiptBindings = retainedProductIdentifierClaim
  .pick({ bindingId: true, productId: true, lineIndex: true })
  .array();

export type DroppedProductIdentifierClaim = {
  productId: string;
  bindingId: string;
  productUrl: string | null;
  error: string;
};

/** A receipt line and its live Expense Product binding establish a
 * claim. A line whose issuer cannot resolve is dropped and reported with the
 * raw resolution error instead of failing every Product's catalog scan. */
export async function loadProductIdentifierClaims(
  db: Database,
  targetId?: ProductId | readonly ProductId[],
  options: {
    onDropped?: (dropped: DroppedProductIdentifierClaim) => void;
  } = {},
) {
  if (targetId && typeof targetId !== "string" && !targetId.length) return [];
  const result = await getDb(db).execute(sql`
    SELECT accepted.id AS "sourceOrderId", coalesce(accepted."sourceClaimId",accepted.id) AS "sourceClaimId",
      jsonb_build_object('checksum',accepted.checksum,'extraction',accepted.extraction) AS original,
      accepted.checksum AS "acceptedChecksum", accepted."sourceExternalKey" AS "originalExternalKey", accepted."vendorId",
      -- Derived association identities retain the UUID version and variant contract.
      jsonb_agg(jsonb_build_object('bindingId',overlay(overlay(md5(accepted.id::text || ':' || binding."lineIndex"::text) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,
        'productId',catalog.id,'lineIndex',binding."lineIndex")) AS bindings
    FROM ${acceptedOrderPurchasesSql} accepted
    JOIN ${acceptedOrderLinesSql} binding ON binding."sourceOrderId"=accepted.id
    JOIN "Purchase" receipt_purchase ON receipt_purchase.id=accepted."boundPurchaseId" AND ${notDeleted("receipt_purchase")}
    LEFT JOIN "Expense" line ON line.id=binding."expenseId" AND line."purchaseId"=receipt_purchase.id AND ${notDeleted("line")}
    LEFT JOIN "Entity" ordered_identity ON ordered_identity.id=binding."productId"
    LEFT JOIN ${entityLink} ON ${entityLink.fromEntityId}=receipt_purchase.id
      AND ${entityLink.toEntityId}=coalesce(ordered_identity."mergedIntoId",ordered_identity.id)
      AND ${liveLinks("purchaseProduct")}
    JOIN "Entity" identity ON identity.id=CASE WHEN binding."expenseId" IS NOT NULL
      THEN line."productId" ELSE ${entityLink.toEntityId} END
    JOIN "Product" catalog ON catalog.id=coalesce(identity."mergedIntoId",identity.id) AND ${notDeleted("catalog")}
    WHERE ${targetId ? sql`catalog.id=ANY(${uuidArrayParam(typeof targetId === "string" ? [targetId] : [...targetId])})` : sql`true`}
    GROUP BY accepted.id,accepted."sourceClaimId",accepted.checksum,accepted.extraction,accepted."sourceExternalKey",accepted."vendorId"`);
  const rows = z
    .object({
      rows: z.array(
        z.object({
          sourceOrderId: z.string(),
          sourceClaimId: z.string(),
          original: z.json(),
          acceptedChecksum: z.string(),
          originalExternalKey: z.string(),
          vendorId: z.string(),
          bindings: z.json(),
        }),
      ),
    })
    .parse(result).rows;
  const candidates = [];
  // Keep the receipt and its live bindings in one statement, without sending
  // the entire receipt once per line. Validate the whole accepted order first.
  const bindings = rows.flatMap(({ bindings, original: raw, ...receipt }) => {
    const parsed = acceptedSourceOrder.safeParse(raw);
    const original = parsed.success ? parsed.data : null;
    return receiptBindings.parse(bindings).map((binding) => ({
      row: { ...receipt, ...binding },
      original,
    }));
  });
  bindings.sort((a, b) =>
    a.row.bindingId < b.row.bindingId
      ? -1
      : a.row.bindingId > b.row.bindingId
        ? 1
        : 0,
  );
  for (const { row, original } of bindings) {
    if (!original || original.extraction.status !== "ready") continue;
    const line = original.extraction.candidate.lines[row.lineIndex];
    if (!line) continue;
    const asin = amazonAsin(line.productUrl);
    const identifiers = [
      ...(line.sku
        ? [{ kind: "retailer_sku", externalId: line.sku, exactVariant: false }]
        : []),
      ...(asin ? [{ kind: "asin", externalId: asin, exactVariant: true }] : []),
    ];
    if (!identifiers.length) continue;
    candidates.push({
      row,
      checksum: original.checksum,
      line,
      identifiers,
    });
  }
  const sources = await lookupProductIdentifierSources(
    db,
    candidates.map(({ row, line }) => ({
      url: line.productUrl,
      vendorId: parseEntityId("vendor", row.vendorId),
    })),
  );
  const claims = [];
  for (const [
    index,
    { row, checksum, line, identifiers },
  ] of candidates.entries()) {
    const lookup = sources[index];
    if (lookup?.error) {
      const dropped = {
        productId: row.productId,
        bindingId: row.bindingId,
        productUrl: line.productUrl ?? null,
        error: lookup.error,
      };
      log.warn("product identifier claim dropped", dropped);
      options.onDropped?.(dropped);
      continue;
    }
    const source = lookup?.source;
    if (!source) continue;
    for (const identifier of identifiers)
      claims.push(
        retainedProductIdentifierClaim.parse({
          ...row,
          source,
          kind: identifier.kind,
          value: identifier.externalId,
          originalChecksum: checksum,
          productUrl: line.productUrl ?? null,
          exactVariant: identifier.exactVariant,
          variant: null,
        }),
      );
  }
  return claims;
}
