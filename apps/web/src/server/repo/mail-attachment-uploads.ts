import { and, asc, eq, lte, sql } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  imageProcessingOrphan,
  image,
  orderMailAttachment,
} from "~/server/db/schema";
import type { OrderMailAttachmentStorage } from "~/server/purchase-import/gmail/attachment-storage";
import {
  getDb,
  isTransaction,
  parentTransactionDatabase,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS } from "~/server/utils/s3";

export const MAIL_ATTACHMENT_UPLOAD_REASON = "mail_attachment_upload";

/** Only this fixed-purpose insert escapes sanctioned transaction ancestry.
 * Its receipt must survive rollback before any original bytes reach storage.
 * A checked-out single-client root cannot escape its physical outer BEGIN. */
export async function reserveMailAttachmentUpload(
  db: Database,
  input: { key: string; attemptId: string },
): Promise<void> {
  let durable = db;
  let escapedTransaction = false;
  while (isTransaction(getDb(durable))) {
    const parent = parentTransactionDatabase(durable);
    if (!parent)
      throw new Error(
        "Mail attachment upload reservation requires a rooted durable database",
      );
    durable = parent;
    escapedTransaction = true;
  }
  if (escapedTransaction) {
    const rootClient = getDb(durable);
    await durable.withClientConnection(async (client) => {
      if (client === rootClient)
        throw new Error(
          "Mail attachment upload reservation requires an independent durable connection",
        );
      await client
        .insert(imageProcessingOrphan)
        .values({ ...input, reason: MAIL_ATTACHMENT_UPLOAD_REASON });
    });
    return;
  }
  await getDb(durable)
    .insert(imageProcessingOrphan)
    .values({
      ...input,
      reason: MAIL_ATTACHMENT_UPLOAD_REASON,
    });
}

/** The cleaner and publication serialize on this exact reserved upload. */
export async function lockMailAttachmentUpload(
  db: Database | DrizzleTransaction,
  key: string,
): Promise<void> {
  const tx = unwrapDb(db);
  if (!isTransaction(tx))
    throw new Error(
      "Mail attachment upload publication requires a transaction",
    );
  const [reserved] = await tx
    .select({ id: imageProcessingOrphan.id })
    .from(imageProcessingOrphan)
    .where(
      and(
        eq(imageProcessingOrphan.key, key),
        eq(imageProcessingOrphan.reason, MAIL_ATTACHMENT_UPLOAD_REASON),
      ),
    )
    .for("update")
    .limit(1);
  if (!reserved)
    throw new Error(
      "Mail attachment upload reservation expired before publication",
    );
}

/** Consume only inside the transaction that publishes its attachment pointer. */
export async function finalizeMailAttachmentUpload(
  db: Database | DrizzleTransaction,
  key: string,
): Promise<void> {
  const tx = unwrapDb(db);
  if (!isTransaction(tx))
    throw new Error(
      "Mail attachment upload finalization requires a transaction",
    );
  await tx
    .delete(imageProcessingOrphan)
    .where(
      and(
        eq(imageProcessingOrphan.key, key),
        eq(imageProcessingOrphan.reason, MAIL_ATTACHMENT_UPLOAD_REASON),
      ),
    );
}

/** Hold the reservation lock through deletion, so a suspended publisher cannot
 * recreate an already-reaped key. Failed deletes retain their durable receipt. */
export async function cleanupAbandonedMailAttachmentUploads(
  db: Database,
  storage: Pick<OrderMailAttachmentStorage, "delete">,
): Promise<number> {
  const expiredBefore = sql`now() - ${PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS + 60} * interval '1 second'`;
  const expired = await getDb(db)
    .select({ id: imageProcessingOrphan.id })
    .from(imageProcessingOrphan)
    .where(
      and(
        eq(imageProcessingOrphan.reason, MAIL_ATTACHMENT_UPLOAD_REASON),
        lte(imageProcessingOrphan.createdAt, expiredBefore),
      ),
    )
    .orderBy(
      asc(imageProcessingOrphan.createdAt),
      asc(imageProcessingOrphan.id),
    );
  let removed = 0;
  const failures: unknown[] = [];
  for (const candidate of expired) {
    try {
      removed += await withTransaction(db, async (tx) => {
        const [reserved] = await tx
          .select()
          .from(imageProcessingOrphan)
          .where(
            and(
              eq(imageProcessingOrphan.id, candidate.id),
              eq(imageProcessingOrphan.reason, MAIL_ATTACHMENT_UPLOAD_REASON),
              lte(imageProcessingOrphan.createdAt, expiredBefore),
            ),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        if (!reserved) return 0;
        // Include soft-deleted media: its physical object belongs to media disposal.
        const [attachment] = await tx
          .select({ id: orderMailAttachment.id })
          .from(orderMailAttachment)
          .where(eq(orderMailAttachment.pendingObjectKey, reserved.key))
          .limit(1);
        const [promoted] = await tx
          .select({ id: image.id })
          .from(image)
          .where(eq(image.key, reserved.key))
          .limit(1);
        if (attachment || promoted) return 0;
        await storage.delete(reserved.key);
        await finalizeMailAttachmentUpload(tx, reserved.key);
        return 1;
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures
        .flatMap((error) =>
          describeErrorCauses(error).causes.map((cause) => cause.message),
        )
        .join("\n"),
    );
  return removed;
}
