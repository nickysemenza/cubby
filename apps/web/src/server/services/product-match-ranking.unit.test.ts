import { describe, expect, it } from "vitest";

import {
  describeSignals,
  pairByModel,
  rankMatches,
  sharesModel,
  type MatchSignals,
} from "./product-match-ranking";

const signals = (
  patch: Partial<MatchSignals<string>>,
): MatchSignals<string> => ({
  photoId: "photo",
  purchaseId: "p1",
  sharedTokens: [],
  overlap: 0,
  similarity: null,
  sameCategory: null,
  sameOwner: null,
  sameModel: false,
  ...patch,
});

const forge = (id: string, manufacturer = "ForgeWear", model = "TEE-100") => ({
  id,
  name: "Crew Tee",
  rootCategoryId: null,
  manufacturer,
  model,
});

describe("sharesModel", () => {
  it("needs the same manufacturer and the same digit-bearing model", () => {
    const a = { manufacturer: "ForgeWear", model: "TEE-100" };
    expect(
      sharesModel(a, { manufacturer: " forgewear ", model: "tee100" }),
    ).toBe(true);
    expect(sharesModel(a, { manufacturer: "AnvilCo", model: "TEE-100" })).toBe(
      false,
    );
    expect(
      sharesModel(a, { manufacturer: "ForgeWear", model: "TEE-200" }),
    ).toBe(false);
  });

  it("never matches blank, short, or digit-free models, or blank manufacturers", () => {
    for (const model of [null, "", "T1", "Crew"])
      expect(
        sharesModel(
          { manufacturer: "ForgeWear", model },
          { manufacturer: "ForgeWear", model },
        ),
      ).toBe(false);
    expect(
      sharesModel(
        { manufacturer: "", model: "TEE-100" },
        { manufacturer: "", model: "TEE-100" },
      ),
    ).toBe(false);
  });
});

describe("pairByModel", () => {
  it("pairs photo and purchase Products sharing a manufacturer model", () => {
    expect(
      pairByModel([forge("a")], [forge("b"), forge("c", "AnvilCo")]),
    ).toEqual([{ photoId: "a", purchaseId: "b" }]);
  });
});

describe("sameModel ranking signal", () => {
  it("raises a pair above an otherwise equal one", () => {
    const ranked = rankMatches(
      [
        signals({ purchaseId: "a-plain", overlap: 0.5 }),
        signals({ purchaseId: "z-model", overlap: 0.5, sameModel: true }),
      ],
      2,
    );
    expect(ranked.map((item) => item.purchaseId)).toEqual([
      "z-model",
      "a-plain",
    ]);
  });

  it("does not outrank a much stronger semantic match", () => {
    const ranked = rankMatches(
      [
        signals({ purchaseId: "model", sameModel: true }),
        signals({ purchaseId: "semantic", similarity: 0.9 }),
      ],
      2,
    );
    expect(ranked[0]?.purchaseId).toBe("semantic");
  });

  it("explains the evidence and asks for size and color confirmation", () => {
    expect(describeSignals(signals({ sameModel: true }))).toContain(
      "Shared model/style number; confirm size and color",
    );
    expect(describeSignals(signals({}))).toEqual([]);
  });
});
