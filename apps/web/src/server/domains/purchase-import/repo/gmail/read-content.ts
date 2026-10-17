import {
  MAIL_READ_HTML_PAGE_MAX_BYTES,
  MAIL_READ_RESPONSE_MAX_BYTES,
  MAIL_READ_TEXT_MAX_BYTES,
  type MailReadContent,
  type MailReadInput,
  type MailAttachmentOriginal,
  type MailReadOut,
  mailReadAgentText,
  type RetainedMailContent,
} from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";
import { createAppError } from "~/server/errors/app-error";

const MAIL_READ_MAX_LINKS = 40;

const encoder = new TextEncoder();

const utf8Length = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

const shortEscapes = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** Bytes a character occupies inside a JSON string literal. */
function jsonLength(codePoint: number) {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) return shortEscapes.has(codePoint) ? 2 : 6;
  // JSON.stringify escapes a lone surrogate as \uXXXX.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return utf8Length(codePoint);
}

/**
 * A page of whole characters starting at UTF-8 byte `offset` (moved back to
 * its character's start) whose JSON-escaped size fits `maxBytes`. It holds at
 * least one character, so paging by `nextOffset` always progresses and
 * concatenates back to the original. It walks code points, not a Uint8Array:
 * the byte-indexed loop intermittently ended early under Node 26's Maglev JIT
 * (mail-tool integration suite, passing with --no-maglev).
 */
function jsonPage(text: string, offset: number, maxBytes: number) {
  let byte = 0;
  let index = 0;
  let start: { byte: number; index: number } | null = null;
  let size = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const bytes = utf8Length(codePoint);
    if (start === null && byte + bytes <= offset) {
      byte += bytes;
      index += char.length;
      continue;
    }
    start ??= { byte, index };
    const cost = jsonLength(codePoint);
    if (index > start.index && size + cost > maxBytes)
      return {
        text: text.slice(start.index, index),
        start: start.byte,
        nextOffset: byte,
      };
    size += cost;
    byte += bytes;
    index += char.length;
  }
  return {
    text: start === null ? "" : text.slice(start.index),
    start: start?.byte ?? byte,
    nextOffset: null,
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
  const htmlBytes = content.bodyHtml
    ? encoder.encode(content.bodyHtml).length
    : null;
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
    input.includeHtml && htmlBytes !== null
      ? jsonPage(
          content.bodyHtml ?? "",
          input.offset ?? 0,
          input.maxBytes ?? MAIL_READ_HTML_PAGE_MAX_BYTES,
        )
      : null;
  // An HTML page replaces the text so the response stays under the agent cap.
  const textPage =
    page === null && body !== null
      ? jsonPage(body, 0, MAIL_READ_TEXT_MAX_BYTES)
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
    htmlBytes,
    compacted,
    truncated,
    links: (compact?.links ?? [])
      .slice(0, MAIL_READ_MAX_LINKS)
      .map(({ href, text }) => ({ href, text })),
    linksOmitted: Math.max(
      0,
      (compact?.links.length ?? 0) - MAIL_READ_MAX_LINKS,
    ),
    headersOmitted: false,
    bodyShortened: false,
  };
}

// Room for the MCP envelope around a read's serialized result.
const ENVELOPE_BYTES = 1_000;

const agentBytes = (read: { originalAttachment?: MailAttachmentOriginal }) =>
  encoder.encode(mailReadAgentText(read)).length + ENVELOPE_BYTES;

/** `content` with its body cut to `budget` JSON-escaped bytes, or null when nothing fits. */
function shortenBody(
  content: MailReadContent,
  budget: number,
): MailReadContent | null {
  if (budget < 1) return null;
  if (content.bodyHtml !== null) {
    const pageBytes = encoder.encode(content.bodyHtml).length;
    const start = (content.nextOffset ?? content.htmlBytes ?? 0) - pageBytes;
    const page = jsonPage(content.bodyHtml, 0, budget);
    if (page.nextOffset === null) return content;
    return {
      ...content,
      bodyHtml: page.text,
      nextOffset: start + page.nextOffset,
      truncated: true,
      bodyShortened: true,
    };
  }
  if (content.bodyText === null) return null;
  const page = jsonPage(content.bodyText, 0, budget);
  if (page.nextOffset === null) return content;
  return {
    ...content,
    bodyText: page.text,
    truncated: true,
    bodyShortened: true,
  };
}

/**
 * Bound a whole Email read under the agent's response cap, measured on the
 * exact text the agent adapter emits (`mailReadAgentText`): trailing links go
 * first, then headers, then the body is cut (an HTML page continues from an
 * earlier `nextOffset`), each reported. Purchase associations are never
 * trimmed; a read whose remaining metadata alone overflows is refused.
 */
export function fitMailRead<
  T extends Pick<MailReadOut, "content"> & {
    originalAttachment?: MailAttachmentOriginal;
  },
>(read: T): T {
  const fits = (candidate: T) =>
    agentBytes(candidate) <= MAIL_READ_RESPONSE_MAX_BYTES;
  if (fits(read)) return read;
  const { links } = read.content;
  const withLinks = (kept: number, base: T): T => ({
    ...base,
    content: {
      ...base.content,
      links: links.slice(0, kept),
      linksOmitted: base.content.linksOmitted + links.length - kept,
    },
  });
  let base: T = read;
  if (!fits(withLinks(0, base)) && base.content.headers)
    base = {
      ...base,
      content: { ...base.content, headers: undefined, headersOmitted: true },
    };
  let low = 0;
  let high = links.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(withLinks(mid, base))) low = mid;
    else high = mid - 1;
  }
  let fitted = withLinks(low, base);
  const body = fitted.content.bodyHtml ?? fitted.content.bodyText;
  let budget =
    body === null ? 0 : encoder.encode(JSON.stringify(body)).length - 2;
  while (!fits(fitted)) {
    budget -= agentBytes(fitted) - MAIL_READ_RESPONSE_MAX_BYTES;
    const content = shortenBody(fitted.content, budget);
    if (content === null)
      throw createAppError(
        "MAIL_READ_TOO_LARGE",
        `This Email read is ${agentBytes(fitted)} bytes without links or headers, over the ${MAIL_READ_RESPONSE_MAX_BYTES}-byte response cap even with its body cut; its Purchase associations or attachment list alone are too large.`,
      );
    fitted = { ...fitted, content };
  }
  return fitted;
}
