import { sha256Hex } from "@cubby/shared/sha256";
import { describe, expect, it } from "vitest";

import {
  PAGE_DERIVATION_REVISION,
  derivePageCapture,
  encodeSnapshotDom,
  readSnapshotDom,
  urlAllowed,
} from "./browser-page";

const page = `<!doctype html><html><head><title>Order 42 | Example Seeds</title>
<link rel="canonical" href="https://seeds.example.test/account/orders/42">
<script type="application/ld+json">{"@type":"Product","sku":"BS-1"}</script>
</head><body>
<h1>Order 42</h1><p>Basil seed packet  $4.00</p>
<a href="/account/orders/41">Previous order</a>
<a href="https://tracker.example.net/x">Track</a>
<img src="https://seeds.example.test/img/basil.jpg" alt="Basil" width="300">
<img src="https://cdn.example.net/ad.jpg" alt="Ad">
</body></html>`;

describe("a captured page derived on the server", () => {
  // The Mac sends the DOM deflated; a snapshot whose bytes do not match its
  // checksum is refused rather than read as some other page.
  it("round-trips a snapshot's DOM and refuses one that does not match its checksum", async () => {
    const dom = await encodeSnapshotDom(page);
    expect(await readSnapshotDom(dom)).toBe(page);
    await expect(
      readSnapshotDom({ ...dom, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/checksum/u);
    expect(dom.sha256).toBe(await sha256Hex(page));
  });

  it("derives text, allowlisted links and images, structured data, and sign-in", () => {
    const capture = derivePageCapture({
      html: page,
      sourceURL: "https://seeds.example.test/account/orders/42",
      title: "Order 42 | Example Seeds",
      capturedAt: "2026-10-07T12:00:00.000Z",
      allowedHosts: ["seeds.example.test"],
      requestedURL: null,
      evidence: [],
      truncated: false,
    });
    expect(capture.captureVersion).toBe(PAGE_DERIVATION_REVISION);
    expect(capture.readableText).toBe(
      "Order 42\nBasil seed packet $4.00\nPrevious order Track",
    );
    expect(capture.links).toEqual([
      {
        id: "link-1",
        url: "https://seeds.example.test/account/orders/41",
        label: "Previous order",
      },
    ]);
    expect(capture.images).toEqual([
      {
        url: "https://seeds.example.test/img/basil.jpg",
        alt: "Basil",
        naturalWidth: 300,
        naturalHeight: null,
        highResolutionUrl: null,
      },
    ]);
    expect(capture.canonicalUrl).toBe(
      "https://seeds.example.test/account/orders/42",
    );
    expect(capture.structuredProducts).toEqual({
      products: [{ skus: ["BS-1"], mpns: [], gtins: [], productIds: [] }],
      variantGroup: false,
    });
    expect(capture.authenticationRequired).toBe(false);
  });

  // The Mac clips an oversized DOM's tail; a Product block before the cut
  // must not read as the page's one exact Product.
  it("treats a truncated page's structured data as incomplete", () => {
    const capture = derivePageCapture({
      html: page,
      sourceURL: "https://seeds.example.test/account/orders/42",
      title: "Order 42",
      capturedAt: "2026-10-07T12:00:00.000Z",
      allowedHosts: ["seeds.example.test"],
      requestedURL: null,
      evidence: [],
      truncated: true,
    });
    expect(capture.structuredProducts?.variantGroup).toBe(true);
  });

  it("reads a password field as a sign-in page and Amazon ASINs from the URLs", () => {
    const capture = derivePageCapture({
      html: '<html><body><form><input type="password"></form></body></html>',
      sourceURL: "https://www.amazon.com/dp/B000000002?th=1",
      title: "Sign in",
      capturedAt: "2026-10-07T12:00:00.000Z",
      allowedHosts: ["amazon.com"],
      requestedURL: "https://www.amazon.com/gp/product/B000000001",
      evidence: [],
      truncated: false,
    });
    expect(capture.authenticationRequired).toBe(true);
    expect(capture.requestedAmazonAsin).toBe("B000000001");
    expect(capture.servedAmazonAsin).toBe("B000000002");
  });

  it("allows only https on an allowlisted host or its subdomain, without credentials or fragments", () => {
    const hosts = ["example.test"];
    expect(urlAllowed("https://shop.example.test/a", hosts)).toBe(true);
    expect(urlAllowed("https://example.test/a", hosts)).toBe(true);
    expect(urlAllowed("https://notexample.test/a", hosts)).toBe(false);
    expect(urlAllowed("http://example.test/a", hosts)).toBe(false);
    expect(urlAllowed("https://user:pw@example.test/a", hosts)).toBe(false);
    expect(urlAllowed("https://example.test/a#x", hosts)).toBe(false);
  });
});
