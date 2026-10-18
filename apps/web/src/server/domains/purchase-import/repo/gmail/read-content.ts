import {
  MAIL_READ_HTML_PAGE_MAX_BYTES,
  MAIL_READ_IMAGES_MAX_BYTES,
  MAIL_READ_LINKS_MAX_BYTES,
  MAIL_READ_RESPONSE_MAX_BYTES,
  MAIL_READ_STRUCTURED_MAX_BYTES,
  MAIL_READ_TEXT_MAX_BYTES,
  type MailReadContent,
  type MailReadInput,
  type MailAttachmentOriginal,
  type MailReadOut,
  mailAttributionHeaders,
  mailReadAgentText,
  type RetainedMailContent,
} from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";
import { createAppError } from "~/server/errors/app-error";

const MAIL_READ_MAX_LINKS = 40;
const MAIL_READ_IDENTITY_HEADERS = ["subject", "date", "message-id"];

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

/**
 * The compactor's cue-first links that fit MAIL_READ_LINKS_MAX_BYTES. Trackers
 * labelled "Track delivery" rank first, so an oversized one is skipped rather
 * than ending the list, leaving room for a later short product link.
 */
function boundedLinks(links: readonly { href: string; text: string }[]) {
  const kept: { href: string; text: string }[] = [];
  let bytes = 0;
  for (const { href, text } of links) {
    if (kept.length === MAIL_READ_MAX_LINKS) break;
    const size = encoder.encode(JSON.stringify({ href, text })).length;
    if (bytes + size > MAIL_READ_LINKS_MAX_BYTES) continue;
    kept.push({ href, text });
    bytes += size;
  }
  return { links: kept, linksOmitted: links.length - kept.length };
}

/** Whole items, in order, while their serialized size fits `maxBytes`. */
function withinBytes<T>(items: readonly T[], maxBytes: number) {
  const kept: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length;
    if (bytes + size > maxBytes) continue;
    kept.push(item);
    bytes += size;
  }
  return { kept, omitted: items.length - kept.length };
}

// Branding and social badges are never an order line's picture.
const DECORATIVE_IMAGE =
  /\b(?:logo|icon|facebook|instagram|twitter|pinterest|youtube|tiktok|linkedin|social)\b/iu;

/**
 * Content images for line `imageUrl`s, purchase-cue images first, each `src`
 * once. Extraction only needs the exact `src` (Cubby checks it against the
 * stored HTML), so the coordinator never pages markup for it.
 */
function boundedImages(
  images: readonly { src: string; alt: string; cue: boolean }[],
) {
  const seen = new Set<string>();
  const candidates = [...images]
    .sort((a, b) => Number(b.cue) - Number(a.cue))
    .filter(({ src, alt }) => {
      if (DECORATIVE_IMAGE.test(alt) || seen.has(src)) return false;
      seen.add(src);
      return true;
    })
    .map(({ src, alt }) => ({ src, alt }));
  const { kept, omitted } = withinBytes(candidates, MAIL_READ_IMAGES_MAX_BYTES);
  return { images: kept, imagesOmitted: omitted };
}

/**
 * Purchase evidence decides between the parts before readable length does:
 * retailers often send a long boilerplate text part while the order table
 * (lines, totals, order number) exists only in the HTML.
 */
function htmlIsRicher(
  compact: { text: string; cues: string[]; readable_chars: number },
  plain: string,
) {
  const missingFrom = (text: string, cues: readonly string[]) => {
    const lower = text.toLowerCase();
    return cues.filter((cue) => !lower.includes(cue.toLowerCase())).length;
  };
  const htmlOnly = missingFrom(plain, compact.cues);
  const plainOnly = missingFrom(compact.text, wasm.purchase_cues(plain).cues);
  if (htmlOnly !== plainOnly) return htmlOnly > plainOnly;
  return compact.readable_chars > readableChars(plain);
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
    (plain === null || htmlIsRicher(compact, plain));
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
      ? jsonPage(body, input.offset ?? 0, MAIL_READ_TEXT_MAX_BYTES)
      : null;
  if (textPage !== null && textPage.text === "" && (input.offset ?? 0) > 0)
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      `Offset ${input.offset} is past the end of this Email's ${encoder.encode(body ?? "").length}-byte compact body.`,
    );
  // A compact page is truncated while more pages follow or evidence is
  // missing; a fully paged body's last page is complete. An HTML page is
  // always a fragment of the original.
  const truncated =
    page === null
      ? (compacted && compact.truncated) ||
        (textPage !== null && textPage.nextOffset !== null)
      : page.start > 0 || page.nextOffset !== null;
  const structured = withinBytes(
    compact?.structured_data ?? [],
    MAIL_READ_STRUCTURED_MAX_BYTES,
  );
  return {
    snippet: content.snippet,
    preheader: compact?.preheader ?? null,
    bodyText: textPage?.text ?? null,
    textBytes: body === null ? null : encoder.encode(body).length,
    bodyHtml: page?.text ?? null,
    nextOffset: page?.nextOffset ?? textPage?.nextOffset ?? null,
    ...(content.headers
      ? {
          headers: mailAttributionHeaders(
            content.headers,
            MAIL_READ_IDENTITY_HEADERS,
          ),
        }
      : {}),
    htmlBytes,
    compacted,
    truncated,
    ...boundedLinks(compact?.links ?? []),
    ...boundedImages(compact?.images ?? []),
    structuredData: structured.kept,
    structuredDataOmitted:
      structured.omitted + (compact?.structured_data_omitted ?? 0),
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
  const pageBytes = encoder.encode(content.bodyText).length;
  const start = (content.nextOffset ?? content.textBytes ?? 0) - pageBytes;
  const page = jsonPage(content.bodyText, 0, budget);
  if (page.nextOffset === null) return content;
  return {
    ...content,
    bodyText: page.text,
    nextOffset: start + page.nextOffset,
    truncated: true,
    bodyShortened: true,
  };
}

/**
 * Bound a whole Email read under the agent's response cap, measured on the
 * exact text the agent adapter emits (`mailReadAgentText`): images and
 * structured data go first, then trailing links, then headers, then the body is cut (an HTML page continues from an
 * earlier `nextOffset`), each reported. Purchase associations are never
 * trimmed; a read whose remaining metadata alone overflows is refused.
 */
export function fitMailRead<
  T extends Pick<MailReadOut, "content"> & {
    originalAttachment?: MailAttachmentOriginal;
  },
>(full: T): T {
  const fits = (candidate: T) =>
    agentBytes(candidate) <= MAIL_READ_RESPONSE_MAX_BYTES;
  if (fits(full)) return full;
  // Images and structured data go first; line evidence lives in the body.
  const { images, structuredData } = full.content;
  const read: T = {
    ...full,
    content: {
      ...full.content,
      images: [],
      imagesOmitted: full.content.imagesOmitted + images.length,
      structuredData: [],
      structuredDataOmitted:
        full.content.structuredDataOmitted + structuredData.length,
    },
  };
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
