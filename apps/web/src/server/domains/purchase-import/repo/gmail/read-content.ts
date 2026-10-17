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

const utf8Length = (lead: number) =>
  lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;

/** Bytes a character occupies inside a JSON string literal. */
function jsonLength(lead: number) {
  if (lead === 0x22 || lead === 0x5c) return 2;
  if (lead >= 0x20) return utf8Length(lead);
  return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(lead) ? 2 : 6;
}

/**
 * A page of whole characters from `offset` whose JSON-escaped size fits
 * `maxBytes`. It holds at least one character, so paging by `nextOffset`
 * always progresses and concatenates back to the original.
 */
function jsonPage(bytes: Uint8Array, offset: number, maxBytes: number) {
  let start = Math.min(offset, bytes.length);
  while (start > 0 && isContinuation(bytes[start])) start -= 1;
  let end = start;
  let size = 0;
  while (end < bytes.length) {
    const lead = bytes[end] ?? 0;
    const cost = jsonLength(lead);
    if (end > start && size + cost > maxBytes) break;
    size += cost;
    end += utf8Length(lead);
  }
  return {
    text: decoder.decode(bytes.subarray(start, end)),
    start,
    nextOffset: end < bytes.length ? end : null,
  };
}

const readableChars = (text: string) =>
  (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * The read view of retained content: compact text from the HTML body when the
 * text part is empty or carries less readable text, or instead one explicitly
 * requested raw HTML page. Long retailer HTML is mostly inline styles and
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
  const page =
    input.includeHtml && html
      ? jsonPage(
          html,
          input.offset ?? 0,
          input.maxBytes ?? MAIL_READ_HTML_PAGE_MAX_BYTES,
        )
      : null;
  // An HTML page replaces the text so the response stays under the agent cap.
  const textPage =
    page === null && body !== null
      ? jsonPage(encoder.encode(body), 0, MAIL_READ_TEXT_MAX_BYTES)
      : null;
  const truncated =
    page === null
      ? (compacted && compact.truncated) ||
        (textPage !== null && textPage.nextOffset !== null)
      : page.start > 0 || page.nextOffset !== null;
  return {
    snippet: content.snippet,
    bodyText: textPage?.text ?? null,
    bodyHtml: page?.text ?? null,
    nextOffset: page?.nextOffset ?? null,
    ...(content.headers ? { headers: content.headers } : {}),
    htmlBytes: html?.length ?? null,
    compacted,
    truncated,
    links: (compact?.links ?? [])
      .slice(0, MAIL_READ_MAX_LINKS)
      .map(({ href, text }) => ({ href, text })),
  };
}
