import { describe, expect, it } from "vitest";
import { calendarRangeInput, MAX_CALENDAR_RANGE_DAYS } from "./calendar";

describe("calendarRangeInput", () => {
  it("accepts a range at the server-side limit", () => {
    expect(
      calendarRangeInput.safeParse({
        startDate: "2024-01-01",
        endDateExclusive: "2025-01-01",
      }).success,
    ).toBe(true);
    expect(MAX_CALENDAR_RANGE_DAYS).toBe(366);
  });

  it("rejects a range beyond the server-side limit", () => {
    const result = calendarRangeInput.safeParse({
      startDate: "2024-01-01",
      endDateExclusive: "2025-01-02",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      expect(result.error.issues).toContainEqual(
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
        expect.objectContaining({
          message: "calendar range cannot exceed 366 days",
          path: ["endDateExclusive"],
        }),
      );
    }
  });
});
