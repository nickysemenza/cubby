import { format, startOfYear, subDays, subMonths } from "date-fns";
import { describe, expect, it } from "vitest";

import {
  costRangeOptions,
  productQuantityRangeOptions,
  resolveCostFilter,
  resolveDateRange,
  resolveProductQuantityFilter,
} from "./expense-options";

describe("resolveCostFilter", () => {
  it("returns {} for an undefined or unrecognized preset", () => {
    expect(resolveCostFilter(undefined)).toEqual({});
    expect(resolveCostFilter("bogus")).toEqual({});
  });

  it("keeps the two presence sentinels resolving exactly as before", () => {
    // `?cost=has` / `?cost=none` bookmarks predate the amount buckets sharing
    // this control; they must still write `costPresenceFilter` and nothing else.
    expect(resolveCostFilter("has")).toEqual({ costPresenceFilter: "has" });
    expect(resolveCostFilter("none")).toEqual({ costPresenceFilter: "none" });
  });

  it("expands each amount bucket into the bound it owns, and no presence field", () => {
    expect(resolveCostFilter("gte500")).toEqual({ costMin: 500 });
    expect(resolveCostFilter("gte200")).toEqual({ costMin: 200 });
    expect(resolveCostFilter("gte100")).toEqual({ costMin: 100 });
  });

  it("resolves credits to costMax: 0, not a positive floor", () => {
    // Credits are real in this ledger (refunds and price adjustments), so the
    // credits bucket is an UPPER bound at zero. A `costMin` here would silently
    // invert the filter.
    expect(resolveCostFilter("credits")).toEqual({ costMax: 0 });
  });

  it("emits a numeric bound, not a string", () => {
    // The URL path goes through `z.coerce.number()`, but this preset path
    // bypasses the URL entirely — `expand` returns the patch directly.
    expect(typeof resolveCostFilter("gte500").costMin).toBe("number");
  });

  it("resolves every declared option, so no preset can render without a bound", () => {
    for (const option of costRangeOptions) {
      expect(resolveCostFilter(option.value)).not.toEqual({});
    }
  });
});

describe("resolveProductQuantityFilter", () => {
  it("keeps presence sentinels and unknown presets distinct from quantity bounds", () => {
    expect(resolveProductQuantityFilter("has")).toEqual({
      productQuantityPresenceFilter: "has",
    });
    expect(resolveProductQuantityFilter("none")).toEqual({
      productQuantityPresenceFilter: "none",
    });
    expect(resolveProductQuantityFilter(undefined)).toEqual({});
    expect(resolveProductQuantityFilter("bogus")).toEqual({});
  });

  it("expands each whole-unit preset into inclusive quantity bounds", () => {
    expect(resolveProductQuantityFilter("exactly1")).toEqual({
      productQuantityMin: 1,
      productQuantityMax: 1,
    });
    expect(resolveProductQuantityFilter("gte2")).toEqual({
      productQuantityMin: 2,
    });
    expect(resolveProductQuantityFilter("gte5")).toEqual({
      productQuantityMin: 5,
    });
  });

  it("resolves every declared option", () => {
    for (const option of productQuantityRangeOptions) {
      expect(resolveProductQuantityFilter(option.value)).not.toEqual({});
    }
  });
});

describe("resolveDateRange", () => {
  it("returns {} for an undefined preset", () => {
    expect(resolveDateRange(undefined)).toEqual({});
  });

  it("returns {} for an unrecognized preset", () => {
    expect(resolveDateRange("bogus")).toEqual({});
  });

  it("resolves 30d to a 30-day inclusive window ending today", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("30d");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subDays(today, 30), "yyyy-MM-dd"));
  });

  it("resolves 90d to a 90-day inclusive window ending today", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("90d");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subDays(today, 90), "yyyy-MM-dd"));
  });

  it("resolves ytd to the start of the current calendar year", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("ytd");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(startOfYear(today), "yyyy-MM-dd"));
  });

  it("resolves 1y to 12 months back", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("1y");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subMonths(today, 12), "yyyy-MM-dd"));
  });
});
