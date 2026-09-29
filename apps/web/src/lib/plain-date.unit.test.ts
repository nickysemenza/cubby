import { describe, expect, it } from "vitest";

import { shiftPlainDate } from "./plain-date";

describe("shiftPlainDate", () => {
  it("carries across month, year, and leap-day boundaries in both directions", () => {
    expect(shiftPlainDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftPlainDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftPlainDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftPlainDate("2026-03-08", 7)).toBe("2026-03-15");
    expect(shiftPlainDate("2026-09-07", 0)).toBe("2026-09-07");
  });

  it("throws instead of returning a garbled date", () => {
    expect(() => shiftPlainDate("2026", 1)).toThrow(RangeError);
    expect(() => shiftPlainDate("not-a-date", 1)).toThrow(RangeError);
  });
});
