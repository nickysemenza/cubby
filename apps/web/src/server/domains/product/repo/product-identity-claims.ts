import type { ProductId } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  importSourceProduct,
  expense,
  entityLink,
  importSourceOrder,
  importSourceClaim,
  purchase,
  product,
} from "~/server/db/schema";
import { lookupProductIdentifierSources } from "~/server/domains/product/repo/product-identifier-source";
import { amazonAsin } from "~/server/domains/purchase-import/repo/writer";

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
  const rows = await getDb(db)
    .select({
      bindings: sql<unknown>`jsonb_agg(jsonb_build_object(
        'bindingId', ${importSourceProduct.id},
        'productId', ${product.id},
        'lineIndex', ${importSourceProduct.lineIndex}
      ))`,
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
    .leftJoin(
      expense,
      and(
        eq(expense.id, importSourceProduct.expenseId),
        eq(expense.purchaseId, purchase.id),
        notDeleted(expense),
      ),
    )
    .leftJoin(
      entityLink,
      and(
        eq(entityLink.kind, "purchaseProduct"),
        eq(entityLink.fromEntityId, purchase.id),
        eq(entityLink.toEntityId, importSourceProduct.productId),
        notDeleted(entityLink),
      ),
    )
    // An incomplete order can name Products without inventing an Expense.
    // That identity must still have its current generic Purchase/Product link.
    .innerJoin(
      product,
      eq(
        product.id,
        sql`CASE WHEN ${importSourceProduct.expenseId} IS NOT NULL
      THEN ${expense.productId} ELSE ${entityLink.toEntityId} END`,
      ),
    )
    .where(
      and(
        notDeleted(product),
        notDeleted(purchase),
        targetId
          ? inArray(
              product.id,
              typeof targetId === "string" ? [targetId] : [...targetId],
            )
          : undefined,
      ),
    )
    .groupBy(importSourceOrder.id, importSourceClaim.id, purchase.id);
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
      vendorId: row.vendorId,
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
