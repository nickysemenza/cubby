import type { ProductId } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  importSourceProduct,
  importSourceOrder,
  importSourceClaim,
  purchase,
  product,
} from "~/server/db/schema";
import { lookupProductIdentifierSources } from "~/server/domains/product/repo/product-identifier-source";
import { amazonAsin } from "~/server/domains/purchase-import/repo/writer";

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
/** Only an accepted original line and its durable Product binding establish a claim. */
export async function loadProductIdentifierClaims(
  db: Database,
  targetId?: ProductId,
) {
  const rows = await getDb(db)
    .select({
      bindingId: importSourceProduct.id,
      productId: importSourceProduct.productId,
      lineIndex: importSourceProduct.lineIndex,
      sourceOrderId: importSourceOrder.id,
      sourceClaimId: importSourceClaim.id,
      original: importSourceOrder.originalOrder,
      acceptedChecksum: importSourceOrder.checksum,
      originalExternalKey: importSourceClaim.externalKey,
      vendorId: purchase.vendorId,
    })
    .from(importSourceProduct)
    .innerJoin(
      importSourceOrder,
      eq(importSourceOrder.id, importSourceProduct.sourceOrderId),
    )
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(purchase, eq(purchase.id, importSourceOrder.purchaseId))
    .innerJoin(product, eq(product.id, importSourceProduct.productId))
    .where(
      and(
        notDeleted(product),
        targetId ? eq(importSourceProduct.productId, targetId) : undefined,
      ),
    )
    .orderBy(importSourceProduct.id);
  const candidates = [];
  for (const row of rows) {
    const original = acceptedSourceOrder.safeParse(row.original);
    if (!original.success || original.data.extraction.status !== "ready")
      continue;
    const line = original.data.extraction.candidate.lines[row.lineIndex];
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
      checksum: original.data.checksum,
      line,
      identifiers,
    });
  }
  const sources = await lookupProductIdentifierSources(
    db,
    candidates.map(({ row, line }) => ({
      url: line.productUrl,
      vendorId: row.vendorId,
    })),
  );
  const claims = [];
  for (const [
    index,
    { row, checksum, line, identifiers },
  ] of candidates.entries()) {
    const source = sources[index];
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
