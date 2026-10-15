import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  MAIL_ATTACHMENT_MAX_BYTES,
  mailAttachmentOriginal,
  mailReadInput,
  mailReadOut,
  type MailReadInput,
} from "@cubby/schemas/mailbox-research";
import { decodeBase64Url, encodeBase64 } from "@cubby/shared/base64";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, email as emailTable, run } from "~/server/db/schema";

import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import { recordEmailRetrievalFailure } from "./observations";
import { gmailProviderForUser } from "./provider";
import {
  GmailApiError,
  type GmailAttachmentPayload,
  type GmailOrderMailAttachment,
} from "./types";

export async function exactMemberEmail(
  db: Database,
  input: MailReadInput,
  actor: ActorContext,
  lock?: "update",
) {
  if (actor.runId)
    throw new Error(
      "Only a member without a Run can refetch an Email original; admitted Run evidence stays frozen.",
    );
  const query = getDb(db)
    .select({ email: emailTable })
    .from(emailTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, emailTable.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(
      account,
      and(
        eq(account.userId, actor.userId),
        eq(account.providerId, "google"),
        eq(account.accountId, emailTable.mailboxId),
      ),
    )
    .where(
      and(
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, input.mailboxId),
        eq(emailTable.messageId, input.messageId),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  const [email] = await query;
  if (!email)
    throw new Error(
      "No live Email in this exact connected mailbox belongs to this member.",
    );
  if (!lock) return email.email;
  const reference = email.email;
  const [owner] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, reference.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .for("no key update");
  if (!owner) throw new Error("Email member owner changed before locking.");
  const [connected] = await getDb(db)
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, actor.userId),
        eq(account.providerId, "google"),
        eq(account.accountId, input.mailboxId),
      ),
    )
    .for("update");
  if (!connected)
    throw new Error("Email connected account changed before locking.");
  if (reference.runId)
    await getDb(db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, reference.runId))
      .for("update");
  const [current] = await getDb(db)
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.id, reference.id),
        eq(emailTable.ledgerPartyId, owner.id),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, input.mailboxId),
        eq(emailTable.messageId, input.messageId),
        notDeleted(emailTable),
      ),
    )
    .for("update")
    .limit(1);
  if (!current || current.runId !== reference.runId)
    throw new Error(
      "Email original assignment or ownership changed before locking.",
    );
  return current;
}
export function boundedAttachment(
  attachment: GmailOrderMailAttachment,
  payload: GmailAttachmentPayload,
) {
  const encoded = payload.data;
  if (!encoded) throw new Error("Gmail attachment original returned no bytes.");
  if (
    attachment.size > MAIL_ATTACHMENT_MAX_BYTES ||
    (payload.size ?? 0) > MAIL_ATTACHMENT_MAX_BYTES ||
    encoded.length > Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4
  )
    throw new Error("Gmail attachment original exceeds the 3 MiB byte limit.");
  const bytes = decodeBase64Url(encoded);
  if (bytes.byteLength > MAIL_ATTACHMENT_MAX_BYTES)
    throw new Error("Gmail attachment original exceeds the 3 MiB byte limit.");
  if (
    (attachment.size > 0 && attachment.size !== bytes.byteLength) ||
    (payload.size !== undefined && payload.size !== bytes.byteLength)
  )
    throw new Error(
      "Gmail attachment original size changed from its message descriptor.",
    );
  return bytes;
}
/** Member-only original read: provider bytes never become retained evidence or import authority. */
export async function readEmailOriginalTransient(
  db: Database,
  rawInput: MailReadInput,
  actor: ActorContext,
): Promise<z.infer<typeof mailReadOut>> {
  const input = mailReadInput.parse(rawInput);
  const email = await exactMemberEmail(db, input, actor);
  const providerCall = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      await recordEmailRetrievalFailure(db, {
        ledgerPartyId: email.ledgerPartyId,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        httpStatus: error instanceof GmailApiError ? error.status : null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const provider = await providerCall(() =>
    gmailProviderForUser(db, actor.userId, input.mailboxId),
  );
  const message = await providerCall(() =>
    provider.getMessage(input.messageId),
  );
  if (message.id !== input.messageId)
    throw new Error("Gmail original response message identity changed.");
  const normalized = normalizeMessage(input.mailboxId, message);
  if (
    normalized.mail.labelIds.some(
      (label) => label === "SPAM" || label === "TRASH",
    )
  )
    throw new Error("Gmail original is excluded in Spam or Trash.");
  const requested = input.attachmentId
    ? normalized.attachments.find(
        (part) => part.attachmentId === input.attachmentId,
      )
    : undefined;
  if (input.attachmentId && !requested)
    throw new Error(
      "That attachment does not belong to this exact current Email.",
    );
  let originalAttachment: z.infer<typeof mailAttachmentOriginal> | undefined;
  if (requested) {
    if (requested.size > MAIL_ATTACHMENT_MAX_BYTES)
      throw new Error(
        "Gmail attachment original exceeds the 3 MiB byte limit.",
      );
    const payload = requested.dataBase64Url
      ? { data: requested.dataBase64Url, size: requested.size }
      : await providerCall(() =>
          provider.getAttachment(input.messageId, input.attachmentId!),
        );
    const bytes = boundedAttachment(requested, payload);
    originalAttachment = mailAttachmentOriginal.parse({
      attachmentId: input.attachmentId,
      filename: requested.filename,
      mimeType: requested.mimeType,
      checksum: await sha256Hex(bytes),
      dataBase64: encodeBase64(bytes),
    });
  }
  await exactMemberEmail(db, input, actor);
  return mailReadOut.parse({
    ...input,
    id: parseShortcodeFor("email", email.shortcode),
    threadId: normalized.mail.threadId,
    checksum: await originalChecksum(normalized),
    sender: normalized.mail.headers.from ?? null,
    subject: normalized.mail.headers.subject ?? null,
    receivedAt: normalized.mail.internalDate,
    content: {
      snippet: normalized.mail.snippet,
      bodyText: normalized.mail.bodyText,
      bodyHtml: normalized.mail.bodyHtml,
      headers: normalized.mail.headers,
    },
    attachments: normalized.attachments
      .filter((part) => part.attachmentId !== null)
      .map((part) => ({
        attachmentId: part.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        checksum:
          part.attachmentId === originalAttachment?.attachmentId
            ? originalAttachment?.checksum
            : null,
      })),
    originalAttachment,
    boundToRun: false,
  });
}
