import type {
  MailboxClassification,
  MailboxClassificationDecision,
} from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";

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

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

// Avoid splitting a surrogate pair at either excerpt boundary.
function excerpt(value: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value.charAt(start))) start++;
  if (end < value.length && /[\uDC00-\uDFFF]/u.test(value.charAt(end))) end--;
  return value.slice(start, end);
}

function boundedField(value: string, bytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(JSON.stringify(excerpt(value, 0, middle))) <= bytes)
      low = middle;
    else high = middle - 1;
  }
  return excerpt(value, 0, low);
}

function readableBody(normalized: GmailNormalizedMessage) {
  const bodyHtml = normalized.mail.bodyHtml;
  const html =
    !normalized.mail.bodyText && bodyHtml
      ? wasm.compact_browser_page(bodyHtml, "")
      : null;
  return {
    body: normalized.mail.bodyText || html?.text || "",
    // Readable HTML omits markup, metadata and image evidence, even when short.
    complete: html === null,
  };
}

function triageView(normalized: GmailNormalizedMessage) {
  const readable = readableBody(normalized);
  const body = readable.body;
  const from = normalized.mail.headers.from ?? "";
  const subject = normalized.mail.headers.subject ?? "";
  const headers = {
    from: boundedField(from, 512),
    subject: boundedField(subject, 1_024),
  };
  const attachments = normalized.attachments
    .slice(0, 8)
    .map(({ filename, mimeType, size }) => ({
      filename: boundedField(filename, 128),
      mimeType: boundedField(mimeType, 64),
      size,
    }));
  const complete =
    headers.from === from && headers.subject === subject && readable.complete;
  const senderDomain =
    headers.from.match(/@([a-z0-9.-]+\.[a-z]{2,})/iu)?.[1]?.toLowerCase() ??
    null;
  const encode = (length: number) => {
    const full = length === body.length;
    const headLength = full ? length : Math.ceil(length * 0.75);
    return JSON.stringify({
      headers,
      senderDomain,
      body: excerpt(body, 0, headLength),
      bodyEnd: full
        ? ""
        : excerpt(body, body.length - (length - headLength), body.length),
      bodyComplete: complete && full,
      attachments,
      attachmentsComplete: attachments.length === normalized.attachments.length,
    });
  };
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(encode(middle)) <= 12_000) low = middle;
    else high = middle - 1;
  }
  return { content: encode(low), complete: complete && low === body.length };
}

/** The bounded view is transient; the original remains the retained evidence. */
export async function routeGmailMessage(
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
  choose: MailTriage,
): Promise<MailboxClassificationDecision> {
  const body = normalized.mail.bodyText || normalized.mail.bodyHtml;
  if (!body?.trim() || (raw.payload && incompletePart(raw.payload)))
    return {
      classification: "uncertain",
      stage: "rule",
      reason: "The message body is empty or incomplete",
    };
  const view = triageView(normalized);
  const choice = await choose(view.content);
  if (
    choice === "unrelated" &&
    (!view.complete || normalized.attachments.length)
  )
    return {
      classification: "uncertain",
      stage: "rule",
      reason:
        "Jev said unrelated, but omitted content or attachments need a closer read",
    };
  return {
    classification: choice,
    stage: "jev",
    reason: `Jev classified the ${view.complete ? "message" : "partial message"} ${choice}`,
  };
}
