import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";
import { describe, expect, it } from "vitest";

import { forgeWearEvidence } from "#web/tests/fixtures/product-identity-evidence.ts";

import { rankPhotoProductCandidates } from "./photo-product-candidates";

const brandId = parseEntityId("vendor", "00000000-0000-4000-8000-000000000041");

const comparison = (
  color: "same" | "different" | "unknown",
  size: "same" | "different" | "unknown",
  firstTitle: string,
  secondTitle: string,
): ProductVariantComparison => ({
  color: { relation: color },
  size: { relation: size },
  evidence: { firstTitle, secondTitle },
});

describe("photo product candidate ranking", () => {
  it("uses label size evidence to rank a matching boot over a conflicting size", () => {
    const candidate = (name: string) => ({
      id: parseEntityId("product", crypto.randomUUID()),
      shortcode: name.endsWith("7") ? "PRD-4K7M" : "PRD-8B2Q",
      name,
      brandName: "ForgeWear",
      brandId,
      hasOwnPhoto: true,
      hasPhotoImport: true,
      hasPurchase: false,
      hasInventory: false,
    });
    const size9 = candidate("ForgeWear tan work boots size 9");
    const size7 = candidate("ForgeWear tan work boots size 7");
    const ranked = rankPhotoProductCandidates(
      { name: "ForgeWear tan work boots", brandName: "ForgeWear", brandId },
      [size9, size7],
      ["US 7"],
      new Map([
        [
          size9.id,
          comparison(
            "same",
            "different",
            "ForgeWear tan work boots\nUS 7",
            size9.name,
          ),
        ],
        [
          size7.id,
          comparison(
            "same",
            "same",
            "ForgeWear tan work boots\nUS 7",
            size7.name,
          ),
        ],
      ]),
    );
    expect(ranked.map((item) => item.shortcode)).toEqual([
      "PRD-4K7M",
      "PRD-8B2Q",
    ]);
    expect(ranked[1]?.variant.size.relation).toBe("different");
  });
  it("uses returned variant relations to rank the observed color and size", () => {
    const products = forgeWearEvidence.products.map((product) => ({
      id: parseEntityId("product", crypto.randomUUID()),
      ...product,
      brandName: forgeWearEvidence.brand,
      brandId,
    }));
    const comparisons = new Map(
      products.map((product) => [
        product.id,
        comparison(
          product.shortcode === forgeWearEvidence.expected.matchedProduct
            ? "same"
            : "different",
          product.shortcode === forgeWearEvidence.expected.matchedProduct
            ? "same"
            : "different",
          forgeWearEvidence.observedName,
          product.name,
        ),
      ]),
    );
    const ranked = rankPhotoProductCandidates(
      {
        name: forgeWearEvidence.observedName,
        brandName: forgeWearEvidence.brand,
        brandId,
      },
      products,
      [],
      comparisons,
    );
    expect(ranked[0]?.shortcode).toBe(
      forgeWearEvidence.expected.matchedProduct,
    );
  });

  it("does not penalize unknown relations and penalizes only explicit difference", () => {
    const candidate = (shortcode: string, name: string) => ({
      id: parseEntityId("product", crypto.randomUUID()),
      shortcode,
      name,
      brandName: "ForgeWear",
      brandId,
      hasOwnPhoto: true,
      hasPhotoImport: true,
      hasPurchase: false,
      hasInventory: false,
    });
    const unknown = candidate("PRD-4K7M", "ForgeWear tan work boots size 9");
    const different = candidate("PRD-8B2Q", "ForgeWear tan work boots size 7");
    const ranked = rankPhotoProductCandidates(
      {
        name: "ForgeWear tan work boots size 7",
        brandName: "ForgeWear",
        brandId,
      },
      [unknown, different],
      [],
      new Map([
        [
          unknown.id,
          comparison("unknown", "unknown", "proposal", unknown.name),
        ],
        [
          different.id,
          comparison("same", "different", "proposal", different.name),
        ],
      ]),
    );
    expect(ranked.map((item) => item.shortcode)).toEqual([
      "PRD-4K7M",
      "PRD-8B2Q",
    ]);
    expect(ranked[0]?.factors).not.toContainEqual(
      expect.objectContaining({ label: "Explicit variant conflict" }),
    );
  });

  it("finds a compact vendor title and favors the purchase variant without an own photo", () => {
    const candidate = (
      shortcode: string,
      name: string,
      hasOwnPhoto: boolean,
      hasPhotoImport: boolean,
    ) => ({
      id: parseEntityId("product", crypto.randomUUID()),
      shortcode,
      name,
      brandName: "ForgeWear",
      brandId,
      hasOwnPhoto,
      hasPhotoImport,
      hasPurchase: true,
      hasInventory: false,
    });
    const ranked = rankPhotoProductCandidates(
      {
        name: "ForgeWear loose fit pocket T-shirt, black small",
        brandName: "ForgeWear",
        brandId,
      },
      [
        candidate(
          "PRD-4K7M",
          "ForgeWearMenLooseFitPocketT-ShirtBlackSmall",
          false,
          false,
        ),
        candidate(
          "PRD-8B2Q",
          "ForgeWear loose fit pocket T-shirt black small",
          true,
          true,
        ),
        candidate(
          "PRD-9C3R",
          "ForgeWear loose fit pocket T-shirt navy small",
          false,
          false,
        ),
        candidate("PRD-7A2F", "ForgeWear socks", false, false),
      ],
    );
    expect(ranked.map((item) => item.shortcode)).toEqual([
      "PRD-4K7M",
      "PRD-8B2Q",
      "PRD-9C3R",
    ]);
  });
});
