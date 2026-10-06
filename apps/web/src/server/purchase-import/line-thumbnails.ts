import type { PurchaseId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityAttachment, expense, image } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { importImageFromUrl } from "~/server/services/image-storage.service";

import { retainLiteralLineLinks } from "../agents/purchase-import/extract";

const log = createLogger("order-line-thumbnails");

type ThumbnailLine = { title: string; imageUrl?: string; productUrl?: string };

type ThumbnailPorts = {
  importImage: (
    db: Database,
    params: { sourceUrl: string; filenamePrefix: string },
  ) => Promise<{ imageId: string; created: boolean } | null>;
};

/**
 * After a mail import commits, give each image-less Product its confirmation
 * line's thumbnail as the item cover. It is provisional by position only: a
 * verified catalog image from enrichment later takes cover ahead of it. Runs
 * outside the import transaction because it fetches over the network, and is
 * best-effort per line: a failed fetch never fails the import.
 */
export async function attachOrderLineThumbnails(
  db: Database,
  input: {
    purchaseId: PurchaseId;
    mailContent: { bodyHtml: string | null; bodyText: string | null };
    lines: readonly ThumbnailLine[];
  },
  ports: ThumbnailPorts = { importImage: importImageFromUrl },
) {
  const titleCount = new Map<string, number>();
  for (const line of input.lines)
    titleCount.set(line.title, (titleCount.get(line.title) ?? 0) + 1);
  for (const raw of input.lines) {
    // A title two lines share cannot name one Product; skip rather than guess.
    if ((titleCount.get(raw.title) ?? 0) > 1) continue;
    // Re-check at the point of fetching: only URLs the email itself shows.
    const line = retainLiteralLineLinks(raw, input.mailContent, []);
    if (!line.imageUrl) continue;
    try {
      const productId = await lineProduct(db, input.purchaseId, line.title);
      if (!productId || (await hasImage(db, productId))) continue;
      const imported = await ports.importImage(db, {
        sourceUrl: line.imageUrl,
        filenamePrefix: `order-line-${productId}`,
      });
      if (!imported) continue;
      const imageId = await resolveOrThrow(db, "image", imported.imageId);
      await withTransaction(db, async (tx) => {
        // A concurrent edit may have added an image since the check above.
        if (await hasImage(tx, productId)) return;
        if (imported.created)
          await tx
            .update(image)
            .set({
              source: "catalog",
              sourcePageUrl: raw.productUrl ?? null,
              sourceName: raw.productUrl
                ? new URL(raw.productUrl).hostname
                : null,
            })
            .where(eq(image.id, imageId));
        await tx.insert(entityAttachment).values({
          entityId: productId,
          entityKind: "product",
          role: "attachment",
          imageId,
          sortOrder: 0,
          purpose: "item",
        });
      });
    } catch (error) {
      log.warn("Order line thumbnail skipped", {
        purchaseId: input.purchaseId,
        title: line.title,
        error,
      });
    }
  }
}

async function lineProduct(
  db: Database,
  purchaseId: PurchaseId,
  title: string,
) {
  const [row] = await getDb(db)
    .select({ productId: expense.productId })
    .from(expense)
    .where(
      and(
        eq(expense.purchaseId, purchaseId),
        eq(expense.name, title),
        isNotNull(expense.productId),
        notDeleted(expense),
      ),
    )
    .limit(1);
  return row?.productId ?? null;
}

async function hasImage(db: Database | DrizzleTransaction, productId: string) {
  const [row] = await unwrapDb(db)
    .select({ id: entityAttachment.id })
    .from(entityAttachment)
    .where(
      and(
        eq(entityAttachment.entityId, productId),
        // A label photo is never a cover, so it does not count as one.
        eq(entityAttachment.purpose, "item"),
        notDeleted(entityAttachment),
      ),
    )
    .limit(1);
  return Boolean(row);
}
