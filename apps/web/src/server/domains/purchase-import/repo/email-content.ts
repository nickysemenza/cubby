import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import {
  type RepositoryQueryClient as DrizzleClient,
  type RepositoryQueryTransaction as DrizzleTransaction,
} from "~/server/db/repository-access.boundary";
import { orderMail, orderMailAttachment } from "~/server/db/retained-tables";

/** Apply before pagination so retained shells cannot starve usable evidence. */
export function retainedEmailImportContentCondition() {
  return sql`(
    ${orderMail.content}->>'snippet' ~ '[^[:space:]]'
    or ${orderMail.content}->>'bodyText' ~ '[^[:space:]]'
    or ${orderMail.content}->>'bodyHtml' ~ '[^[:space:]]'
    or exists (
      select 1 from ${orderMailAttachment}
      where ${orderMailAttachment.orderMailId} = ${orderMail.id}
        and (${orderMailAttachment.pendingObjectKey} is not null
          or ${orderMailAttachment.imageId} is not null)
    )
  )`;
}

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
