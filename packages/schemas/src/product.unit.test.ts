import { describe, expect, it } from "vitest";
import {
  productFindOrCreateByCodeInput,
  productMcpOut,
  productQuantitySummaryBatchInput,
} from "./product";
import { scanAtLocationCode } from "./scan";

describe("productMcpOut", () => {
  it("carries product-enrichment identity and image summary fields", () => {
    const parsed = productMcpOut.parse({
      id: "PRD-ABCD",
      name: "M18 framing nailer",
      manufacturer: "Milwaukee",
      model: "2744-20",
      notes: "Bare tool",
      primaryGtin: "00045242593057",
      category: {
        id: "CAT-TEST",
        name: "Tools",
        path: [{ id: "CAT-TEST", name: "Tools" }],
        feature: "tools",
      },
      categoryId: "CAT-TEST",
      classificationEvidence: "",
      itemImageCount: 2,
      labelImageCount: 0,
      tags: ["M18"],
      price: 329,
      effectivePrice: 329,
      pricing: {
        derivedPrice: 300,
        effectivePrice: 329,
        source: "explicit",
        knownExpenseCount: 1,
        unknownExpenseCount: 0,
        knownUnitCount: 1,
        partial: false,
      },
      expectedQuantity: 1,
      imageCount: 2,
      coverImageUrl: "https://images.example.test/2744-20.webp",
      fdc_id: null,
      usdaUnavailable: null,
      labelNutrition: null,
      stockTracked: null,
      externalIds: [],
      usdaFdcId: null,
      ingredientId: null,
      unitMappings: [],
      dataQuality: {
        status: "complete",
        facets: [],
        gaps: [],
        exceptions: [],
        relatedGaps: [],
        relatedExceptions: [],
      },
    });

    expect(parsed).toMatchObject({
      model: "2744-20",
      notes: "Bare tool",
      primaryGtin: "00045242593057",
      imageCount: 2,
      coverImageUrl: "https://images.example.test/2744-20.webp",
      price: 329,
      effectivePrice: 329,
      pricing: { source: "explicit", effectivePrice: 329 },
    });
  });
});

describe("productQuantitySummaryBatchInput", () => {
  it("accepts a whole-house recount batch larger than the old page-sized cap", () => {
    expect(
      productQuantitySummaryBatchInput.safeParse({
        ids: Array.from({ length: 501 }, () => "PRD-ABCD"),
      }).success,
    ).toBe(true);
  });
});

describe("productFindOrCreateByCodeInput", () => {
  it.each([
    [{ kind: "barcode", value: "012345678905" }, "012345678905"],
    // Only trims: check-digit validation + GTIN-14 normalization happen in
    // `product.findOrCreateByCode`'s "isbn" arm (schemas cannot depend on
    // the WASM boundary that validation needs).
    [{ kind: "isbn", value: "  978-0-306-40615-7  " }, "978-0-306-40615-7"],
    // The raw arm only trims: the server classifies it into one of the others.
    [{ kind: "scan", value: "  P-4K7M " }, "P-4K7M"],
  ])("accepts the %o arm", (input, value) => {
    expect(productFindOrCreateByCodeInput.parse(input)).toEqual({
      kind: input.kind,
      value,
    });
  });

  it("rejects an empty scan", () => {
    expect(
      productFindOrCreateByCodeInput.safeParse({ kind: "scan", value: "  " })
        .success,
    ).toBe(false);
  });

  it("reaches the sweep input as the same arm", () => {
    expect(
      scanAtLocationCode.parse({ kind: "scan", value: "PRD-4K7M" }),
    ).toEqual({ kind: "scan", value: "PRD-4K7M" });
    expect(
      scanAtLocationCode.parse({ kind: "product", value: "PRD-4K7M" }),
    ).toEqual({ kind: "product", value: "PRD-4K7M" });
  });
});
