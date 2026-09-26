import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { BrowserCapture } from "@cubby/schemas/purchase-import";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { classifyOrderCapture } from "./order-list";

/**
 * Loads the realistic-markup synthetic retailer corpus (built by
 * apps/web/tooling/build-retailer-corpus.ts) and runs it through Cubby's
 * deterministic order-capture classifier, the one piece of order parsing
 * that does not depend on an AI model call. Per-item/total extraction
 * (extractPurchaseEvidence in src/server/agents/purchase-import/extract.ts)
 * is model-driven and is out of scope for a fixture-only unit test.
 */

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../../../tests/e2e/fixtures/retailer-corpus",
);
const ALLOWED_HOSTS = ["www.amazon.example"];

const expectedOrderSchema = z.object({
  file: z.string(),
  orderId: z.string(),
  orderedAt: z.string(),
  grandTotal: z.number(),
  currency: z.literal("USD"),
  items: z.array(
    z.object({ asin: z.string(), title: z.string(), unitPrice: z.number() }),
  ),
});
type ExpectedOrder = z.infer<typeof expectedOrderSchema>;

function loadExpected(): ExpectedOrder[] {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf8"),
  );
  return z.array(expectedOrderSchema).parse(raw);
}

/** Builds a BrowserCapture the way a browser-extension capture would:
 * page text, every link, and every image, extracted from the real DOM. */
function captureFromHtml(html: string, url: string): BrowserCapture {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const text = (doc.body?.textContent ?? "").replace(/\s+/gu, " ").trim();
  const links = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")].map(
    (a, index) => ({
      id: `l${index}`,
      href: new URL(a.getAttribute("href")!, url).toString(),
      text: (a.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 500),
    }),
  );
  const images = [...doc.querySelectorAll<HTMLImageElement>("img[src]")].map(
    (img) => ({
      src: new URL(img.getAttribute("src")!, url).toString(),
      alt: (img.getAttribute("alt") ?? "").slice(0, 500),
    }),
  );
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  dom.window.close();
  return {
    url,
    title,
    text: text.slice(0, 24 * 1024),
    links,
    images,
    capturedAt: "2031-01-10T00:00:00.000Z",
  };
}

describe("retailer order corpus", () => {
  const expected = loadExpected();
  const fixtureFiles = readdirSync(FIXTURE_DIR).filter((name) =>
    name.endsWith(".html"),
  );

  it("has an expected.json ground-truth entry for every fixture page", () => {
    const expectedFiles = new Set(expected.map((entry) => entry.file));
    for (const file of fixtureFiles) expect(expectedFiles.has(file)).toBe(true);
    expect(expected).toHaveLength(fixtureFiles.length);
  });

  it.each(expected.filter((entry) => entry.file.startsWith("order-details-")))(
    "classifies $file as a single order and finds its synthetic order id",
    (entry) => {
      const html = readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8");
      const url = `https://www.amazon.example/gp/your-account/order-details?orderID=${entry.orderId}`;
      const capture = captureFromHtml(html, url);

      const result = classifyOrderCapture(capture, {
        allowedHosts: ALLOWED_HOSTS,
      });
      expect(result.kind).toBe("order");

      // The classifier only labels a details page as "order"; the id/date/
      // total/items themselves come from the AI extraction pipeline. This
      // fixture still asserts those synthetic values are present in the
      // page text at all, i.e. that the builder produced a findable order.
      expect(capture.text).toContain(entry.orderId);
      expect(capture.text).toContain(`$${entry.grandTotal.toFixed(2)}`);
      for (const item of entry.items) {
        expect(capture.text).toContain(item.title);
        expect(capture.text).toContain(`$${item.unitPrice.toFixed(2)}`);
        expect(
          capture.links.some((link) => link.href.includes(item.asin)),
        ).toBe(true);
      }
    },
  );

  it.each(expected.filter((entry) => entry.file.startsWith("order-email-")))(
    "classifies $file's confirmation text as a single order",
    (entry) => {
      const html = readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8");
      const url = "https://mail.google.example/mail/u/0/";
      const capture = captureFromHtml(html, url);

      const result = classifyOrderCapture(capture, {
        allowedHosts: ALLOWED_HOSTS,
      });
      expect(result.kind).toBe("order");
      expect(capture.text).toContain(entry.orderId);
      expect(capture.text).toContain(`$${entry.grandTotal.toFixed(2)}`);
    },
  );
});
