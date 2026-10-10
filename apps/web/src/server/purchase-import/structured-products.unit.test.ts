import { describe, expect, it } from "vitest";

import { structuredProductsFromJsonLd } from "./structured-products";

// The JSON-LD walker that decides whether a page proves one exact variant. It
// moved from the Mac's capture script to the server unchanged; these are the
// cases its Mac tests pinned. Every bound fails closed (a variant group).
const walk = (pageURL: string, blocks: string[], omitted = 0) =>
  structuredProductsFromJsonLd({ pageURL, blocks, omitted });

const shopifyTee = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Forgewear Tee",
  productID: "8800001",
  mpn: "TEE-100",
  sku: "FW-TEE-BLK-S",
  gtin13: "0036000291452",
  offers: [
    {
      "@type": "Offer",
      sku: "FW-TEE-BLK-S",
      gtin13: "0036000291452",
      mpn: "TEE-100-S",
      url: "https://shop.forgewear.example.test/products/tee?variant=41000000000111",
    },
    {
      "@type": "Offer",
      sku: "FW-TEE-BLK-M",
      gtin13: "0036000291469",
      mpn: "TEE-100-M",
      url: "https://shop.forgewear.example.test/products/tee?variant=41000000000222",
    },
  ],
});

const offer = (sku: string, variant: number) => ({
  "@type": "Offer",
  sku,
  url: `https://shop.forgewear.example.test/products/tee?variant=${variant}`,
});

const base = "https://shop.forgewear.example.test/products/tee";

