import {
  MAIL_READ_HTML_PAGE_MAX_BYTES,
  MAIL_READ_TEXT_MAX_BYTES,
  type MailReadContent,
  type MailReadInput,
  type RetainedMailContent,
} from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";

const MAIL_READ_MAX_LINKS = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isContinuation = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** A UTF-8 byte window moved onto character boundaries. */
function byteWindow(bytes: Uint8Array, offset: number, maxBytes: number) {
  let start = Math.min(offset, bytes.length);
  while (isContinuation(bytes[start])) start += 1;
  let end = Math.min(start + maxBytes, bytes.length);
  while (end > start && isContinuation(bytes[end])) end -= 1;
  return { text: decoder.decode(bytes.subarray(start, end)), end };
}

const readableChars = (text: string) =>
  (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * The read view of retained content: compact text from the HTML body when the
 * text part is empty or carries less readable text, and raw HTML only as an
 * explicitly requested page. Long retailer HTML is mostly inline styles and
 * layout tables, so the raw body overflows tool output caps before its totals.
 */
export function mailReadContent(
  content: RetainedMailContent,
  input: Pick<MailReadInput, "includeHtml" | "offset" | "maxBytes">,
): MailReadContent {
  const html = content.bodyHtml ? encoder.encode(content.bodyHtml) : null;
  const compact = content.bodyHtml
    ? wasm.compact_email_html(content.bodyHtml)
    : null;
  const plain = content.bodyText?.trim() ? content.bodyText : null;
  const compacted =
    compact !== null &&
    compact.text.trim() !== "" &&
    (plain === null || compact.readable_chars > readableChars(plain));
  const body = compacted ? compact.text : plain;
  const bodyBytes = body === null ? null : encoder.encode(body);
  const bodyText =
    bodyBytes === null
      ? null
      : byteWindow(bodyBytes, 0, MAIL_READ_TEXT_MAX_BYTES).text;
  let truncated =
    (compacted && compact.truncated) ||
    (bodyBytes?.length ?? 0) > MAIL_READ_TEXT_MAX_BYTES;
  let bodyHtml: string | null = null;
  if (input.includeHtml && html) {
    const page = byteWindow(
      html,
      input.offset ?? 0,
      input.maxBytes ?? MAIL_READ_HTML_PAGE_MAX_BYTES,
    );
    bodyHtml = page.text;
    truncated ||= page.end < html.length || (input.offset ?? 0) > 0;
  }
  return {
    snippet: content.snippet,
    bodyText,
    bodyHtml,
    ...(content.headers ? { headers: content.headers } : {}),
    htmlBytes: html?.length ?? null,
    compacted,
    truncated,
    links: (compact?.links ?? [])
      .slice(0, MAIL_READ_MAX_LINKS)
      .map(({ href, text }) => ({ href, text })),
  };
}
