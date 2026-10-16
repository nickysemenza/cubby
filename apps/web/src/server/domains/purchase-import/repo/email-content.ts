import { and, eq, isNotNull, or } from "drizzle-orm";

import {
  type RepositoryQueryClient as DrizzleClient,
  type RepositoryQueryTransaction as DrizzleTransaction,
} from "~/server/db/repository-access.boundary";
import { orderMail, orderMailAttachment } from "~/server/db/retained-tables";

/** A retained shell is provenance, not usable import evidence. */
export async function hasRetainedEmailImportContent(
  client: DrizzleClient | DrizzleTransaction,
  originalId: string | null,
  content: typeof orderMail.$inferSelect.content | null,
): Promise<boolean> {
  if (!originalId) return false;
  if (
    content &&
    [content.snippet, content.bodyText, content.bodyHtml].some((part) =>
      Boolean(part?.trim()),
    )
  )
    return true;
  const [attachment] = await client
    .select({ id: orderMailAttachment.id })
    .from(orderMailAttachment)
    .where(
      and(
        eq(orderMailAttachment.orderMailId, originalId),
        or(
          isNotNull(orderMailAttachment.pendingObjectKey),
          isNotNull(orderMailAttachment.imageId),
        ),
      ),
    )
    .limit(1);
  return attachment !== undefined;
}
