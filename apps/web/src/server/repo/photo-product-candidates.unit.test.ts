import { parseEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { forgeWearEvidence } from "../../../tests/fixtures/product-identity-evidence";
import { rankPhotoProductCandidates } from "./photo-product-candidates";
import {
  compareProductTitles,
  extractVariantFacts,
} from "./product-variant-comparison";

describe("explicit variant evidence", () => {
  it("distinguishes numeric US boot sizes and reads wheat as an explicit color", () => {
    expect(
      compareProductTitles(
        "ForgeWear work boots — tan, size 7",
        "ForgeWear safety boots, wheat, 9.5 US",
      ),
    ).toEqual({
      color: { first: "Tan", second: "Wheat", relation: "different" },
      size: { first: "US 7", second: "US 9.5", relation: "different" },
    });
  });

  it("does not turn an unrelated model number into a clothing size", () => {
    expect(
      compareProductTitles("ForgeWear jacket model 7", "ForgeWear jacket 9"),
    ).toEqual({
      color: { first: null, second: null, relation: "unknown" },
      size: { first: null, second: null, relation: "unknown" },
    });
  });

  it("parses garment waist context without treating inseam or model numbers as size", () => {
    expect(extractVariantFacts("Denim jeans W30 L32").size).toEqual({
      value: "W 30",
      raw: "W30",
    });
    expect(extractVariantFacts("Denim jeans model 30").size).toBeNull();
  });

  it("keeps the source phrase beside a normalized variant fact", () => {
    expect(extractVariantFacts("Work boots — wheat, 9.5 US")).toMatchObject({
      color: { value: "Wheat", raw: "wheat" },
      size: { value: "US 9.5", raw: "9.5 US" },
    });
  });

  it("flags a different color and preserves an unknown size instead of guessing from loose fit", () => {
    expect(
      compareProductTitles(
        "ForgeWear loose fit pocket shirt, navy, size unconfirmed",
        "ForgeWear loose fit pocket shirt, black, Small",
      ),
    ).toEqual({
      color: { first: "Navy", second: "Black", relation: "different" },
      size: { first: null, second: "Small", relation: "unknown" },
    });
  });

  it("treats two possible photo colors as unknown evidence", () => {
    expect(
      compareProductTitles("Pocket tee, navy/charcoal", "Pocket tee, navy"),
    ).toEqual({
      color: { first: null, second: "Navy", relation: "unknown" },
      size: { first: null, second: null, relation: "unknown" },
    });
  });
});

describe("photo product candidate ranking", () => {
  it("uses label size evidence to rank a matching boot over a conflicting size", () => {
    const candidate = (name: string) => ({
      id: parseEntityId("product", crypto.randomUUID()),
      shortcode: name.endsWith("7") ? "PRD-4K7M" : "PRD-8B2Q",
      name,
      manufacturer: "ForgeWear",
      hasOwnPhoto: true,
      hasPhotoImport: true,
      hasPurchase: false,
      hasInventory: false,
    });
    const ranked = rankPhotoProductCandidates(
      "ForgeWear tan work boots",
      "ForgeWear",
      [
        candidate("ForgeWear tan work boots size 9"),
        candidate("ForgeWear tan work boots size 7"),
      ],
      ["US 7"],
    );
    expect(ranked.map((item) => item.shortcode)).toEqual([
      "PRD-4K7M",
      "PRD-8B2Q",
    ]);
    expect(ranked[1]?.variant.size.relation).toBe("different");
  });
  it("keeps the observed color and size ahead of another variant's photo gap", () => {
    const ranked = rankPhotoProductCandidates(
      forgeWearEvidence.observedName,
      forgeWearEvidence.brand,
      forgeWearEvidence.products.map((product) => ({
        id: parseEntityId("product", crypto.randomUUID()),
        ...product,
        manufacturer: forgeWearEvidence.brand,
      })),
    );
    expect(ranked[0]?.shortcode).toBe(
      forgeWearEvidence.expected.matchedProduct,
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
      manufacturer: "ForgeWear",
      hasOwnPhoto,
      hasPhotoImport,
      hasPurchase: true,
      hasInventory: false,
    });
    const ranked = rankPhotoProductCandidates(
      "ForgeWear loose fit pocket T-shirt, black small",
      "ForgeWear",
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
