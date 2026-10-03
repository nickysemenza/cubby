import { describe, expect, it } from "vitest";

import { matchReadCoverage } from "./product-match-ranking";

describe("product match read coverage", () => {
  it("counts photo products that got no candidate, split by whether they were seeded", () => {
    expect(
      matchReadCoverage({
        photoIds: ["p1", "p2", "p3", "p4"],
        purchaseCount: 7,
        seeds: ["p1", "p2"],
        semanticUsed: true,
        pairs: [
          { photoId: "p1", purchaseId: "b1", source: "token" },
          { photoId: "p1", purchaseId: "b2", source: "semantic" },
          { photoId: "p3", purchaseId: "b3", source: "token" },
        ],
        returned: 2,
        queueLimit: 100,
      }),
    ).toEqual({
      photoProducts: 4,
      purchaseProducts: 7,
      vectorLookups: 2,
      unseededPhotoProducts: 2,
      tokenPairs: 2,
      semanticPairs: 1,
      photosWithoutCandidate: 2,
      unseededPhotosWithoutCandidate: 1,
      returned: 2,
      truncated: false,
    });
  });

  it("reports no vector lookups when semantic ranking was unavailable", () => {
    expect(
      matchReadCoverage({
        photoIds: ["p1"],
        purchaseCount: 1,
        seeds: ["p1"],
        semanticUsed: false,
        pairs: [],
        returned: 100,
        queueLimit: 100,
      }),
    ).toMatchObject({ vectorLookups: 0, truncated: true });
  });
});
