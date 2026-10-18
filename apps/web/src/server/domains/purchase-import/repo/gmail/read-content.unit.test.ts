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
      expect.objectContaining({
        name: "AppError",
        code: "BAD_REQUEST",
        reason: "MAIL_READ_TOO_LARGE",
      }),
    );
  });

  it("continues a shortened multibyte HTML page without losing characters", () => {
    const html = `<table>${"<td>€5 日本 🧾</td>".repeat(9_000)}</table>`;
    const content = mailReadContent(mail(html), { includeHtml: true });
    const fitted = fitMailRead({ content, attachments: descriptors });
    expect(fitted.content.bodyShortened).toBe(true);
    const parts = [fitted.content.bodyHtml ?? ""];
    let offset = fitted.content.nextOffset;
    while (offset !== null) {
      const page = mailReadContent(mail(html), { includeHtml: true, offset });
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
      parts.push(page.bodyHtml ?? "");
      offset = page.nextOffset;
    }
    expect(parts.join("")).toBe(html);
  });
});

// Regression: a background Mail import coordinator kept every Email read in
// context; tracker-wrapped links and transport headers made each read ~63 KB
// around a ~1.5 KB body, so one 50-Email Run spent its budget on noise.
describe("mailReadContent default read size", () => {
  const tracker = (index: number) =>
    `https://click.mailer.example/r?d=${index}${"Z".repeat(1_400)}`;
  const anchors = Array.from(
    { length: 60 },
    (_, index) => `<a href="${tracker(index)}">Track delivery ${index}</a>`,
  ).join(" ");
  const bodyHtml = `<p>Order #SYN-1001 total $12.34</p><a href="https://vendor.example/p/widget">Synthetic Widget</a> ${anchors}`;
  const headers = {
    from: "Orders <orders@vendor.example>",
    to: "member@example.com",
    subject: "Your order #SYN-1001",
    date: "Sat, 17 Oct 2026 09:00:00 -0700",
    "dkim-signature": "v=1; b=".padEnd(2_000, "x"),
    "arc-seal": "i=1; b=".padEnd(2_000, "y"),
    received: "from mx.example by mx.example".padEnd(1_500, "z"),
  };
  const read = mailReadContent(
    { snippet: null, bodyText: null, bodyHtml, headers },
    {},
  );

  it("keeps the vendor link and stays small", () => {
    expect(read.links.map(({ href }) => href)).toContain(
      "https://vendor.example/p/widget",
    );
    expect(read.linksOmitted).toBeGreaterThan(0);
    expect(serialized(read)).toBeLessThan(12_000);
  });

  it("keeps addressing, identity and forwarding headers only", () => {
    const forwarded = mailReadContent(
      {
        snippet: null,
        bodyText: "Synthetic body",
        bodyHtml: null,
        headers: { ...headers, "x-forwarded-for": "member@example.com" },
      },
      {},
    );
    expect(Object.keys(read.headers ?? {}).sort()).toEqual([
      "date",
      "from",
      "subject",
      "to",
    ]);
    expect(forwarded.headers).toHaveProperty("x-forwarded-for");
  });
});

// Failures: the coordinator opens raw HTML because the compact read lacks
// item images, the preheader or structured data, or because a long compact
// body cannot be continued; image lists grow without bound.
describe("mailReadContent compact evidence", () => {
  const items = Array.from(
    { length: 30 },
    (_, index) =>
      `<tr><td><img src="https://img.vendor.example/item-${index}.jpg" alt="Product Image" width="80" height="80"></td><td>Synthetic item ${index}</td><td>$${index}.99</td></tr>`,
  ).join("");
  const bodyHtml = `<div style="display:none">Your synthetic order is confirmed</div><img src="https://img.vendor.example/logo.png" alt="Vendor logo" width="120" height="40"><table>${items}</table><p>Total $435.70</p><script type="application/ld+json">{"@type":"Order","orderNumber":"SYN-1001"}</script>`;
  const read = mailReadContent({ snippet: null, bodyText: null, bodyHtml }, {});

  it("carries the preheader, bounded item images and structured data", () => {
    expect(read.preheader).toBe("Your synthetic order is confirmed");
    expect(read.images.length).toBeGreaterThan(0);
    expect(read.images.map(({ src }) => src)).not.toContain(
      "https://img.vendor.example/logo.png",
    );
    expect(serialized(read.images)).toBeLessThanOrEqual(4_000);
    expect(read.images.length + read.imagesOmitted).toBe(30);
    expect(read.structuredData.join("")).toContain("SYN-1001");
  });

  it("pages a long compact body by offset without losing characters", () => {
    const text = "Synthetic line item €1.00 🧾\n".repeat(8_000);
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = mailReadContent(
        { snippet: null, bodyText: text, bodyHtml: null },
        { offset },
      );
      expect(page.bodyHtml).toBeNull();
      parts.push(page.bodyText ?? "");
      offset = page.nextOffset;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
  });

  // Failure: every page of a long body reports truncated, so the coordinator
  // resolves a fully read Email unresolved; an offset past the end reads as
  // an empty, complete body.
  it("reports only an unfinished page or missing evidence as truncated", () => {
    const text = "Synthetic line item $1.00\n".repeat(8_000);
    const first = mailReadContent(
      { snippet: null, bodyText: text, bodyHtml: null },
      {},
    );
    expect(first.truncated).toBe(true);
    let last = first;
    while (last.nextOffset !== null)
      last = mailReadContent(
        { snippet: null, bodyText: text, bodyHtml: null },
        { offset: last.nextOffset },
      );
    expect(last.truncated).toBe(false);
    expect(() =>
      mailReadContent(
        { snippet: null, bodyText: text, bodyHtml: null },
        { offset: (first.textBytes ?? 0) + 10 },
      ),
    ).toThrow(/past the end/u);
  });

  it("continues a body that fitMailRead shortened from its nextOffset", () => {
    const text = "Synthetic line item $1.00\n".repeat(6_000);
    const descriptors = Array.from({ length: 100 }, (_, index) => ({
      attachmentId: `synthetic-attachment-${index}-${"x".repeat(150)}`,
      filename: `synthetic-receipt-${index}-${"y".repeat(800)}.pdf`,
      mimeType: "application/pdf",
      checksum: "c".repeat(64),
    }));
    const first = fitMailRead({
      content: mailReadContent(
        { snippet: null, bodyText: text, bodyHtml: null },
        {},
      ),
      attachments: descriptors,
    });
    expect(first.content.bodyShortened).toBe(true);
    const rest = mailReadContent(
      { snippet: null, bodyText: text, bodyHtml: null },
      { offset: first.content.nextOffset ?? -1 },
    );
    expect(
      `${first.content.bodyText}${rest.bodyText}`.startsWith(
        text.slice(0, 200_000),
      ),
    ).toBe(true);
  });
});
