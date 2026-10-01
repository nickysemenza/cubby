import { describe, expect, it } from "vitest";

import { productOwnershipEvidence } from "./ownership-evidence";

describe("productOwnershipEvidence", () => {
  it("distinguishes proven exits from partial sales and quantity-less evidence", () => {
    const timeline = {
      acquiredAt: "2021-01-01",
      intervals: [{ start: "2021-01-01", end: "2022-01-01" }],
      confidenceLostAt: null,
    };
    expect(productOwnershipEvidence(timeline, 0).state).toBe("exited");
    expect(productOwnershipEvidence(timeline, 1).state).toBe("owned");
    expect(
      productOwnershipEvidence(
        { ...timeline, confidenceLostAt: "2022-01-01" },
        0,
      ).state,
    ).toBe("uncertain");
    expect(
      productOwnershipEvidence({ ...timeline, intervals: [] }, 0).state,
    ).toBe("uncertain");
  });
});
