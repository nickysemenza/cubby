import { parseEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { forgeWearEvidence } from "../../../tests/fixtures/product-identity-evidence";
import { rankPhotoProductCandidates } from "./photo-product-candidates";

describe("photo product candidate ranking", () => {
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
      ],
    );
    expect(ranked.map((item) => item.shortcode)).toEqual([
      "PRD-4K7M",
      "PRD-8B2Q",
      "PRD-9C3R",
    ]);
  });
});
