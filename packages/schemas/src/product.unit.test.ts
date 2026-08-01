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
    });
  });
});
