import { describe, expect, it } from "vitest";

import {
  TOTALS_STALE_AFTER_MS,
  totalsLookStuck,
} from "./recipe-totals-staleness";

const NOW = 1_700_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo);

describe("totalsLookStuck", () => {
  it("is false when totals are already computed, regardless of age", () => {
    expect(
      totalsLookStuck(
        {
          totals: {
            cost: {
              status: "complete",
              lower: 5,
              upper: null,
              coverage: { covered: 1, total: 1 },
            },
          },
          updatedAt: at(TOTALS_STALE_AFTER_MS * 10),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a fresh recipe with null totals (drain plausibly pending)", () => {
    expect(
      totalsLookStuck(
        { totals: null, updatedAt: at(TOTALS_STALE_AFTER_MS - 1_000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps the recovery affordance for canonical pending estimates", () => {
    expect(
      totalsLookStuck(
        {
          totals: { cost: { status: "pending", reason: "totals_stale" } },
          updatedAt: at(TOTALS_STALE_AFTER_MS + 1_000),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("is true once a null-totals recipe is past the stale window", () => {
    expect(
      totalsLookStuck(
        { totals: null, updatedAt: at(TOTALS_STALE_AFTER_MS + 1_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("treats undefined totals like null", () => {
    expect(
      totalsLookStuck(
        { totals: undefined, updatedAt: at(TOTALS_STALE_AFTER_MS + 1_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false exactly at the boundary (strictly greater-than)", () => {
    expect(
      totalsLookStuck(
        { totals: null, updatedAt: at(TOTALS_STALE_AFTER_MS) },
        NOW,
      ),
    ).toBe(false);
  });
});
