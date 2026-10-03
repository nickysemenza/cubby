import { describe, expect, it } from "vitest";

import {
  proveStructuredIdentifier,
  structuredPageProvesExactVariant,
  type StructuredPageEvidence,
} from "./structured-identifier-proof";

const node = (
  overrides: Partial<{
    skus: string[];
    mpns: string[];
    gtins: string[];
    productIds: string[];
  }> = {},
) => ({
  skus: ["FW-TEE-BLK-M"],
  mpns: ["TEE-100"],
  gtins: ["036000291452"],
  productIds: [],
  ...overrides,
});

const page = (
  overrides: Partial<StructuredPageEvidence> = {},
): StructuredPageEvidence => ({
  sourceURL: "https://www.forgewear.example.test/p/tee-black-m",
  canonicalUrl: "https://www.forgewear.example.test/p/tee-black-m",
  structuredProducts: { products: [node()], variantGroup: false },
  ...overrides,
});

const hosts = ["forgewear.example.test"];
const sku = (externalId: string, source = "forgewear") => ({
  source,
  kind: "retailer_sku" as const,
  externalId,
});

describe("proveStructuredIdentifier", () => {
  it("proves a SKU on a single-Product vendor page, ignoring case and whitespace", () => {
    expect(
      proveStructuredIdentifier(sku("  fw-tee-blk-m "), page(), hosts),
    ).toEqual({ proven: true, externalId: "FW-TEE-BLK-M" });
  });

  it("proves a GTIN across encodings, normalized to GTIN-14", () => {
    expect(
      proveStructuredIdentifier(
        { source: "gtin", kind: "gtin_14", externalId: "00036000291452" },
        page(),
        hosts,
      ),
    ).toEqual({ proven: true, externalId: "00036000291452" });
  });

  it("rejects a GTIN with a bad check digit even when the page lists the same digits", () => {
    const bad = page({
      structuredProducts: {
        products: [node({ gtins: ["036000291453"] })],
        variantGroup: false,
      },
    });
    expect(
      proveStructuredIdentifier(
        { source: "gtin", kind: "gtin_14", externalId: "036000291453" },
        bad,
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects a ProductGroup page: the selected variant is not proven", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M"),
        page({
          structuredProducts: { products: [node()], variantGroup: true },
        }),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects a page with several Product nodes", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M"),
        page({
          structuredProducts: {
            products: [node(), node({ skus: ["FW-TEE-BLK-L"] })],
            variantGroup: false,
          },
        }),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects a sibling variant after a redirect (page SKU differs)", () => {
    expect(
      proveStructuredIdentifier(sku("FW-TEE-BLK-L"), page(), hosts).proven,
    ).toBe(false);
  });

  it("rejects a served host outside the vendor's browser domains", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M"),
        page({ sourceURL: "https://evil.example.test/p/tee" }),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects a canonical URL that points off the vendor", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M"),
        page({ canonicalUrl: "https://other.example.test/p/tee" }),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects an identifier source that is not the page vendor's slug", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M", "someone-else"),
        page(),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("rejects when an older Mac client sent no structured data", () => {
    expect(
      proveStructuredIdentifier(
        sku("FW-TEE-BLK-M"),
        page({ structuredProducts: undefined }),
        hosts,
      ).proven,
    ).toBe(false);
  });

  it("does not use this path for Amazon ASINs", () => {
    expect(
      proveStructuredIdentifier(
        { source: "amazon", kind: "asin", externalId: "B000000000" },
        page(),
        hosts,
      ).proven,
    ).toBe(false);
  });
});

describe("proveStructuredIdentifier: manufacturer_part", () => {
  const mpn = (externalId: string, source = "forgewear-apparel") => ({
    source,
    kind: "manufacturer_part" as const,
    externalId,
  });
  const maker = { manufacturer: "ForgeWear Apparel" };

  it("proves an MPN from the page mpns when the source is the Product's manufacturer slug, not the vendor's", () => {
    // Vendor slug is "forgewear"; manufacturer slug is "forgewear-apparel".
    expect(
      proveStructuredIdentifier(
        mpn(" tee-100 "),
        page(),
        ["forgewear.example.test"],
        maker,
      ),
    ).toEqual({ proven: true, externalId: "TEE-100" });
  });

  it("refuses the vendor slug as the source of a manufacturer part", () => {
    expect(
      proveStructuredIdentifier(
        mpn("TEE-100", "forgewear"),
        page(),
        hosts,
        maker,
      ).proven,
    ).toBe(false);
  });

  it("refuses when the Product's manufacturer is unknown or blank", () => {
    expect(
      proveStructuredIdentifier(mpn("TEE-100"), page(), hosts).proven,
    ).toBe(false);
    expect(
      proveStructuredIdentifier(mpn("TEE-100"), page(), hosts, {
        manufacturer: " ",
      }).proven,
    ).toBe(false);
  });

  it("does not read the retailer skus field for an MPN", () => {
    expect(
      proveStructuredIdentifier(mpn("FW-TEE-BLK-M"), page(), hosts, maker)
        .proven,
    ).toBe(false);
  });

  it("refuses a ProductGroup page: a family MPN does not name the selected variant", () => {
    expect(
      proveStructuredIdentifier(
        mpn("TEE-100"),
        page({
          structuredProducts: { products: [node()], variantGroup: true },
        }),
        hosts,
        maker,
      ).proven,
    ).toBe(false);
  });

  it("refuses an MPN served from an off-vendor host", () => {
    expect(
      proveStructuredIdentifier(
        mpn("TEE-100"),
        page({ sourceURL: "https://evil.example.test/p/tee" }),
        hosts,
        maker,
      ).proven,
    ).toBe(false);
  });
});

describe("structuredPageProvesExactVariant", () => {
  it("accepts the page when any candidate identifier is proven", () => {
    expect(
      structuredPageProvesExactVariant(
        [sku("NOPE"), sku("FW-TEE-BLK-M")],
        page(),
        hosts,
      ),
    ).toBe(true);
  });

  it("counts a manufacturer part only with the Product's manufacturer", () => {
    const part = {
      source: "forgewear-apparel",
      kind: "manufacturer_part",
      externalId: "TEE-100",
    };
    expect(structuredPageProvesExactVariant([part], page(), hosts)).toBe(false);
    expect(
      structuredPageProvesExactVariant([part], page(), hosts, {
        manufacturer: "ForgeWear Apparel",
      }),
    ).toBe(true);
  });

  it("rejects the page when no identifier on the Product is proven", () => {
    expect(structuredPageProvesExactVariant([], page(), hosts)).toBe(false);
    expect(structuredPageProvesExactVariant([sku("NOPE")], page(), hosts)).toBe(
      false,
    );
  });
});
