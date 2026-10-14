import type { MailboxRelevanceDecision } from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";
import { MAILBOX_RELEVANCE_FEATURE } from "~/server/ai/features";
import type { AiChatRequest } from "~/server/ai/run-feature";

import { unreadableMailImages } from "./triage";
import {
  GmailApiError,
  type GmailNormalizedMessage,
  type GmailProvider,
  type GmailOrderMailAttachment,
} from "./types";

export type MailRelevance = (
  request: AiChatRequest,
) => Promise<MailboxRelevanceDecision>;
const MAX_TRANSIENT_BYTES = 256 * 1024;
const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

function inlineImageContentId(source: string) {
  const match = /^cid:(.+)$/iu.exec(source);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return /^[^<>\s]+$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

function readableMailView({
  bodyHtml,
  ...mail
}: GmailNormalizedMessage["mail"]) {
  const html = bodyHtml ? wasm.compact_email_html(bodyHtml) : null;
  return {
    original: JSON.stringify({
      ...mail,
      htmlText:
        html?.text.trim() === mail.bodyText?.trim()
          ? null
          : (html?.text ?? null),
      links:
        html?.links.map(({ href, text }) => ({ url: href, label: text })) ?? [],
      images: html?.images.map(({ src, alt }) => ({ url: src, alt })) ?? [],
      unresolvedImages: html?.unresolved_image_sources ?? [],
      preheader: html?.preheader ?? null,
      structuredData: html?.structured_data ?? [],
    }),
    // Omitted purchase cues and unreadable images require review; decorative
    // images and discarded layout bytes do not make a negative incomplete.
    complete: (availableContentIds: ReadonlySet<string>) =>
      !html ||
      (!html.truncated &&
        html.cue_links_omitted === 0 &&
        html.cue_images_omitted === 0 &&
        html.structured_data_omitted === 0 &&
        html.cues_omitted === 0 &&
        !unreadableMailImages(
          html.unresolved_images === html.unresolved_image_sources.length &&
            html.unresolved_image_sources.every((source) => {
              const id = inlineImageContentId(source);
              return id !== null && availableContentIds.has(id);
            })
            ? { ...html, unresolved_images: 0 }
            : html,
          mail.bodyText ?? "",
        )),
  };
}

type MailContentPart = Exclude<
  AiChatRequest["messages"][number]["content"],
  string
>[number];

const readAttachmentData = async (
  provider: GmailProvider,
  messageId: string,
  attachment: GmailOrderMailAttachment,
) => {
  if (attachment.dataBase64Url) return attachment.dataBase64Url;
  if (!attachment.attachmentId) return undefined;
  try {
    return (await provider.getAttachment(messageId, attachment.attachmentId))
      .data;
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404)
      return undefined;
    throw error;
  }
};

const readAttachmentContext = async (
  provider: GmailProvider,
  messageId: string,
  attachment: GmailOrderMailAttachment,
  availableBytes: number,
): Promise<{
  part: MailContentPart;
  encoded: string;
  byteLength: number;
} | null> => {
  const mimeType = attachment.mimeType;
  const supported =
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/");
  if (!supported || attachment.size > availableBytes) return null;
  const encoded = await readAttachmentData(provider, messageId, attachment);
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength < attachment.size || bytes.byteLength > availableBytes)
    return null;
  const part: MailContentPart = mimeType.startsWith("text/")
    ? {
        type: "text",
        content: `Attachment ${attachment.filename}:\n${bytes.toString("utf8")}`,
      }
    : {
        type: mimeType === "application/pdf" ? "document" : "image",
        source: { type: "inline", value: bytes.toString("base64"), mimeType },
      };
  return { part, encoded, byteLength: bytes.byteLength };
};

/** Unsupported, absent, or oversized bytes cannot justify a negative verdict. */
export async function interpretMailRelevance(
  provider: GmailProvider,
  normalized: GmailNormalizedMessage,
  interpret: MailRelevance,
  originalComplete = true,
  onAttachment?: (sourceKey: string, encoded: string) => void,
): Promise<MailboxRelevanceDecision> {
  const { original, complete: viewComplete } = readableMailView(
    normalized.mail,
  );
  let complete =
    originalComplete &&
    Boolean(
      normalized.mail.bodyText?.trim() ||
      normalized.mail.bodyHtml?.trim() ||
      normalized.attachments.length,
    );
  const content: Exclude<AiChatRequest["messages"][number]["content"], string> =
    [
      {
        type: "text",
        content: original,
      },
    ];
  const availableContentIds = new Set<string>();
  let totalBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  let acquiredBytes = new TextEncoder().encode(
    JSON.stringify(normalized.mail),
  ).byteLength;
  for (const attachment of normalized.attachments) {
    const context = await readAttachmentContext(
      provider,
      normalized.mail.messageId,
      attachment,
      MAX_ORIGINAL_BYTES - acquiredBytes,
    );
    if (!context) {
      complete = false;
      continue;
    }
    acquiredBytes += context.byteLength;
    onAttachment?.(attachment.sourceKey, context.encoded);
    const parts: MailContentPart[] =
      attachment.contentId && context.part.type === "image"
        ? [
            {
              type: "text",
              content: `Inline Email image cid:${attachment.contentId}`,
            },
            context.part,
          ]
        : [context.part];
    const modelBytes =
      new TextEncoder().encode(JSON.stringify(parts)).byteLength -
      2 +
      parts.length;
    if (modelBytes > MAX_TRANSIENT_BYTES - totalBytes) {
      complete = false;
      continue;
    }
    totalBytes += modelBytes;
    content.push(...parts);
    if (attachment.contentId && context.part.type === "image")
      availableContentIds.add(attachment.contentId);
  }
  if (totalBytes > MAX_TRANSIENT_BYTES) return { classification: "uncertain" };
  const decision = await interpret(MAILBOX_RELEVANCE_FEATURE.request(content));
  return decision.classification === "unrelated" &&
    (!complete || !viewComplete(availableContentIds))
    ? { classification: "uncertain" }
    : decision;
}
