import {
  MAIL_ATTACHMENT_MAX_BYTES,
  mailAttachmentOriginal,
  type MailAttachmentOriginal,
} from "@cubby/schemas/mailbox-research";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { image, orderMailAttachment } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { getS3Object } from "~/server/utils/s3";

export type MailAttachmentReader = (
  key: string,
  maxBytes: number,
) => Promise<Uint8Array>;
const readOriginal: MailAttachmentReader = async (key, maxBytes) => {
  const response = await getS3Object(key);
  if (!response.ok)
    throw new Error(
      `Attachment original read failed: ${response.status} ${response.statusText}`,
    );
  return readResponseWithLimit(response, maxBytes);
};

/** The reference is admitted against its parent source before any object read. */
export async function loadMailAttachmentOriginal(
  db: Database,
  input: { orderMailId: string; attachmentRef: string },
  read: MailAttachmentReader = readOriginal,
): Promise<MailAttachmentOriginal> {
  const [source] = await getDb(db)
    .select({ attachment: orderMailAttachment, imageKey: image.key })
    .from(orderMailAttachment)
    .leftJoin(
      image,
      and(eq(image.id, orderMailAttachment.imageId), notDeleted(image)),
    )
    .where(
      and(
        eq(orderMailAttachment.id, input.attachmentRef),
        eq(orderMailAttachment.orderMailId, input.orderMailId),
      ),
    )
    .limit(1);
  if (!source)
    throw new Error(
      "Attachment reference does not belong to this retained mail source.",
    );
  const { attachment } = source;
  const descriptor = mailAttachmentOriginal.omit({ dataBase64: true }).parse({
    attachmentId: attachment.providerAttachmentId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    checksum: attachment.checksum,
  });
  const key = attachment.pendingObjectKey ?? source.imageKey;
  if (!key)
    throw new Error(
      "Attachment original is unavailable; no readable bytes were retained.",
    );
  const bytes = await read(key, MAIL_ATTACHMENT_MAX_BYTES);
  if (bytes.byteLength > MAIL_ATTACHMENT_MAX_BYTES)
    throw new Error(
      "Attachment original exceeds the 3 MiB byte limit; a larger-document capability is required.",
    );
  if ((await sha256Hex(bytes)) !== attachment.checksum)
    throw new Error("Attachment original checksum changed.");
  await assertMailAttachmentOriginal(db, {
    orderMailId: input.orderMailId,
    attachmentRef: attachment.id,
    checksum: attachment.checksum,
  });
  return mailAttachmentOriginal.parse({
    ...descriptor,
    dataBase64: Buffer.from(bytes).toString("base64"),
  });
}

async function assertMailAttachmentOriginal(
  db: Database,
  input: { orderMailId: string; attachmentRef: string; checksum: string },
) {
  const [source] = await getDb(db)
    .select({ checksum: orderMailAttachment.checksum })
    .from(orderMailAttachment)
    .where(
      and(
        eq(orderMailAttachment.id, input.attachmentRef),
        eq(orderMailAttachment.orderMailId, input.orderMailId),
      ),
    )
    .for("share")
    .limit(1);
  if (!source || source.checksum !== input.checksum)
    throw new Error(
      "Retained mail attachment original changed or no longer belongs to this source.",
    );
}
