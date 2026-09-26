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
  // Present only on an order-details entry whose order id has more than one
  // shipment (a real order that shipped in separate parcels).
  shipmentLabel: z.string().nullable().optional(),
});
type ExpectedOrder = z.infer<typeof expectedOrderSchema>;

const round2 = (value: number) => Math.round(value * 100) / 100;

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

  describe("order/email consistency", () => {
    // Every order-details entry, grouped by its (synthetic) order id. An
    // order id with more than one entry is a split-shipment order: the same
    // real order rendered across separate order-details pages, one per
    // shipment.
    const detailsByOrderId = new Map<string, ExpectedOrder[]>();
    for (const entry of expected) {
      if (!entry.file.startsWith("order-details-")) continue;
      const group = detailsByOrderId.get(entry.orderId) ?? [];
      group.push(entry);
      detailsByOrderId.set(entry.orderId, group);
    }
    const emails = expected.filter((entry) =>
      entry.file.startsWith("order-email-"),
    );

    it("has at least one split-shipment order id and at least one email in the fixture set", () => {
      // Guards against a future edit silently dropping the split-shipment
      // case or all the email fixtures, which would make the checks below
      // vacuously pass.
      const splitShipmentOrderIds = [...detailsByOrderId.entries()].filter(
        ([, group]) => group.length > 1,
      );
      expect(splitShipmentOrderIds.length).toBeGreaterThan(0);
      expect(emails.length).toBeGreaterThan(0);
    });

    it("labels every split-shipment order-details page and keeps its shipments on one order date", () => {
      for (const [orderId, shipments] of detailsByOrderId) {
        if (shipments.length < 2) continue;
        const firstDate = shipments[0]!.orderedAt;
        for (const shipment of shipments) {
          expect(
            shipment.orderedAt,
            `${shipment.file} (order ${orderId})`,
          ).toBe(firstDate);
          const html = readFileSync(
            path.join(FIXTURE_DIR, shipment.file),
            "utf8",
          );
          expect(html).toMatch(/Shipment \d+ of \d+/u);
        }
      }
    });

    it.each(emails)(
      "agrees with its matching order-details shipment(s) on order date, item lines, and grand total ($file)",
      (email) => {
        const shipments = detailsByOrderId.get(email.orderId);
        expect(
          shipments,
          `no order-details fixture shares order id ${email.orderId} with ${email.file}`,
        ).toBeDefined();

        // Order date: the email and every shipment of its order agree.
        for (const shipment of shipments!) {
          expect(email.orderedAt).toBe(shipment.orderedAt);
        }

        // Grand total: the email's total is the sum across all shipments of
        // the order (one shipment, in the common case).
        const combinedTotal = round2(
          shipments!.reduce((sum, shipment) => sum + shipment.grandTotal, 0),
        );
        expect(email.grandTotal).toBeCloseTo(combinedTotal, 2);

        // Item lines and per-line prices: the email lists the same products
        // (by title) at the same unit price as the combined shipments, order
        // aside (an email lists items in whatever order the confirmation
        // used, not necessarily shipment order).
        const combinedItems = shipments!.flatMap((shipment) => shipment.items);
        const sortKey = (item: { title: string; unitPrice: number }) =>
          `${item.title}|${item.unitPrice}`;
        expect(email.items.map(sortKey).sort()).toEqual(
          combinedItems.map(sortKey).sort(),
        );
      },
    );
  });
});
