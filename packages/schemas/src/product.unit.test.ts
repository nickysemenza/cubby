import { describe, expect, it } from "vitest";
import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
  productMcpOut,
  productQuantitySummaryBatchInput,
} from "./product";

describe("productMcpOut", () => {
  it("carries product-enrichment identity and image summary fields", () => {
    const parsed = productMcpOut.parse({
      id: "PRD-ABCD",
      name: "M18 framing nailer",
      manufacturer: "Milwaukee",
      model: "2744-20",
      notes: "Bare tool",
      // Canonical GTIN-14 — this is a READ projection, derived from the primary
      // `gtin` identifier row. The write input is the one that accepts any
      // encoding; see `mcpProductCreateInput` below.
      primaryGtin: "00045242593057",
      category: "tools",
      tags: ["M18"],
      // Raw manual override; `effectivePrice` is what it resolves to.
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

describe("mcpProductCreateInput", () => {
  // A kit parent or retailer composite has no barcode and no ingredient link.
  // Both fields were `.nullable()` without `.optional()`, so the KEY stayed
  // required and such a Product could not be created over MCP at all — a client
  // that renders these as plain string fields cannot send an explicit null.
  it("creates a product with no barcode and no ingredient link", () => {
    const parsed = mcpProductCreateInput.safeParse({
      name: "12 in. Miter Saw Combo Kit with Stand",
      manufacturer: "Bosch",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.upc ?? null).toBeNull();
    expect(parsed.data?.ingredientId ?? null).toBeNull();
  });

  it("still accepts an explicit null for both", () => {
    expect(
      mcpProductCreateInput.safeParse({
        name: "Bare tool",
        manufacturer: "Milwaukee",
        upc: null,
        ingredientId: null,
      }).success,
    ).toBe(true);
  });

  it("still rejects a malformed barcode rather than ignoring it", () => {
    expect(
      mcpProductCreateInput.safeParse({
        name: "Bare tool",
        manufacturer: "Milwaukee",
        upc: "12345",
      }).success,
    ).toBe(false);
  });

  // Create diverged from update, which had both fields optional all along.
  it("agrees with the update input that neither field is required", () => {
    for (const key of ["upc", "ingredientId"] as const) {
      expect(
        mcpProductCreateInput.shape[key].safeParse(undefined).success,
      ).toBe(true);
      expect(
        mcpProductUpdateInput.shape[key].safeParse(undefined).success,
      ).toBe(true);
    }
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
