import { describe, expect, it } from "vitest";
import { calendarRangeInput, calendarWindowInput } from "./calendar";

describe("calendarRangeInput", () => {
  it("accepts a range at the server-side limit", () => {
    expect(
      calendarRangeInput.safeParse({
        startDate: "2024-01-01",
        endDateExclusive: "2025-01-01",
      }).success,
    ).toBe(true);
  });

  it("rejects a range beyond the server-side limit", () => {
    const result = calendarRangeInput.safeParse({
      startDate: "2024-01-01",
      endDateExclusive: "2025-01-02",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: "calendar range cannot exceed 366 days",
        path: ["endDateExclusive"],
      }),
    );
  });
});

describe("calendar window HTTP projection", () => {
  it("keeps date refinements on the narrow and full inputs", () => {
    for (const schema of [calendarWindowInput, calendarRangeInput]) {
      expect(
        schema.safeParse({
          startDate: "2024-01-02",
          endDateExclusive: "2024-01-01",
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          startDate: "2024-01-01",
          endDateExclusive: "2025-01-02",
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          startDate: "2024-01-01",
          endDateExclusive: "2024-01-02",
          kinds: ["meal"],
        }).success,
      ).toBe(true);
    }
  });
  it("preserves web filters without expanding the native window", () => {
    const input = {
      startDate: "2024-01-01",
      endDateExclusive: "2024-01-02",
      kinds: ["meal"],
      filters: { meal: { searchQuery: "synthetic" } },
    };
    expect(calendarRangeInput.safeParse(input).success).toBe(true);
    expect(calendarWindowInput.safeParse(input).success).toBe(false);
  });
});
