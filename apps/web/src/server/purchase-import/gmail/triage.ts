import type { MailboxClassification } from "@cubby/schemas/mailbox-research";

import type {
  GmailMessage,
  GmailMessagePart,
  GmailNormalizedMessage,
} from "./types";

export type MailTriage = (content: string) => Promise<MailboxClassification>;

const incompletePart = (part: GmailMessagePart): boolean => {
  if ((part.parts ?? []).some(incompletePart)) return true;
  if (part.filename) return false;
  if (!part.mimeType?.startsWith("text/")) return false;
  if (part.body?.attachmentId) return true;
  if ((part.body?.size ?? 0) > 0 && !part.body?.data) return true;
  return Boolean(
    part.body?.data &&
    (part.body.size ?? 0) > Buffer.from(part.body.data, "base64url").byteLength,
  );
};

export const gmailOriginalComplete = (
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
): boolean =>
  Boolean(
    normalized.mail.bodyText?.trim() ||
    normalized.mail.bodyHtml?.trim() ||
    normalized.attachments.length,
  ) && !(raw.payload && incompletePart(raw.payload));

/** Content exists only during this call; uncertain bytes belong to the capable researcher. */
export async function routeGmailMessage(
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
  choose: MailTriage,
): Promise<MailboxClassification> {
  const body = normalized.mail.bodyText || normalized.mail.bodyHtml;
  if (!body?.trim() || (raw.payload && incompletePart(raw.payload)))
    return "uncertain";
  const content = JSON.stringify({
    headers: normalized.mail.headers,
    body,
    attachments: normalized.attachments.map(({ filename, mimeType, size }) => ({
      filename,
      mimeType,
      size,
    })),
  });
  // Jev's envelope has its own stricter check. Never truncate into a negative verdict.
  if (new TextEncoder().encode(content).byteLength > 12_000) return "uncertain";
  const choice = await choose(content);
  return choice === "unrelated" && normalized.attachments.length
    ? "uncertain"
    : choice;
}
