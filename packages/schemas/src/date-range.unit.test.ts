import { describe, expect, it } from "vitest";
import {
  dateRangeFromDates,
  dateRangeSchema,
  storedDateRangeSchema,
} from "./date-range";

// This boundary is shared by HTTP, MCP and both editors; a bad range can otherwise
// clear a schedule or shift a calendar event before any UI validation runs.
describe("calendar date range contract", () => {
  it("accepts open bounds and leap days while rejecting malformed or reversed writes", () => {
    for (const value of [
      { start: "2028-02-29", end: null },
      { start: null, end: "2026-10-30" },
      { start: "2026-10-28", end: "2026-10-30" },
    ])
      expect(dateRangeSchema.parse(value)).toEqual(value);
    for (const value of [
      { start: null, end: null },
      { start: "2026-02-29", end: null },
      { start: "2026-10-28T00:00:00Z", end: null },
      { start: "2026-10-30", end: "2026-10-28" },
    ])
      expect(dateRangeSchema.safeParse(value).success).toBe(false);
  });

  it("preserves stored evidence for correction and normalizes only an empty pair", () => {
    const reversed = { start: "2026-10-30", end: "2026-10-28" };
    expect(
      storedDateRangeSchema.parse(
        dateRangeFromDates(reversed.start, reversed.end),
      ),
    ).toEqual(reversed);
    expect(dateRangeFromDates(null, null)).toBeNull();
  });
});