describe("structured product identifiers from JSON-LD", () => {
  it("keeps agreeing Offer identifiers when its URL makes no variant claim", () => {
    const block = JSON.stringify({
      "@type": "Product",
      sku: "SYN-EXACT",
      offers: {
        "@type": "Offer",
        sku: "SYN-EXACT",
        url: "https://affiliate.example.test/tee",
      },
    });
    const capture = walk("https://shop.example.test/products/tee?variant=111", [
      block,
    ]);
    expect(capture.variantGroup).toBe(false);
  });

  it("contributes a Shopify Product's single Offer", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Forgewear Mug",
      mpn: "MUG-1",
      offers: {
        "@type": "Offer",
        sku: "FW-MUG-1",
        gtin12: "036000291452",
        url: "https://shop.forgewear.example.test/products/mug?variant=41000000000333",
      },
    });
    expect(
      walk("https://shop.forgewear.example.test/products/mug", [block]),
    ).toEqual({
      products: [
        {
          skus: ["FW-MUG-1"],
          mpns: ["MUG-1"],
          gtins: ["036000291452"],
          productIds: [],
        },
      ],
      variantGroup: false,
    });
  });

  it("merges Offers with identical identifiers into their Product", () => {
    const offerRow = (price: string) => ({
      "@type": "Offer",
      sku: "FW-MUG-1",
      gtin12: "036000291452",
      price,
      url: "https://shop.forgewear.example.test/products/mug?variant=41000000000333",
    });
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Forgewear Mug",
      offers: [offerRow("12.00"), offerRow("10.00")],
    });
    expect(
      walk("https://shop.forgewear.example.test/products/mug", [block]),
    ).toEqual({
      products: [
        {
          skus: ["FW-MUG-1"],
          mpns: [],
          gtins: ["036000291452"],
          productIds: [],
        },
      ],
      variantGroup: false,
    });
  });

  it("lets the served ?variant= select one Offer and drops default-variant identifiers", () => {
    expect(walk(`${base}?variant=41000000000222`, [shopifyTee])).toEqual({
      products: [
        {
          skus: ["FW-TEE-BLK-M"],
          mpns: ["TEE-100", "TEE-100-M"],
          gtins: ["0036000291469"],
          productIds: ["8800001"],
        },
      ],
      variantGroup: false,
    });
  });

  it("does not select an Offer on another host or product path by a coincident variant id", () => {
    for (const url of [
      "https://other.example.test/products/tee?variant=222",
      "https://shop.forgewear.example.test/products/other?variant=222",
      "https://member:secret@shop.forgewear.example.test/products/tee?variant=222",
    ]) {
      const block = JSON.stringify({
        "@type": "Product",
        sku: "SYN-DEFAULT",
        offers: { "@type": "Offer", sku: "SYN-OTHER", url },
      });
      const result = walk(`${base}?variant=222`, [block]);
      expect(result.variantGroup).toBe(true);
      expect(result.products.map((product) => product.skus)).toEqual([
        ["SYN-DEFAULT"],
      ]);
    }
  });

  it("refuses repeated Offer variants revealed by URL control-character normalization", () => {
    for (const control of ["\n", "\r", "\t"]) {
      const block = JSON.stringify({
        "@type": "Product",
        sku: "SYN-DEFAULT",
        offers: {
          "@type": "Offer",
          sku: "SYN-SELECTED",
          url: `/products/tee?vari${control}ant=111&variant=222`,
        },
      });
      expect(walk(`${base}?variant=222`, [block]).variantGroup).toBe(true);
      const singleOffer = JSON.stringify({
        "@type": "Product",
        sku: "SYN-DEFAULT",
        offers: offer("SYN-SELECTED", 222),
      });
      expect(
        walk(`${base}?vari${control}ant=111&variant=222`, [singleOffer])
          .variantGroup,
      ).toBe(true);
    }
  });

  it("resolves a relative Offer on the served product page without matching unrelated query parameters", () => {
    const block = JSON.stringify({
      "@type": "Product",
      sku: "SYN-DEFAULT",
      offers: {
        "@type": "Offer",
        sku: "SYN-SELECTED",
        url: "/products/tee?variant=222&utm_source=synthetic",
      },
    });
    const result = walk(`${base}?variant=222#details`, [block]);
    expect(result.variantGroup).toBe(false);
    expect(result.products.map((product) => product.skus)).toEqual([
      ["SYN-SELECTED"],
    ]);
  });

  it("reads differing Offers without a served variant as an ambiguous group", () => {
    expect(walk(base, [shopifyTee]).variantGroup).toBe(true);
    expect(
      walk(`${base}?variant=41000000000999`, [shopifyTee]).variantGroup,
    ).toBe(true);
  });

  it("fails closed for an Offer beyond the offer cap", () => {
    const offers = [
      ...Array.from({ length: 100 }, () => offer("FW-SAME", 1)),
      offer("FW-OTHER", 2),
    ];
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      offers,
    });
    expect(walk(base, [block]).variantGroup).toBe(true);
  });

  it("never lets Offers starve the graph walk, and fails closed when it is exhausted", () => {
    const offers = Array.from({ length: 100 }, () => offer("FW-SAME", 1));
    const second = { "@type": "Product", sku: "FW-SECOND" };
    const graph = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        ...Array.from({ length: 398 }, () => ({ "@type": "WebPage" })),
        { "@type": "Product", offers },
        second,
      ],
    });
    expect(walk(base, [graph]).products).toHaveLength(2);
    const overflow = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        ...Array.from({ length: 600 }, () => ({ "@type": "WebPage" })),
        { "@type": "ProductGroup" },
        second,
      ],
    });
    expect(walk(base, [overflow]).variantGroup).toBe(true);
  });

  it("never merges a single Offer naming another variant with the Product's default", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      sku: "FW-DEFAULT-S",
      offers: offer("FW-OTHER-M", 222),
    });
    expect(walk(`${base}?variant=111`, [block]).variantGroup).toBe(true);
    const servedM = walk(`${base}?variant=222`, [block]);
    expect(servedM.variantGroup).toBe(false);
    expect(servedM.products.map((product) => product.skus)).toEqual([
      ["FW-OTHER-M"],
    ]);
  });

  it("selects an Offer only by the query's single decoded variant parameter", () => {
    expect(
      walk(`${base}#?variant=41000000000222`, [shopifyTee]).variantGroup,
    ).toBe(true);
    expect(
      walk(`${base}?variant=41000000000111&variant=41000000000222`, [
        shopifyTee,
      ]).variantGroup,
    ).toBe(true);
    const encoded = walk(`${base}?vari%61nt=41000000000222#reviews`, [
      shopifyTee,
    ]);
    expect(encoded.variantGroup).toBe(false);
    expect(encoded.products.map((product) => product.skus)).toEqual([
      ["FW-TEE-BLK-M"],
    ]);
  });

  it("fails closed on an identifier longer than it keeps instead of comparing a prefix", () => {
    const prefix = "X".repeat(100);
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      sku: `${prefix}S`,
      gtin13: "0036000291452",
      offers: offer(`${prefix}M`, 222),
    });
    expect(walk(`${base}?variant=222`, [block]).variantGroup).toBe(true);
  });

  it("never takes the agreement shortcut for a repeated or undecodable served variant", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      sku: "SYN-S",
      offers: offer("SYN-S", 111),
    });
    for (const query of ["?variant=111&variant=222", "?variant=%ZZ"])
      expect(walk(base + query, [block]).variantGroup).toBe(true);
    const absent = walk(base, [block]);
    expect(absent.variantGroup).toBe(false);
    expect(absent.products.map((product) => product.skus)).toEqual([["SYN-S"]]);
  });

  // Blocks the page compactor left out (too many or too large) leave the
  // structured data incomplete, so the page can never read as exact.
  it("fails closed when JSON-LD blocks were omitted", () => {
    const block = JSON.stringify({ "@type": "Product", sku: "SYN-S" });
    expect(walk(base, [block], 1).variantGroup).toBe(true);
    expect(walk(base, ["{not json", block]).variantGroup).toBe(false);
  });
});
