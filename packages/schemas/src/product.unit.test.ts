import { describe, expect, it } from "vitest";
import { productMcpOut } from "./product";

describe("productMcpOut", () => {
  it("carries product-enrichment identity and image summary fields", () => {
    const parsed = productMcpOut.parse({
      id: "PRD-ABCD",
      name: "M18 framing nailer",
      manufacturer: "Milwaukee",
      model: "2744-20",
      notes: "Bare tool",
      upc: "045242593057",
      category: "tools",
      tags: ["M18"],
      price: 329,
      priceOverride: 329,
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
      imageCount: 2,
      coverImageUrl: "https://images.example.test/2744-20.webp",
      price: 329,
      priceOverride: 329,
      pricing: { source: "explicit", effectivePrice: 329 },
    });
  });
});
