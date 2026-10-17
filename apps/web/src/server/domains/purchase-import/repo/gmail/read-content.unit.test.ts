/**
 * Failures: HTML pages split a multibyte character and the next page skips
 * it; a page smaller than one character returns nothing and never advances;
 * an HTML read carries the compact text too and its JSON-escaped page
 * overflows the purchase agent's output cap, which then cuts it again.
 */
import {
  MAIL_READ_RESPONSE_MAX_BYTES,
  mailReadAgentText,
} from "@cubby/schemas/mailbox-research";
import { describe, expect, it } from "vitest";

import { fitMailRead, mailReadContent } from "./read-content";

const mail = (bodyHtml: string, bodyText: string | null = null) => ({
  snippet: null,
  bodyText,
  bodyHtml,
});

function pages(bodyHtml: string, maxBytes: number) {
  const parts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = mailReadContent(mail(bodyHtml), {
      includeHtml: true,
      offset,
      maxBytes,
    });
    expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
    parts.push(page.bodyHtml ?? "");
    offset = page.nextOffset;
  }
  return parts;
}

describe("mailReadContent HTML paging", () => {
  it("reconstructs a multibyte body exactly from nextOffset pages", () => {
    const bodyHtml = "<p>€5 — 日本 🧾 total</p>";
    for (const maxBytes of [1, 2, 3, 5, 7, 64])
      expect(pages(bodyHtml, maxBytes).join("")).toBe(bodyHtml);
  });

  it("advances by one whole character when maxBytes is smaller than it", () => {
    const parts = pages("🧾€", 1);
    expect(parts).toEqual(["🧾", "€"]);
  });

  it("returns a null nextOffset when the page reaches the end", () => {
    const page = mailReadContent(mail("<p>done</p>"), { includeHtml: true });
    expect(page.bodyHtml).toBe("<p>done</p>");
    expect(page.nextOffset).toBeNull();
  });
});

const serialized = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("mailReadContent response bound", () => {
  it("keeps a default HTML read under the agent's output cap", () => {
    // Quote- and control-heavy markup grows under JSON escaping.
    const cell = '<td style="a:b" data-x="\\"></td>\u0001';
    const bodyHtml = `<table>${cell.repeat(20_000)}</table>`;
    const text = "Synthetic line item $1.00\n".repeat(6_000);
    const page = mailReadContent(mail(bodyHtml, text), { includeHtml: true });
    expect(page.bodyHtml).not.toBe("");
    expect(page.bodyText).toBeNull();
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(serialized(page)).toBeLessThan(MAIL_READ_RESPONSE_MAX_BYTES);
  });

  it("keeps an escape-heavy text read under the agent's output cap", () => {
    const text = '"q"\n\t\u0001\n'.repeat(60_000);
    const read = mailReadContent(
      { snippet: null, bodyText: text, bodyHtml: null },
      {},
    );
    expect(read.truncated).toBe(true);
    expect(serialized(read)).toBeLessThan(MAIL_READ_RESPONSE_MAX_BYTES);
  });
});

// Failure: with every link and header gone, a full body plus many attachment
// descriptors still overflows the cap, or associations alone do and an
// oversized payload goes out anyway.
describe("fitMailRead minimum response", () => {
  const descriptors = Array.from({ length: 100 }, (_, index) => ({
    attachmentId: `synthetic-attachment-${index}-${"x".repeat(150)}`,
    filename: `synthetic-receipt-${index}-${"y".repeat(800)}.pdf`,
    mimeType: "application/pdf",
    checksum: "c".repeat(64),
  }));
  const agentBytes = (value: { originalAttachment?: undefined } & object) =>
    new TextEncoder().encode(mailReadAgentText(value)).length;

  it("shortens the text body and reports it", () => {
    const text = "Synthetic line item $1.00\n".repeat(6_000);
    const content = mailReadContent(
      { snippet: null, bodyText: text, bodyHtml: null },
      {},
    );
    const fitted = fitMailRead({ content, attachments: descriptors });
    expect(agentBytes(fitted)).toBeLessThanOrEqual(
      MAIL_READ_RESPONSE_MAX_BYTES,
    );
    expect(fitted.content).toMatchObject({
      bodyShortened: true,
      truncated: true,
    });
    expect(text.startsWith(fitted.content.bodyText ?? "-")).toBe(true);
    expect(fitted.content.bodyText?.length).toBeGreaterThan(0);
  });

  it("shortens an HTML page and continues it from an earlier nextOffset", () => {
    const html = `<table>${'<td class="c">cell</td>'.repeat(8_000)}</table>`;
    const content = mailReadContent(mail(html), { includeHtml: true });
    const fitted = fitMailRead({ content, attachments: descriptors });
    expect(agentBytes(fitted)).toBeLessThanOrEqual(
      MAIL_READ_RESPONSE_MAX_BYTES,
    );
    const next = fitted.content.nextOffset ?? 0;
    expect(next).toBeLessThan(content.nextOffset ?? 0);
    expect(fitted.content.bodyHtml).toBe(html.slice(0, next));
    expect(fitted.content.bodyShortened).toBe(true);
  });

  it("refuses a read whose associations alone overflow the cap", () => {
    const content = mailReadContent(mail("<p>Synthetic</p>"), {});
    const purchaseAssociations = Array.from({ length: 6_000 }, (_, index) => ({
      purchaseId: `PUR-${index}`,
      purchaseDeleted: false,
      kind: "linked",
    }));
    expect(() => fitMailRead({ content, purchaseAssociations })).toThrow(
      /response cap/,
    );
  });
});
