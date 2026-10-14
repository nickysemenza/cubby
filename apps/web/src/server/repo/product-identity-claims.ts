import type { ProductId } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  importSourceProduct,
  importSourceOrder,
  importSourceClaim,
  purchase,
  product,
} from "~/server/db/schema";
import { amazonAsin } from "~/server/purchase-import/writer";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { lookupProductIdentifierSource } from "~/server/repo/product-identifier-source";
import {
  extractRetainedVariantFacts,
  verifiedVariantFacts,
} from "~/server/repo/product-variant-comparison";

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
  variant: verifiedVariantFacts.nullable().default(null),
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
  const claims = [];
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
    const source = await lookupProductIdentifierSource(db, {
      url: line.productUrl,
      vendorId: row.vendorId,
    });
    if (!source) continue;
    for (const identifier of identifiers)
      claims.push(
        retainedProductIdentifierClaim.parse({
          ...row,
          source,
          kind: identifier.kind,
          value: identifier.externalId,
          originalChecksum: original.data.checksum,
          productUrl: line.productUrl ?? null,
          exactVariant: identifier.exactVariant,
          variant: extractRetainedVariantFacts(line.title),
        }),
      );
  }
  return claims;
}
